#!/usr/bin/env bun
// migrate-to-runtime — перенос живых агентов из прежних панелей в рантайм OMP Pocket.
//
//   bun bin/migrate-to-runtime.ts list
//   bun bin/migrate-to-runtime.ts run [--session <id>|--cwd <путь>] [--dry-run] [--force]
//
// Старый процесс находится по /proc и реестру collab (CLI прежнего менеджера панелей
// не используется), панель поднимается через gateway/panes.ts. Перенос идёт по одному:
// только свободный агент: резервная копия, пустая PTY, повторная проверка,
// SIGTERM и подтверждённое завершение, затем --resume точного транскрипта.
// Незавершённая миграция остаётся в частном журнале для безопасного повтора.
//
// Exit codes: 0 всё перенесено (или переносить нечего); 1 часть агентов не перенесена;
// 2 недоступны рантайм/реестр; 5 неверные аргументы.

import { resolve, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { adoptStartedInstance } from "../gateway/agents.ts";
import { recordInstanceRemap } from "../gateway/restore.ts";
import { assertIdle, assertPassiveIdle, assertCurrentTranscriptHeader, checkpointHistory, handover, idleMigrationArgv, migrationStore, publishMigration, resolveCurrentTranscript, verifyHistory, type MigrationRecord } from "../gateway/recovery/migrate.ts";
import { processInfo } from "../gateway/runtime/process.ts";
import { readEmptyViewSnapshot } from "../gateway/recovery/view-snapshot.ts";
import type { EmptySnapshot } from "../gateway/recovery/empty-session.ts";
import { listHosts, type OmpHost } from "../gateway/hosts.ts";
import { bindPane, closePane, createPane, getPane, listPanes, paneOfHost, panePids, paneProcesses, runInPane, type ManagedPane } from "../gateway/panes.ts";
import { classifySession, type TurnState } from "../gateway/recovery/classify.ts";
import { launchArgvOf } from "../gateway/recovery/checkpoint.ts";
import { findSessionFile } from "../gateway/sessions.ts";
import { defaultPaths } from "../gateway/update/paths.ts";
import { probeOmpProcesses, waitRuntimeReady, type OmpProcessProbe } from "../gateway/update/probes.ts";

const REGISTER_WAIT_MS = 60_000;
const TERM_WAIT_MS = 20_000;
const POLL_MS = 500;

interface RunOptions {
  session: string | null;
  cwd: string | null;
  dryRun: boolean;
  force: boolean;
  passive: boolean;
}

/** Живой агент и всё, что нужно для переноса: процесс из /proc, файл сессии,
 * состояние турна и панель рантайма (null — агент ещё вне рантайма). */
interface HostView {
  host: OmpHost;
  proc: OmpProcessProbe | null;
  sessionFile: string | null;
  launchArgv: string[];
  turn: TurnState | null;
  pane: ManagedPane | null;
}

class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function fail(message: string, code: number): never {
  throw new CliError(code, message);
}

function usage(): void {
  process.stdout.write(`migrate-to-runtime — перенос агентов в рантайм OMP Pocket

Usage:
  bun bin/migrate-to-runtime.ts list
      что переносится: sessionId, cwd, pid, файл сессии, состояние турна

  bun bin/migrate-to-runtime.ts run [--session <id>|--cwd <путь>] [--dry-run] [--force] [--passive]
      перенести выбранных агентов по одному
      --session <id>   только эта сессия
      --cwd <путь>     только агенты в этом каталоге
      --dry-run        показать план, ничего не запускать и не гасить
      --force          разрешить перенос всех сразу (без него нужен --session/--cwd)
      --passive        сохранить прерванный ход на паузе: --resume после свежей
                       проверки view, очереди, инструментов и дочерних процессов

  -h | --help          эта справка

Переносятся только свободные агенты: старый процесс завершается до запуска нового.
Занятые агенты, подтверждения и незавершённые операции откладываются.
`);
}

function isAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // процесс уже завершился — это и есть цель
  }
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(POLL_MS);
  }
  return !isAlive(pid);
}

/** Only graceful idle handover; a TERM timeout must never escalate to KILL. */
async function stopProcess(pid: number): Promise<boolean> {
  if (!isAlive(pid)) return true;
  sendSignal(pid, "SIGTERM");
  if (await waitDead(pid, TERM_WAIT_MS)) return true;
  return false;
}

/** Все живые collab-хосты с их процессом и панелью рантайма. Реестр и /proc
 * читаются один раз: обход по одному только для привязки панелей. */
