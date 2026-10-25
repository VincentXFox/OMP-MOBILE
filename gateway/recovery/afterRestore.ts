import { basename } from "node:path";
import { listHosts } from "../hosts.ts";
import { classifySession } from "./classify.ts";
import { listPanes } from "./checkpoint.ts";
import { runtimeSessionControl } from "./runtimeControl.ts";
import { continuationPrompt } from "./resume.ts";
import { newRecoveryState, type LogicalSession } from "./model.ts";

export interface AfterRestoreOutcome {
  sessionId: string;
  turn: ReturnType<typeof classifySession>["status"];
  continued: boolean;
  blocked: string | null;
}

/** id сессии из имени файла `<ISO>_<sessionId>.jsonl`. */
export function sessionIdFromFile(path: string): string | null {
  const match = /_([0-9a-f-]{8,})\.jsonl$/.exec(basename(path));
  return match?.[1] ?? null;
}

const WAIT_IDLE_MS = 30_000;
const WAIT_PANE_MS = 30_000;

/** После `--restore` проверяем, доигрался ли турн. omp сам продолжает только
 * турн, оборванный без записи `session_exit`; после SIGTERM/нормального выхода
 * продолжение надо отправить явно — с запретом повторять уже сделанное. */
export async function continueAfterRestore(sessionPath: string, cwd: string, pid: number | null, versions: { from: string | null; to: string | null }): Promise<AfterRestoreOutcome> {
  const sessionId = sessionIdFromFile(sessionPath) ?? sessionPath;
  const turn = classifySession(sessionPath);
  if (!turn.needsContinuation) {
    return { sessionId, turn: turn.status, continued: false, blocked: null };
  }
  const control = runtimeSessionControl();
  const paneId = await waitPaneForPid(pid);
  if (paneId === null) {
    return { sessionId, turn: turn.status, continued: false, blocked: "панель восстановленной сессии не найдена" };
  }
  const ready = await waitReadyToPrompt(sessionId);
  if (ready === "approval") {
    return { sessionId, turn: turn.status, continued: false, blocked: "сессия ждёт подтверждения пользователя — автопродолжение запрещено" };
  }
  if (ready === "timeout") {
    return { sessionId, turn: turn.status, continued: false, blocked: "сессия не стала idle за 30 с — продолжение не отправлено" };
  }
  const session: LogicalSession = {
    logicalId: `${cwd}::${sessionId}`,
    sessionId,
    cwd,
    files: [sessionPath],
    lazy: false,
    model: null,
    label: null,
    paneId,
    launchArgv: ["omp", "--cwd", cwd, "--allow-home"],
    pid,
    turn,
    awaitingApproval: false,
    recovery: { ...newRecoveryState(), registered: true },
    updatedAt: new Date().toISOString(),
  };
  await control.submitPrompt(paneId, continuationPrompt(session, versions.from, versions.to));
  return { sessionId, turn: turn.status, continued: true, blocked: null };
}

async function waitPaneForPid(pid: number | null): Promise<string | null> {
  if (pid === null) return null;
  const deadline = Date.now() + WAIT_PANE_MS;
  for (;;) {
    const panes = await listPanes();
    const match = panes.find((pane) => pane.pid === pid);
    if (match !== undefined) return match.paneId;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(1_000);
  }
}

async function waitReadyToPrompt(sessionId: string): Promise<"ready" | "approval" | "timeout"> {
  const deadline = Date.now() + WAIT_IDLE_MS;
  for (;;) {
    const host = (await listHosts().catch(() => ({ hosts: [] }))).hosts.find((item) => item.sessionId === sessionId && item.alive);
    if (host !== undefined) {
      if (host.inputRequired) return "approval";
      if (!host.busy) return "ready";
    }
    if (Date.now() >= deadline) return "timeout";
    await Bun.sleep(1_000);
  }
}
