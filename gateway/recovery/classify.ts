import { readFileSync } from "node:fs";

/** Решения о продолжении принимаются по журналу сессии, а не по эвристике
 * «есть ли слово session_exit»: важны kind, pendingToolCalls и незакрытые результаты. */
export type TurnStatus =
  | "empty"
  | "finished"
  | "in_flight"
  | "closed_by_signal"
  | "closed_by_crash"
  | "aborted_by_user";

export interface DangerOp {
  toolName: string;
  toolCallId: string | null;
  command: string | null;
  path: string | null;
  intent: string | null;
  at: string | null;
}

export interface TurnState {
  status: TurnStatus;
  /** Последняя запись транскрипта (ISO). */
  lastAt: string | null;
  /** Запись session_exit, если процесс её оставил. */
  exit: { kind: string; reason: string; at: string; pending: number } | null;
  /** Вызовы инструментов, для которых нет результата (процесс умер посреди работы). */
  unresolved: DangerOp[];
  /** Опасные вызовы, которые были в полёте на момент выхода (по pendingToolCalls). */
  pendingAtExit: DangerOp[];
  /** Нужен ли явный промпт-продолжение после восстановления. */
  needsContinuation: boolean;
  /** Завершённые ранее опасные операции: их повторять нельзя. */
  lastAssistantStop: string | null;
  openTodos: string[];
}

const DANGEROUS_TOOLS: Record<string, true> = { bash: true, write: true, edit: true, ast_edit: true, memory_edit: true };

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS[name] === true;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

interface ParsedEntry {
  type: string;
  customType: string | null;
  at: string | null;
  data: Record<string, unknown> | null;
  message: Record<string, unknown> | null;
}

function parseLine(line: string): ParsedEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  const entry = obj(value);
  if (entry === null) return null;
  const type = str(entry["type"]);
  if (type === null) return null;
  return {
    type,
    customType: str(entry["customType"]),
    at: str(entry["timestamp"]),
    data: obj(entry["data"]),
    message: obj(entry["message"]),
  };
}

function dangerFromStart(data: Record<string, unknown>, at: string | null): DangerOp {
  const args = obj(data["args"]);
  return {
    toolName: str(data["toolName"]) ?? "unknown",
    toolCallId: str(data["toolCallId"]),
    command: args === null ? null : str(args["command"]),
    path: args === null ? null : (str(args["path"]) ?? str(args["file_path"])),
    intent: str(data["intent"]),
    at: str(data["startedAt"]) ?? at,
  };
}

/** Разбор транскрипта: сколько вызовов начато без результата, чем закрыт турн,
 * какие опасные операции были в полёте. */