async function discover(ompBin: string, hints?: Pick<RunOptions, "session" | "cwd">): Promise<HostView[]> {
  const output = await listHosts(ompBin).catch((err: unknown) => fail(`реестр collab недоступен: ${err instanceof Error ? err.message : String(err)}`, 2));
  const wantCwd = hints?.cwd == null ? null : resolve(hints.cwd);
  const hosts = output.hosts.filter((host) => host.alive && (hints?.session == null || host.sessionId === hints.session) && (wantCwd === null || resolve(host.cwd) === wantCwd));
  const procByPid = new Map<number, OmpProcessProbe>();
  for (const proc of probeOmpProcesses()) procByPid.set(proc.pid, proc);
  const views: HostView[] = [];
  // Панелей единицы, хостов десятки: панель ищем для каждого хоста точно
  // (instanceId или pid в дереве процессов), а не угадываем по cwd.
  for (const host of hosts) {
    const proc = procByPid.get(host.pid) ?? null;
    const sessionFile = resolveCurrentTranscript(host, [host.sessionFile, findSessionFile(host.sessionId), proc?.sessionFile])?.path ?? null;
    const pane = await paneOfHost(host).catch((err: unknown) => fail(`рантайм панелей недоступен: ${err instanceof Error ? err.message : String(err)}`, 2));
    views.push({
      host,
      proc,
      sessionFile,
      launchArgv: proc === null ? [] : launchArgvOf(proc.argv),
      turn: sessionFile === null ? null : classifySession(sessionFile),
      pane,
    });
  }
  return views;
}

function turnLabel(turn: TurnState | null): string {
  if (turn === null) return "нет транскрипта";
  const pending = turn.pendingAtExit.length + turn.unresolved.length;
  const suffix = pending > 0 ? `, в полёте: ${pending}` : "";
  return `${turn.status}${suffix}${turn.needsContinuation ? ", нужно продолжение" : ""}`;
}

function printList(views: readonly HostView[], ompBin: string): void {
  const pending = views.filter((view) => view.pane === null);
  if (pending.length === 0) {
    process.stdout.write("Все живые агенты уже в панелях рантайма — переносить нечего.\n");
    return;
  }
  process.stdout.write(`Вне панелей рантайма живых агентов: ${pending.length}\n`);
  process.stdout.write("sessionId\tcwd\tpid\tфайл сессии\tсостояние турна\targv\n");
  for (const view of pending) {
    const { host, proc } = view;
    process.stdout.write(
      [
        host.sessionId,
        host.cwd,
        String(host.pid),
        view.sessionFile ?? "—",
        turnLabel(view.turn),
        proc === null ? "процесс не найден в /proc" : (() => {
          try { return JSON.stringify(migrationArgv(view, ompBin)); }
          catch (error) { return `blocked: ${error instanceof Error ? error.message : String(error)}`; }
        })(),
      ].join("\t") + "\n",
    );
  }
  process.stdout.write(`\nперенос одного: bun bin/migrate-to-runtime.ts run --session <id>\n`);
  process.stdout.write(`перенос по каталогу: bun bin/migrate-to-runtime.ts run --cwd <путь>\n`);
}

function parseRunOptions(argv: readonly string[]): RunOptions {
  let session: string | null = null;
  let cwd: string | null = null;
  let dryRun = false;
  let force = false;
  let passive = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--passive") {
      passive = true;
      continue;
    }
    if (arg === "--session" || arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) fail(`${arg} требует значение`, 5);
      i += 1;
      if (arg === "--session") session = value;
      else cwd = value;
      continue;
    }
    fail(`неизвестный аргумент: ${arg ?? ""}`, 5);
  }
  if (session === null && cwd === null && !force) {
    fail("укажите --session или --cwd; перенос всех агентов сразу — только с --force", 5);
  }
  return { session, cwd, dryRun, force, passive };
}

function selectedByHint(views: readonly HostView[], options: RunOptions): HostView[] {
  const wantCwd = options.cwd === null ? null : resolve(options.cwd);
  return views.filter((view) => {
    if (options.session !== null && view.host.sessionId !== options.session) return false;
    if (wantCwd !== null && resolve(view.host.cwd) !== wantCwd) return false;
    return true;
  });
}

/** argv переноса: опции живого процесса из /proc, свежий селектор сессии и
 * текущий бинарь в качестве fallback, если /proc недоступен. */
function migrationArgv(view: HostView, ompBin: string): string[] {
  if (view.sessionFile === null) throw new Error("missing transcript: migration blocked; never use --continue");
  if (view.launchArgv.length === 0) throw new Error("exact launch argv unavailable");
  return idleMigrationArgv(view.launchArgv, ompBin, `${view.host.model.provider}/${view.host.model.id}`, view.sessionFile, view.host.cwd);
}

