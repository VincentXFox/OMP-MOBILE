/**
 * Панели для шлюза: один узкий интерфейс вместо CLI herdr.
 *
 * Раньше каждый модуль шлюза сам звал `herdr agent list` / `pane read` и
 * разбирал его конверт. Теперь всё, что шлюзу нужно от терминалов, выражено
 * здесь: список панелей, поиск панели агента, чтение экрана, ввод, запуск
 * команды, привязка сессии. Замена рантайма на другую реализацию больше не
 * размазывается по десятку файлов.
 */

import { RuntimeError, type PaneStatus } from "./runtime/protocol.ts";
import { probeRuntime, runtimeRequest } from "./runtime/client.ts";

/** Панель в том виде, в каком её видит шлюз. */
export interface ManagedPane {
  paneId: string;
  name: string;
  cwd: string;
  shellPid: number;
  cols: number;
  rows: number;
  title: string | null;
  sessionId: string | null;
  instanceId: string | null;
  sessionFile: string | null;
  launchArgv: string[];
  status: PaneStatus;
  model?: string | null;
  awaitingApproval?: boolean;
  restoredAt?: number | null;
}

interface RawPane {
  id: string;
  name: string;
  cwd: string;
  shellPid: number;
  cols: number;
  rows: number;
  title: string | null;
  sessionId: string | null;
  instanceId: string | null;
  sessionFile: string | null;
  launchArgv: string[];
  status: PaneStatus;
  model?: string | null;
  awaitingApproval?: boolean;
  restoredAt?: number | null;
}

function toManaged(raw: RawPane): ManagedPane {
  return { ...raw, paneId: raw.id, launchArgv: [...raw.launchArgv] };
}

/** Ошибка «панели нет» / «сессией владеет другая панель» — это не сбой, а ответ. */
export function isPaneGone(error: unknown): boolean {
  return error instanceof RuntimeError && (error.code === "pane_not_found" || error.code === "pane_closed");
}

export async function listPanes(): Promise<ManagedPane[]> {
  const out = await runtimeRequest<{ panes: RawPane[] }>("pane.list", {}, 10_000);
  return out.panes.map(toManaged);
}

export async function getPane(paneId: string): Promise<ManagedPane | null> {
  try {
    const out = await runtimeRequest<{ pane: RawPane }>("pane.get", { paneId }, 10_000);
    return toManaged(out.pane);
  } catch (error) {
    if (isPaneGone(error)) return null;
    throw error;
  }
}

export async function createPane(cwd: string, opts: { name?: string; cols?: number; rows?: number } = {}): Promise<ManagedPane> {
  const out = await runtimeRequest<{ pane: RawPane }>("pane.create", { cwd, ...opts }, 15_000);
  return toManaged(out.pane);
}

/** Панель агента из collab-реестра.
 *
 * Привязка по `instanceId` — точная. Если её нет (панель поднял демон после
 * рестарта, агент зарегистрировался под новым id), панель подтверждается pid
 * процесса в дереве панели: cwd сам по себе ничего не доказывает — агент может
 * жить в чужой панели (например, в унаследованной панели прежнего рантайма),
 * а в том же каталоге стоять наша свободная панель. Не подтвердилось — «панели нет». */
export async function paneOfHost(host: { instanceId: string; pid: number; cwd: string }): Promise<ManagedPane | null> {
  const panes = (await listPanes()).filter((pane) => pane.status !== "closed");
  const bound = panes.find((pane) => pane.instanceId === host.instanceId);
  if (bound !== undefined) return bound;
  for (const candidate of panes) {
    if ((await panePids(candidate.paneId)).includes(host.pid)) return candidate;
  }
  return null;
}

/** Панели, привязанные к сессии (по sessionId или по файлу сессии). */
export async function panesOfSession(sessionId: string, sessionFile: string | null = null): Promise<ManagedPane[]> {
  return (await listPanes()).filter(
    (pane) => pane.sessionId === sessionId || (sessionFile !== null && pane.sessionFile === sessionFile),
  );
}

/** pid'ы процессов панели: оболочка и всё её потомство. */
export async function panePids(paneId: string): Promise<number[]> {
  return (await paneProcesses(paneId)).map((proc) => proc.pid);
}