export function classifySession(sessionPath: string): TurnState {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return {
      status: "empty",
      lastAt: null,
      exit: null,
      unresolved: [],
      pendingAtExit: [],
      needsContinuation: false,
      lastAssistantStop: null,
      openTodos: [],
    };
  }
  const started = new Map<string, DangerOp>();
  const finished = new Set<string>();
  let exit: TurnState["exit"] = null;
  let pendingAtExit: DangerOp[] = [];
  let finishedAtExit = false;
  let lastAt: string | null = null;
  let lastAssistantStop: string | null = null;
  let openTodos: string[] = [];
  let lastRole: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line);
    if (entry === null) continue;
    if (entry.at !== null) lastAt = entry.at;
    if (entry.type === "custom" && entry.customType === "tool_execution_start" && entry.data !== null) {
      const op = dangerFromStart(entry.data, entry.at);
      const key = op.toolCallId ?? `${op.toolName}:${op.at}`;
      started.set(key, op);
    }
    if (entry.type === "message" && entry.message !== null) {
      const role = str(entry.message["role"]);
      // Новый запрос после exit относится к новому запуску. Уточнение пользователя
      // в активном запуске сохраняет незакрытые вызовы инструментов.
      if (role === "user" && exit !== null) {
        exit = null;
        pendingAtExit = [];
        finishedAtExit = false;
        started.clear();
        finished.clear();
        lastAssistantStop = null;
      }
      if (role !== null) lastRole = role;
      if (role === "toolResult") {
        const id = str(entry.message["toolCallId"]);
        if (id !== null) finished.add(id);
      }
      if (role === "assistant") {
        lastAssistantStop = str(entry.message["stopReason"]);
        // aborted может быть завершающей записью при остановке процесса. Только
        // успешный stop закрывает работу, прерванную предыдущим exit.
        if (lastAssistantStop === "stop" && exit !== null) {
          exit = null;
          pendingAtExit = [];
          finishedAtExit = false;
          started.clear();
          finished.clear();
        }
        const content = entry.message["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = obj(block);
            if (b !== null && b["type"] === "toolCall") {
              const id = str(b["id"]);
              if (id !== null) started.set(id, { ...dangerFromStart({ ...b, toolName: str(b["name"]) ?? "unknown" }, entry.at) });
            }
          }
        }
      }
    }
    if (entry.type === "custom" && entry.customType === "session_exit" && entry.data !== null) {
      const pendingRaw = entry.data["pendingToolCalls"];
      pendingAtExit = Array.isArray(pendingRaw)
        ? pendingRaw.map((item) => {
            const p = obj(item);
            return {
              toolName: p === null ? "unknown" : (str(p["toolName"]) ?? "unknown"),
              toolCallId: p === null ? null : str(p["toolCallId"]),
              command: p === null ? null : (str(obj(p["args"])?.["command"]) ?? null),
              path: p === null ? null : (str(obj(p["args"])?.["path"]) ?? null),
              intent: p === null ? null : str(p["intent"]),
              at: p === null ? null : str(p["startedAt"]),
            };
          })
        : [];
      finishedAtExit = lastRole === "assistant" && lastAssistantStop === "stop"
        && pendingAtExit.length === 0 && [...started.keys()].every((key) => finished.has(key));
      exit = {
        kind: str(entry.data["kind"]) ?? "unknown",
        reason: str(entry.data["reason"]) ?? "",
        at: str(entry.data["recordedAt"]) ?? entry.at ?? "",
        pending: pendingAtExit.length,
      };
    }
    if (entry.type === "custom" && entry.customType === "user_todo_edit" && entry.data !== null) {
      const phases = entry.data["phases"];
      openTodos = Array.isArray(phases) ? collectOpenTodos(phases) : [];
    }
  }

  const unresolved: DangerOp[] = [];
  for (const [key, op] of started) {
    if (!finished.has(key)) unresolved.push(op);
  }

  const status = decideStatus(exit, unresolved, lastAssistantStop, lastRole, finishedAtExit);
  return {
    status,
    lastAt,
    exit,
    unresolved,
    pendingAtExit,
    needsContinuation: needsContinuation(status),
    lastAssistantStop,
    openTodos,
  };
}

function collectOpenTodos(phases: unknown[]): string[] {
  const open: string[] = [];
  for (const phaseRaw of phases) {
    const phase = obj(phaseRaw);
    if (phase === null) continue;
    const items = phase["items"];
    if (!Array.isArray(items)) continue;
    for (const itemRaw of items) {
      const item = obj(itemRaw);
      if (item === null) continue;
      const status = str(item["status"]);
      const content = str(item["content"]) ?? str(item["text"]) ?? "";
      if (status !== "completed" && content !== "") open.push(content);
    }
  }
  return open;
}

function decideStatus(exit: TurnState["exit"], unresolved: DangerOp[], lastAssistantStop: string | null, lastRole: string | null, finishedAtExit: boolean): TurnStatus {
  if (exit !== null) {
    if (finishedAtExit && (exit.kind === "signal" || exit.kind === "process_exit" || exit.kind === "fatal")) return "finished";
    if (exit.kind === "signal" || exit.kind === "process_exit") return exit.reason.includes("sigterm") ? "closed_by_signal" : "closed_by_crash";
    if (exit.kind === "fatal") return "closed_by_crash";
    // kind "normal": пользователь вышел сам; прерванный турн не доигрывается
    return "aborted_by_user";
  }
  if (lastRole === "assistant" && lastAssistantStop === "aborted") return "aborted_by_user";
  if (unresolved.length > 0) return "in_flight";
  if (lastRole === "assistant" && lastAssistantStop !== null && lastAssistantStop !== "toolUse") return "finished";
  if (lastRole === null) return "empty";
  return "in_flight";
}

/** Продолжение нужно, когда турн закрыт не пользователем: signal/crash/in-flight.
 * Для `closed_by_signal` omp сам турн не доигрывает — нужен явный промпт. */
function needsContinuation(status: TurnStatus): boolean {
  if (status === "closed_by_signal") return true;
  if (status === "closed_by_crash") return true;
  if (status === "in_flight") return true;
  return false;
}
