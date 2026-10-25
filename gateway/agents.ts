/**
 * Жизненный цикл агентов: старт, продолжение сессии, остановка.
 *
 * Агент живёт в панели рантайма (`gateway/runtime/`): панель — это PTY с
 * интерактивным bash, внутрь которого печатается команда запуска omp. Поэтому
 * выход агента не убивает панель, а перезапуск шлюза не убивает агентов.
 *
 * Реестр collab остаётся источником правды о сессии (sessionId, файл сессии,
 * модель, состояние турна), а привязка «панель ↔ хост» теперь точная: панель
 * помнит `instanceId`, а если привязки нет — хост ищется по pid в дереве
 * процессов панели (`paneOfHost`).
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { listHosts, type OmpHost } from "./hosts.ts";
import { resolveBin } from "./bins.ts";
import { bindPane, closePane, createPane, listPanes, panePids, runInPane } from "./panes.ts";
import { withStateFileLock } from "./recovery/migrate.ts";

/**
 * Инстансы, запущенные через эндпоинты этого шлюза. Гейт для /api/agents/stop:
 * реестр collab машинально общий, поэтому иначе любой шлюз (или зацикленная
 * автоматика против него) мог бы гасить агентов, запущенных в другом месте.
 * Файл переживает рестарт шлюза; чужие id требуют явного force.
 */
const STARTED_FILE = join(new URL(".", import.meta.url).pathname, "started-instances.json");