/** Новый агент обязан зарегистрироваться под тем же sessionId И оказаться
 * процессом новой панели: старая запись реестра ещё жива до гашения, поэтому
 * одного sessionId недостаточно. */
async function waitRegistration(paneId: string, host: OmpHost, ompBin: string, sessionFile: string | null): Promise<OmpHost> {
  const deadline = Date.now() + REGISTER_WAIT_MS;
  for (;;) {
    const pids = await panePids(paneId).catch(() => [] as number[]);
    let hosts: OmpHost[] | null = null;
    try {
      hosts = (await listHosts(ompBin)).hosts;
    } catch {
      // реестр моргнул — это не повод трогать старый процесс, пробуем ещё
    }
    if (hosts !== null) {
      const fresh = hosts.find(
        (item) =>
          item.alive &&
          item.sessionId === host.sessionId &&
          item.pid !== host.pid &&
          item.cwd === host.cwd &&
          pids.includes(item.pid) &&
          item.sessionFile === sessionFile,
      );
      if (fresh !== undefined) return fresh;
    }
    if (Date.now() >= deadline) {
      fail(`агент ${host.sessionId} не зарегистрировался в новой панели за ${Math.round(REGISTER_WAIT_MS / 1000)} с — сверка журнала миграции обязательна; повторный запуск использует ту же панель`, 1);
    }
    await Bun.sleep(POLL_MS);
  }
}

const LEDGER_ROOT = join(homedir(), ".omp", "pocket-migrations");
const store = () => migrationStore(LEDGER_ROOT);

async function verifyPassiveHost(host: OmpHost, sessionFile: string, ompBin: string, startTime: string | null): Promise<OmpHost> {
  let header: Record<string, unknown> | null = null;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.type === "session") { header = entry; break; }
  }
  if (header === null) throw new Error("passive handover requires the exact native session header");
  // The existing reader uses identity/meta.pid only; the returned header/state
  // come from a newly authenticated read-only client, never this seed.
  const expected: EmptySnapshot = { instanceId: host.instanceId, sessionId: host.sessionId, cwd: host.cwd, header, entries: [], state: {}, meta: { readOnly: true, capturedAt: new Date().toISOString(), pid: host.pid, activeTools: 0, working: false } };
  const snapshot = await readEmptyViewSnapshot(expected);
  assertCurrentTranscriptHeader(header, snapshot);
  const hosts = (await listHosts(ompBin)).hosts;
  const fresh = hosts.find(item => item.instanceId === host.instanceId);
  if (fresh === undefined || fresh.pid !== host.pid || fresh.generation !== host.generation || fresh.startedAt !== host.startedAt || fresh.sessionId !== host.sessionId || fresh.cwd !== host.cwd || hosts.filter(item => item.alive && item.sessionId === host.sessionId).length !== 1) throw new Error("passive host identity changed or duplicate session owner exists");
  assertPassiveIdle(fresh, classifySession(sessionFile), snapshot, processInfo(host.pid, startTime ?? undefined).foreground_processes);
  const currentProc = probeOmpProcesses(host.pid)[0] ?? null;
  if (currentProc === null || (startTime !== null && currentProc.startTime !== startTime) || resolveCurrentTranscript(fresh, [fresh.sessionFile, findSessionFile(fresh.sessionId), currentProc.sessionFile])?.path !== sessionFile) throw new Error("current session transcript changed during authenticated view");
  const checkedHeader = resolveCurrentTranscript(fresh, [sessionFile])?.header;
  if (checkedHeader === undefined) throw new Error("current session header changed during authenticated view");
  assertCurrentTranscriptHeader(checkedHeader, snapshot);
  return fresh;
}

function startupSelectionChanged(view: HostView): boolean {
  if (view.proc?.sessionFile !== null && view.proc?.sessionFile !== undefined && view.proc.sessionFile !== view.sessionFile) return true;
  for (let i = 1; i < view.launchArgv.length; i++) {
    const arg = view.launchArgv[i]!;
    if (arg === "--cwd") return view.launchArgv[i + 1] !== view.host.cwd;
    if (arg.startsWith("--cwd=")) return arg.slice("--cwd=".length) !== view.host.cwd;
  }
  return false;
}

