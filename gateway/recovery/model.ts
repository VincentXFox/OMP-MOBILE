import { readFileSync } from "node:fs";
import { appendJsonLine, writeJsonDurable } from "../update/atomic.ts";
import type { DangerOp, TurnState } from "./classify.ts";

/** Логическая сессия: то, что переживает рестарт процесса и смену физического файла. */
export interface LogicalSession {
  /** Стабильный ключ: cwd + sessionId (sessionId не меняется при --resume/--restore). */
  logicalId: string;
  sessionId: string;
  cwd: string;
  /** Физические транскрипты в порядке смены (fork/sibling), последний — активный. */
  files: string[];
  /** Ленивая сессия: транскрипта ещё нет (старт с --continue, турн не записан). */
  lazy: boolean;
  model: string | null;
  label: string | null;
  paneId: string | null;
  /** argv живого процесса на момент чекпоинта (без сессионного флага). */
  launchArgv: string[];
  pid: number | null;
  /** Состояние турна на момент снимка. */
  turn: TurnState | null;
  /** Ожидалось подтверждение пользователя — автопродолжение запрещено. */
  awaitingApproval: boolean;
  /** Уже выполненные в этом апдейте шаги восстановления (идемпотентность). */
  recovery: RecoveryState;
  updatedAt: string;
}

export interface RecoveryState {
  killed: boolean;
  relaunched: boolean;
  registered: boolean;
  continued: boolean;
  blocked: string | null;
}

export interface Checkpoint {
  schema: 1;
  jobId: string;
  createdAt: string;
  ompVersion: string | null;
  sessions: LogicalSession[];
}

export interface CheckpointStore {
  path: string;
}

export function newRecoveryState(): RecoveryState {
  return { killed: false, relaunched: false, registered: false, continued: false, blocked: null };
}

export function readCheckpoint(path: string): Checkpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (v["schema"] !== 1 || typeof v["jobId"] !== "string" || !Array.isArray(v["sessions"])) return null;
    return {
      schema: 1,
      jobId: v["jobId"],
      createdAt: typeof v["createdAt"] === "string" ? v["createdAt"] : "",
      ompVersion: typeof v["ompVersion"] === "string" ? v["ompVersion"] : null,
      sessions: v["sessions"].filter(isLogicalSession),
    };
  } catch {
    return null;
  }
}

function isLogicalSession(value: unknown): value is LogicalSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["logicalId"] !== "string" || typeof v["sessionId"] !== "string" || !Array.isArray(v["files"])) return false;
  v["lazy"] = v["lazy"] === true;
  return true;
}

export function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeJsonDurable(path, checkpoint);
}

/** Журнал восстановления: append-only, чтобы после сбоя было видно, что уже сделано
 * и на чём именно остановились. */
export interface RecoveryEvent {
  at: string;
  jobId: string;
  logicalId: string;
  step: "checkpoint" | "kill" | "relaunch" | "register" | "continue" | "blocked" | "verify";
  ok: boolean;
  detail: string;
  dangerOps?: DangerOp[];
}

export function appendRecoveryEvent(path: string, event: RecoveryEvent): void {
  appendJsonLine(path, event);
}

/** Устойчивое хранилище состояния восстановления (переживает рестарт оркестратора). */
export function writeRecoveryState(path: string, sessions: readonly LogicalSession[]): void {
  writeJsonDurable(path, { schema: 1, updatedAt: new Date().toISOString(), sessions });
}