/** Процессы панели целиком (pid, argv, cmdline, cwd) — оболочка и потомство. */
export async function paneProcesses(paneId: string): Promise<Array<{ pid: number; name: string; argv: string[]; cmdline: string; cwd: string }>> {
  const out = await runtimeRequest<{ process_info: { foreground_processes: Array<{ pid: number; name: string; argv: string[]; cmdline: string; cwd: string }> } }>(
    "pane.processInfo",
    { paneId },
    10_000,
  );
  return out.process_info.foreground_processes;
}

/** Имя процесса на переднем плане панели (без самой оболочки) — по нему
 * recovery понимает, свободна ли панель для восстановления. */
export async function paneForegroundName(paneId: string): Promise<string | null> {
  const out = await runtimeRequest<{ process_info: { foreground_processes: Array<{ pid: number; name: string }> } }>("pane.processInfo", { paneId }, 10_000);
  const shellPid = await paneShellPid(paneId);
  const children = out.process_info.foreground_processes.filter((proc) => proc.pid !== shellPid);
  const first = children[0];
  return first === undefined ? null : first.name;
}

async function paneShellPid(paneId: string): Promise<number> {
  const out = await runtimeRequest<{ pane: RawPane }>("pane.get", { paneId }, 10_000);
  return out.pane.shellPid;
}

/** Снимок панели. `lines` отсчитываются от конца вместе со скроллбеком
 * (`source: recent`): «подтверждения» агента легко уезжают выше видимого экрана,
 * и режим visible вернул бы ровно 34 строки панели. */
export async function readPane(paneId: string, format: "text" | "ansi" = "text", lines?: number): Promise<string> {
  const out = await runtimeRequest<{ text: string }>(
    "pane.read",
    { paneId, format, source: "recent", ...(lines === undefined ? {} : { lines }) },
    15_000,
  );
  return out.text;
}

export async function runInPane(paneId: string, argv: string[], opts: { sessionFile?: string | null } = {}): Promise<{ alreadyRunning: boolean; paneId?: string }> {
  const out = await runtimeRequest<{ ok: true; alreadyRunning?: boolean; paneId?: string }>(
    "pane.run",
    { paneId, argv, ...(opts.sessionFile === undefined || opts.sessionFile === null ? {} : { sessionFile: opts.sessionFile }) },
    60_000,
  );
  return { alreadyRunning: out.alreadyRunning === true, ...(out.paneId === undefined ? {} : { paneId: out.paneId }) };
}

export async function sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
  await runtimeRequest("pane.input", { paneId, keys }, 15_000);
}

export async function sendPaneText(paneId: string, text: string): Promise<void> {
  await runtimeRequest("pane.input", { paneId, text }, 15_000);
}

export async function resizePane(paneId: string, cols: number, rows: number): Promise<void> {
  await runtimeRequest("pane.resize", { paneId, cols, rows }, 10_000);
}

export async function renamePane(paneId: string, name: string): Promise<void> {
  await runtimeRequest("pane.rename", { paneId, name }, 10_000);
}

export interface PaneBinding {
  sessionId?: string | null;
  instanceId?: string | null;
  sessionFile?: string | null;
  launchArgv?: string[];
  status?: PaneStatus;
  model?: string | null;
  awaitingApproval?: boolean;
  /** Метку восстановления шлюз снимает, обработав её: иначе два процесса
   * (шлюз и оркестратор обновления) дослали бы продолжение дважды. */
  restoredAt?: number | null;
}

export async function bindPane(paneId: string, binding: PaneBinding): Promise<void> {
  await runtimeRequest("pane.bind", { paneId, ...binding }, 10_000);
}

/** Закрыть панель: `desiredRunning=false`, процессы панели гасятся (TERM→KILL). */
export async function closePane(paneId: string): Promise<void> {
  await runtimeRequest("pane.close", { paneId }, 20_000);
}

export async function runtimeHealth(): Promise<{ ok: boolean; detail: string; pid?: number; panes?: number; generation?: string; restoreIssues?: number }> {
  const probe = await probeRuntime();
  return {
    ok: probe.ok,
    detail: probe.detail,
    ...(probe.health === undefined ? {} : { pid: probe.health.pid, panes: probe.health.panes, generation: probe.health.generation, restoreIssues: probe.health.restoreIssues.length }),
  };
}

/** Панель со свежей меткой восстановления (агент вернулся после рестарта рантайма). */
export function restoredSince(panes: ManagedPane[], since: number): ManagedPane[] {
  return panes.filter((pane) => typeof pane.restoredAt === "number" && pane.restoredAt > since);
}