async function migrateOne(view: HostView, ompBin: string, dryRun: boolean, passive: boolean): Promise<string> {
  const host = view.host;
  const persisted = dryRun ? null : store().read(host.sessionId);
  const verifyCurrentView = passive || startupSelectionChanged(view);
  if (persisted?.passive && !passive) throw new Error("resuming this paused-state migration requires explicit --passive");
  if (persisted === null || persisted.phase === "prepared") {
    if (verifyCurrentView) {
      if (!passive) assertIdle(host, view.turn);
      if (view.sessionFile === null) throw new Error("current handover requires a verified transcript");
      await verifyPassiveHost(host, view.sessionFile, ompBin, view.proc?.startTime ?? null);
    } else assertIdle(host, view.turn);
    if (view.proc === null || !isAlive(host.pid)) throw new Error("original process identity unavailable");
  }
  const sessionFile = persisted?.sessionFile ?? view.sessionFile;
  if (sessionFile === null) throw new Error("missing transcript: blocked pending explicit investigation");
  const raw = readFileSync(sessionFile, "utf8");
  const checkpoint = checkpointHistory(raw, host.sessionId);
  const argv = persisted?.argv ?? migrationArgv(view, ompBin);
  if (dryRun) return `dry-run: idle ${host.sessionId}, stop pid ${host.pid} before ${JSON.stringify(argv)}`;
  const disk = store();
  let record: MigrationRecord;
  if (persisted !== null) record = persisted;
  else {
    disk.backup(host.sessionId, raw);
    record = { version: 1, host, sessionFile, argv, processStartTime: view.proc?.startTime ?? null, passive, phase: "prepared", checkpoint, paneId: null };
    disk.save(record);
  }
  if (passive && !record.passive) {
    record.passive = true;
    disk.save(record);
  }
  const validateOld = async () => {
    const hosts = (await listHosts(ompBin)).hosts;
    let currentHost = hosts.find(item => item.instanceId === record.host.instanceId);
    const currentProc = probeOmpProcesses(record.host.pid)[0] ?? null;
    if (currentHost === undefined || !currentHost.alive || currentHost.pid !== record.host.pid || currentHost.generation !== record.host.generation || currentHost.startedAt !== record.host.startedAt || currentHost.sessionId !== record.host.sessionId || currentHost.cwd !== record.host.cwd || currentProc === null) throw new Error("original instance changed; refusing migration");
    if (hosts.filter(item => item.alive && item.sessionId === record.host.sessionId).length !== 1) throw new Error("duplicate session owners; refusing migration");
    const currentFile = resolveCurrentTranscript(currentHost, [currentHost.sessionFile, findSessionFile(currentHost.sessionId), currentProc.sessionFile])?.path ?? null;
    if (currentFile !== sessionFile) throw new Error("original transcript identity changed");
    if (record.processStartTime && currentProc.startTime !== record.processStartTime) throw new Error("original PID was reused; refusing migration");
    if (view.proc !== null && (currentProc.exeInode !== view.proc.exeInode || JSON.stringify(currentProc.argv) !== JSON.stringify(view.proc.argv))) throw new Error("original process identity changed");
    if (!passive) assertIdle(currentHost, classifySession(sessionFile));
    if (verifyCurrentView) currentHost = await verifyPassiveHost(currentHost, sessionFile, ompBin, currentProc.startTime);
    verifyHistory(record.checkpoint, readFileSync(sessionFile, "utf8"));
    record.argv = idleMigrationArgv(launchArgvOf(currentProc.argv), ompBin, `${currentHost.model.provider}/${currentHost.model.id}`, sessionFile, currentHost.cwd);
  };
  const fresh = await handover(record, {
    save: r => disk.save(r),
    validateOld,
    createEmptyPane: async () => {
      // A crash after pane.create but before ledger fsync must not orphan a PTY.
      const name = `handover:${host.sessionId}`;
      const existing = (await listPanes()).filter(p => p.name === name && p.cwd === host.cwd && p.status !== "closed");
      if (existing.length > 1) throw new Error("multiple prepared migration panes; operator reconciliation required");
      return existing[0]?.paneId ?? (await createPane(host.cwd, { name })).paneId;
    },
    preflight: async paneId => {
      const pane = await getPane(paneId);
      if (pane === null || pane.launchArgv.length > 0 || pane.sessionFile !== null || pane.cwd !== host.cwd) throw new Error("prepared native PTY is not empty");
      const procs = await paneProcesses(paneId);
      if (!procs.some(p => p.pid === pane.shellPid) || procs.some(p => p.pid !== pane.shellPid)) throw new Error("prepared PTY shell unavailable or has children");
    },
    stopOld: async () => { if (!await stopProcess(host.pid)) throw new Error("SIGTERM did not stop original process; deferred without SIGKILL"); },
    oldAlive: () => isAlive(host.pid),
    readHistory: () => readFileSync(sessionFile, "utf8"),
    preserveStopped: raw => disk.backup(host.sessionId, raw, true),
    launch: async (paneId, args) => {
      const launched = await runInPane(paneId, args, { sessionFile });
      if (launched.alreadyRunning) throw new Error("another pane owns this transcript; reconcile ledger");
    },
    registered: async paneId => {
      const next = await waitRegistration(paneId, host, ompBin, sessionFile);
      if (record.phase === "launching" && `${next.model.provider}/${next.model.id}` !== record.argv[record.argv.lastIndexOf("--model") + 1]) throw new Error("registered model differs from current original model");
      return next;
    },
    publish: async (paneId, next) => {
      await publishMigration(host.instanceId, next.instanceId, {
        adopt: id => adoptStartedInstance(id, true),
        remap: recordInstanceRemap,
        bind: () => bindPane(paneId, { instanceId: next.instanceId, sessionId: next.sessionId, sessionFile, model: `${next.model.provider}/${next.model.id}`, awaitingApproval: next.inputRequired, status: next.busy ? "working" : next.inputRequired ? "blocked" : "idle", restoredAt: null }),
      });
    },
    closeEmpty: async paneId => { await closePane(paneId); },
  });
  return `перенесено: ${host.sessionId}, pid ${host.pid} → ${fresh.pid}, панель ${record.paneId}; история проверена`;
}