function loadStarted(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STARTED_FILE, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function persistStarted(ids: Set<string>, strict = false): void {
  const tmp = `${STARTED_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify([...ids], null, "\t"));
    if (strict) {
      const fd = openSync(tmp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    renameSync(tmp, STARTED_FILE);
    if (strict && process.platform !== "win32") {
      const fd = openSync(dirname(STARTED_FILE), "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  } catch (error) {
    if (strict) throw error;
    // best-effort bookkeeping; stop still reachable via explicit force
  }
}

/** Взять инстанс под учёт шлюза: агент, поднятый в нашей панели после рестарта
 * рантайма, тоже наш — иначе «Остановить» в приложении отвечало бы 409. */
export function adoptStartedInstance(instanceId: string, strict = false): void {
  recordStarted(instanceId, strict);
}

function recordStarted(instanceId: string, strict = false): void {
  try {
    withStateFileLock(STARTED_FILE, () => {
      const merged = loadStarted();
      merged.add(instanceId);
      persistStarted(merged, strict);
    });
  } catch (error) { if (strict) throw error; }
}

/** Остановленный инстанс снимается с учёта: файл не должен расти мёртвыми id,
 * иначе «свои» строки реестра копятся годами. */
function forgetStarted(instanceId: string): void {
  try {
    withStateFileLock(STARTED_FILE, () => {
      const merged = loadStarted();
      if (!merged.delete(instanceId)) return;
      persistStarted(merged);
    });
  } catch { /* best-effort, as with persistStarted */ }
}

const REGISTER_TIMEOUT_MS = 45_000;
const REGISTER_POLL_MS = 1_000;
const STOP_POLL_MS = 500;
/** Размер панели по умолчанию: TUI omp рисуется в этот экран. */
const PANE_COLS = 120;
const PANE_ROWS = 34;

export type StartOutcome =
  | { kind: "started"; instanceId: string; note: string }
  | { kind: "bad_cwd"; error: string }
  | { kind: "failed"; error: string };

// Очередь запусков: каждый старт должен приписать себе ровно один новый хост.
let startQueue: Promise<unknown> = Promise.resolve();

async function waitForNewHost(
  paneId: string,
  cwd: string,
  knownIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<{ host: OmpHost | null; panePids: number[]; lastPollError: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastPollError: string | null = null;
  let pids: number[] = [];
  for (;;) {
    try {
      pids = await panePids(paneId);
      const fresh = (await listHosts()).hosts.find(
        (host) => !knownIds.has(host.instanceId) && host.cwd === cwd && pids.includes(host.pid),
      );
      if (fresh !== undefined) return { host: fresh, panePids: pids, lastPollError: null };
    } catch (err) {
      // реестр или рантайм могли быть недоступны — запоминаем причину для отчёта
      lastPollError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) return { host: null, panePids: pids, lastPollError };
    await Bun.sleep(REGISTER_POLL_MS);
  }
}

async function waitHostGone(instanceId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let gone: boolean;
    try {
      gone = !(await listHosts()).hosts.some((host) => host.instanceId === instanceId);
    } catch {
      gone = false;
    }
    if (gone) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(STOP_POLL_MS);
  }
}

async function launchAgentOnce(
  cwd: string,
  model: string | undefined,
  label: string | undefined,
  ompArgs: readonly string[],
  sessionFile: string | null,
): Promise<StartOutcome> {
  let cwdOk = false;
  try {
    cwdOk = statSync(cwd).isDirectory();
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) return { kind: "bad_cwd", error: `cwd does not exist: ${cwd}` };

  let ompBin: string;
  try {
    ompBin = await resolveBin("omp");
  } catch (err) {
    return { kind: "failed", error: `omp недоступен: ${err instanceof Error ? err.message : String(err)}` };
  }

  const displayLabel = label?.trim() || basename(cwd);
  const before = await listHosts();
  const knownIds = new Set(before.hosts.map((host) => host.instanceId));

  let paneId: string;
  try {
    const pane = await createPane(cwd, { name: displayLabel.slice(0, 64), cols: PANE_COLS, rows: PANE_ROWS });
    paneId = pane.paneId;
  } catch (err) {
    return { kind: "failed", error: `панель не создана: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Рабочий каталог задаём явно: omp сам уходит во временный каталог при старте
  // в ~, и хост зарегистрировался бы не в том cwd.
  const argv = [ompBin, "--cwd", cwd, "--allow-home", ...(model === undefined ? [] : ["--model", model]), ...ompArgs];
  let alreadyRunning = false;
  try {
    alreadyRunning = (await runInPane(paneId, argv, { sessionFile })).alreadyRunning;
  } catch (err) {
    await closePane(paneId).catch(() => undefined);
    return { kind: "failed", error: `агент не запустился: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (alreadyRunning) {
    // Сессию уже держит другая панель (гонка восстановления): вторую копию на
    // тот же файл сессии не поднимаем — иначе два агента пишут в один журнал.
    const owner = (await listHosts()).hosts.find((item) => item.sessionFile === sessionFile && item.alive);
    await closePane(paneId).catch(() => undefined);
    if (owner === undefined) return { kind: "failed", error: "сессия уже поднята в другой панели, но хост не найден" };
    recordStarted(owner.instanceId);
    return { kind: "started", instanceId: owner.instanceId, note: `agent ${displayLabel} already running in ${cwd}` };
  }

  const { host, panePids: pids, lastPollError } = await waitForNewHost(paneId, cwd, knownIds, REGISTER_TIMEOUT_MS);
  if (host === null) {
    const error = lastPollError !== null ? `реестр недоступен: ${lastPollError}` : "агент не зарегистрировался за 45 с";
    // Процесс мог остаться живым, но не зарегистрироваться: закрывать панель
    // нельзя, иначе пользователь потеряет живой агент.
    if (pids.length > 1) {
      return { kind: "failed", error: `агент запущен, но не зарегистрировался в collab — проверьте список агентов (${error})` };
    }
    await closePane(paneId).catch(() => undefined);
    return { kind: "failed", error: `агент не запустился — панель закрыта (${error})` };
  }

  await bindPane(paneId, {
    instanceId: host.instanceId,
    sessionId: host.sessionId,
    sessionFile: host.sessionFile ?? sessionFile,
    status: host.busy ? "working" : host.inputRequired ? "blocked" : "idle",
    model: model ?? `${host.model.provider}/${host.model.id}`,
    awaitingApproval: host.inputRequired,
  });
  recordStarted(host.instanceId);
  return { kind: "started", instanceId: host.instanceId, note: `agent ${displayLabel} started in ${cwd}` };
}

function enqueueLaunch(run: () => Promise<StartOutcome>): Promise<StartOutcome> {
  const result = startQueue.then(run, run);
  startQueue = result.catch(() => undefined);
  return result;
}

/** Устав стола агенту передавать не нужно: `AGENTS.md` в папке стола omp
 * подхватывает как правила проекта сам. */
export function startAgent(cwd: string, model: string | undefined, label: string | undefined): Promise<StartOutcome> {
  return enqueueLaunch(() => launchAgentOnce(cwd, model, label, [], null));
}

export type ResumeMode = "resume" | "restore";

/** Продолжить сохранённую сессию в новой панели. `restore` идёт через
 * `omp --restore`: доигрывает прерванный турн и поднимает субагентов, которых
 * потерял упавший процесс — путь восстановления после сбоя питания. */
export function resumeAgent(
  cwd: string,
  sessionPath: string,
  model: string | undefined,
  label: string | undefined,
  mode: ResumeMode = "resume",
): Promise<StartOutcome> {
  let exists = false;
  try {
    exists = statSync(sessionPath).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return Promise.resolve({ kind: "bad_cwd", error: `session file not found: ${sessionPath}` });
  const fallbackLabel = `resume-${basename(sessionPath).replace(/\.jsonl$/, "").slice(-18)}`;
  const ompFlag = mode === "restore" ? "--restore" : "--resume";
  return enqueueLaunch(() => launchAgentOnce(cwd, model, label ?? fallbackLabel, [ompFlag, sessionPath], sessionPath));
}

export async function stopAgent(instanceId: string, opts: { force?: boolean } = {}): Promise<{ found: boolean; killed: boolean; scoped: boolean }> {
  if (!opts.force && !loadStarted().has(instanceId)) {
    return { found: false, killed: false, scoped: true };
  }
  const host = (await listHosts()).hosts.find((item) => item.instanceId === instanceId);
  if (host === undefined) {
    forgetStarted(instanceId);
    return { found: false, killed: false, scoped: false };
  }
  // Мёртвая запись реестра: pid мог быть переиспользован ОС — сигналом можно
  // убить чужой процесс. Для мёртвой записи остановка уже состоялась.
  if (!host.alive) {
    forgetStarted(instanceId);
    await detachPane(instanceId).catch(() => undefined);
    return { found: true, killed: true, scoped: false };
  }

  const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(host.pid, sig);
    } catch {
      // процесс уже завершился; решение принимает проверка реестра
    }
  };

  signal("SIGTERM");
  if (await waitHostGone(instanceId, 5_000)) {
    forgetStarted(instanceId);
    await detachPane(instanceId).catch(() => undefined);
    return { found: true, killed: true, scoped: false };
  }
  signal("SIGKILL");
  if (await waitHostGone(instanceId, 5_000)) {
    forgetStarted(instanceId);
    await detachPane(instanceId).catch(() => undefined);
    return { found: true, killed: true, scoped: false };
  }
  return { found: true, killed: false, scoped: false };
}

/** Панель остаётся (в ней живая оболочка), но мёртвая сессия с неё снимается:
 * иначе панель продолжала бы считаться «панелью агента», которого уже нет. */
async function detachPane(instanceId: string): Promise<void> {
  const pane = (await listPanes()).find((candidate) => candidate.instanceId === instanceId);
  if (pane === undefined) return;
  await bindPane(pane.paneId, { instanceId: null, sessionId: null, sessionFile: null, awaitingApproval: false, status: "idle", launchArgv: [] });
}