/** Pending durable transactions remain addressable after their old pid is gone. */
function pendingViews(views: HostView[]): HostView[] {
  let files: string[];
  try { files = readdirSync(LEDGER_ROOT).filter(name => name.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return views; throw error; }
  for (const name of files) {
    const record = JSON.parse(readFileSync(join(LEDGER_ROOT, name), "utf8")) as MigrationRecord;
    if (record.phase === "complete" || views.some(v => v.host.instanceId === record.host.instanceId)) continue;
    // Do not skip a partially published transaction because the new agent is live.
    const freshIndex = views.findIndex(v => v.host.sessionId === record.host.sessionId);
    if (freshIndex >= 0) views.splice(freshIndex, 1);
    views.push({ host: record.host, proc: null, sessionFile: record.sessionFile, launchArgv: record.argv, turn: null, pane: null });
  }
  return views;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "-h" || command === "--help") {
    usage();
    return;
  }
  const paths = defaultPaths();
  if (command !== "list" && command !== "run") {
    usage();
    process.exitCode = 5;
    return;
  }
  // Аргументы проверяем до обращения к рантайму: опечатка не должна ждать пробы.
  const options = command === "run" ? parseRunOptions(rest) : null;

  const ready = await waitRuntimeReady(10_000);
  if (!ready.ok) fail(`рантайм панелей недоступен: ${ready.detail}`, 2);

  if (command === "list") {
    printList(await discover(paths.ompBin), paths.ompBin);
    return;
  }

  if (options === null) fail("run: не разобраны аргументы", 5);
  process.stdout.write("Переносятся только свободные агенты: SIGTERM и проверка завершения перед --resume; занятые откладываются.\n");
  if (options.dryRun) process.stdout.write("dry-run: процессы, панели и реестр не меняются.\n");

  const views = pendingViews(await discover(paths.ompBin, options));
  const selected = selectedByHint(views, options);
  if (options.session !== null && selected.length === 0) fail(`сессия ${options.session} не найдена среди живых агентов`, 1);
  if (options.cwd !== null && selected.length === 0) fail(`в каталоге ${options.cwd} нет живых агентов`, 1);

  const pending: HostView[] = [];
  for (const view of selected) {
    if (view.pane !== null) {
      process.stdout.write(`= ${view.host.sessionId}: уже в панели ${view.pane.paneId}, пропущено\n`);
      continue;
    }
    pending.push(view);
  }
  if (pending.length === 0) {
    process.stdout.write("Переносить нечего.\n");
    return;
  }
  process.stdout.write(`К переносу: ${pending.length}\n`);

  let failed = 0;
  for (const view of pending) {
    try {
      process.stdout.write(`→ ${await migrateOne(view, paths.ompBin, options.dryRun, options.passive)}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`✗ ${view.host.sessionId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.stdout.write(`Итог: ${options.dryRun ? "показано" : "перенесено"} ${pending.length - failed}, ошибок ${failed}.\n`);
  if (failed > 0) process.exitCode = 1;
}

try {
  const release = process.argv[2] === "run" && !process.argv.includes("--dry-run") ? store().lock() : null;
  try { await main(); } finally { release?.(); }
} catch (err) {
  const code = err instanceof CliError ? err.code : 1;
  process.stderr.write(`migrate-to-runtime: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = code;
}
