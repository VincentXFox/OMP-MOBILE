import { readFileSync } from "node:fs";
import { writeJsonDurable } from "./atomic.ts";

/** Компоненты, которыми управляет апдейтер. `gateway`/`frontend` обновляются одним
 * git-циклом (общий коммит), но перезапускаются и проверяются раздельно. */
export const COMPONENT_IDS = ["omp", "gateway", "frontend", "relay", "runtime"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && COMPONENT_IDS.some((id) => id === value);
}

/** Явная машина состояний апдейта. Переходы ограничены таблицей: «успех»
 * нельзя выставить из произвольной точки, а откат — только из фаз после установки. */
export const PHASES = [
  "IDLE",
  "CHECKING",
  "PREPARING",
  "CHECKPOINTING",
  "INSTALLING",
  "RESTARTING",
  "VERIFYING",
  "RESTORING",
  "RESUMING",
  "COMPLETED",
  "ROLLING_BACK",
  "ROLLED_BACK",
  "FAILED",
  "BLOCKED",
] as const;
export type Phase = (typeof PHASES)[number];

const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  IDLE: ["CHECKING", "ROLLING_BACK", "FAILED", "BLOCKED"],
  CHECKING: ["PREPARING", "FAILED", "BLOCKED"],
  PREPARING: ["CHECKPOINTING", "FAILED", "BLOCKED"],
  CHECKPOINTING: ["INSTALLING", "FAILED", "BLOCKED"],
  INSTALLING: ["RESTARTING", "ROLLING_BACK", "FAILED"],
  RESTARTING: ["VERIFYING", "ROLLING_BACK", "FAILED"],
  VERIFYING: ["RESTORING", "COMPLETED", "ROLLING_BACK", "FAILED"],
  RESTORING: ["RESUMING", "COMPLETED", "BLOCKED", "ROLLING_BACK", "FAILED"],
  RESUMING: ["COMPLETED", "BLOCKED", "FAILED"],
  COMPLETED: [],
  ROLLING_BACK: ["ROLLED_BACK", "FAILED"],
  ROLLED_BACK: [],
  FAILED: [],
  BLOCKED: [],
};

export class TransitionError extends Error {
  constructor(
    readonly from: Phase,
    readonly to: Phase,
  ) {
    super(`недопустимый переход ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

export function isTerminal(phase: Phase): boolean {
  return TRANSITIONS[phase].length === 0;
}

export interface StepRecord {
  id: string;
  label: string;
  status: "run" | "ok" | "fail" | "skipped";
  detail?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface JobOwner {
  pid: number;
  bootId: string;
  startedAt: string;
}

export interface JobState {
  /** Версия схемы файла: старые job-файлы читаются как есть и не ломают UI. */
  schema: 2;
  jobId: string;
  component: ComponentId;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  owner: JobOwner;
  steps: StepRecord[];
  error: { message: string; phase: Phase } | null;
  rollback: { available: boolean; reason: string; sha256?: string | null } | null;
  versions: { from: string | null; to: string | null };
  /** Путь к снимку сессий, сделанному перед установкой. */
  checkpointFile: string | null;
  /** Артефакты задачи, чьё состояние восстанавливаем при откате. */
  previousArtifacts: string | null;
  result: JobResult | null;
  finishedAt: string | null;
}

/** Сессия, которая живёт вне панелей рантайма: обновление её не перезапускало,
 * поэтому она осталась на прежнем образе и переносится отдельной командой. */
export interface LegacySessionRef {
  sessionId: string;
  cwd: string;
  pid: number | null;
  sessionFile: string | null;
}

export interface JobResult {
  verifiedVersions: Record<string, string | null>;
  restored: number;
  resumed: number;
  blocked: string[];
  /** Сессии вне панелей рантайма: не провал обновления, но и не «всё обновлено». */
  legacy: LegacySessionRef[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function readBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
}

export function newJob(component: ComponentId, jobId: string): JobState {
  const at = nowIso();
  return {
    schema: 2,
    jobId,
    component,
    phase: "IDLE",
    createdAt: at,
    updatedAt: at,
    attempt: 1,
    owner: { pid: process.pid, bootId: readBootId(), startedAt: at },
    steps: [],
    error: null,
    rollback: null,
    versions: { from: null, to: null },
    checkpointFile: null,
    previousArtifacts: null,
    result: null,
    finishedAt: null,
  };
}

const PHASE_SET: ReadonlySet<string> = new Set(PHASES);

function isStepRecord(value: unknown): value is StepRecord {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<StepRecord>;
  return (
    typeof s.id === "string" &&
    typeof s.label === "string" &&
    (s.status === "run" || s.status === "ok" || s.status === "fail" || s.status === "skipped") &&
    typeof s.startedAt === "string"
  );
}

/** Старые job-файлы поля не имеют: отсутствие `legacy` — это ноль сессий,
 * а не потерянная информация. */
function legacyRefsOf(value: unknown): LegacySessionRef[] {
  if (!Array.isArray(value)) return [];
  const refs: LegacySessionRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v["sessionId"] !== "string" || typeof v["cwd"] !== "string") continue;
    refs.push({
      sessionId: v["sessionId"],
      cwd: v["cwd"],
      pid: typeof v["pid"] === "number" ? v["pid"] : null,
      sessionFile: typeof v["sessionFile"] === "string" ? v["sessionFile"] : null,
    });
  }
  return refs;
}

/** Чтение с валидацией: битый/чужой файл даёт null, а не «пустое состояние вместо истории». */
export function parseJob(value: unknown): JobState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["schema"] !== 2) return null;
  if (typeof v["jobId"] !== "string" || !isComponentId(v["component"])) return null;
  if (typeof v["phase"] !== "string" || !PHASE_SET.has(v["phase"])) return null;
  if (typeof v["createdAt"] !== "string" || typeof v["updatedAt"] !== "string") return null;
  const steps = Array.isArray(v["steps"]) ? v["steps"].filter(isStepRecord) : [];
  const ownerRaw = v["owner"];
  const owner: JobOwner =
    typeof ownerRaw === "object" && ownerRaw !== null && typeof (ownerRaw as Record<string, unknown>)["pid"] === "number"
      ? {
          pid: (ownerRaw as Record<string, number>)["pid"] ?? 0,
          bootId: typeof (ownerRaw as Record<string, unknown>)["bootId"] === "string" ? String((ownerRaw as Record<string, unknown>)["bootId"]) : "unknown",
          startedAt: typeof (ownerRaw as Record<string, unknown>)["startedAt"] === "string" ? String((ownerRaw as Record<string, unknown>)["startedAt"]) : "",
        }
      : { pid: 0, bootId: "unknown", startedAt: "" };
  const versionsRaw = v["versions"];
  const versions =
    typeof versionsRaw === "object" && versionsRaw !== null
      ? {
          from: typeof (versionsRaw as Record<string, unknown>)["from"] === "string" ? String((versionsRaw as Record<string, unknown>)["from"]) : null,
          to: typeof (versionsRaw as Record<string, unknown>)["to"] === "string" ? String((versionsRaw as Record<string, unknown>)["to"]) : null,
        }
      : { from: null, to: null };
  const errorRaw = v["error"];
  const error =
    typeof errorRaw === "object" && errorRaw !== null && typeof (errorRaw as Record<string, unknown>)["message"] === "string"
      ? {
          message: String((errorRaw as Record<string, unknown>)["message"]),
          phase: PHASE_SET.has(String((errorRaw as Record<string, unknown>)["phase"])) ? (String((errorRaw as Record<string, unknown>)["phase"]) as Phase) : ("FAILED" as Phase),
        }
      : null;
  const rollbackRaw = v["rollback"];
  const rollback =
    typeof rollbackRaw === "object" && rollbackRaw !== null && typeof (rollbackRaw as Record<string, unknown>)["available"] === "boolean"
      ? {
          available: Boolean((rollbackRaw as Record<string, unknown>)["available"]),
          reason: typeof (rollbackRaw as Record<string, unknown>)["reason"] === "string" ? String((rollbackRaw as Record<string, unknown>)["reason"]) : "",
          sha256: typeof (rollbackRaw as Record<string, unknown>)["sha256"] === "string" ? String((rollbackRaw as Record<string, unknown>)["sha256"]) : null,
        }
      : null;
  const resultRaw = v["result"];
  const result =
    typeof resultRaw === "object" && resultRaw !== null
      ? {
          verifiedVersions:
            typeof (resultRaw as Record<string, unknown>)["verifiedVersions"] === "object" && (resultRaw as Record<string, unknown>)["verifiedVersions"] !== null
              ? (Object.fromEntries(
                  Object.entries((resultRaw as Record<string, unknown>)["verifiedVersions"] as Record<string, unknown>).map(([k, val]) => [
                    k,
                    typeof val === "string" ? val : null,
                  ]),
                ) as Record<string, string | null>)
              : {},
          restored: typeof (resultRaw as Record<string, unknown>)["restored"] === "number" ? Number((resultRaw as Record<string, unknown>)["restored"]) : 0,
          resumed: typeof (resultRaw as Record<string, unknown>)["resumed"] === "number" ? Number((resultRaw as Record<string, unknown>)["resumed"]) : 0,
          blocked: Array.isArray((resultRaw as Record<string, unknown>)["blocked"]) ? ((resultRaw as Record<string, unknown>)["blocked"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
          legacy: legacyRefsOf((resultRaw as Record<string, unknown>)["legacy"]),
        }
      : null;
  return {
    schema: 2,
    jobId: v["jobId"],
    component: v["component"],
    phase: v["phase"] as Phase,
    createdAt: v["createdAt"],
    updatedAt: v["updatedAt"],
    attempt: typeof v["attempt"] === "number" ? v["attempt"] : 1,
    owner,
    steps,
    error,
    rollback,
    versions,
    checkpointFile: typeof v["checkpointFile"] === "string" ? v["checkpointFile"] : null,
    previousArtifacts: typeof v["previousArtifacts"] === "string" ? v["previousArtifacts"] : null,
    result,
    finishedAt: typeof v["finishedAt"] === "string" ? v["finishedAt"] : null,
  };
}

export function readJobFile(path: string): JobState | null {
  try {
    return parseJob(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function saveJob(path: string, job: JobState): void {
  job.updatedAt = nowIso();
  writeJsonDurable(path, job);
}

/** Переход с проверкой таблицы. Возвращает новый updatedAt; состояние пишет вызывающий. */
export function advance(job: JobState, to: Phase): JobState {
  assertTransition(job.phase, to);
  job.phase = to;
  job.updatedAt = nowIso();
  if (isTerminal(to)) job.finishedAt = job.updatedAt;
  return job;
}

export function openStep(job: JobState, id: string, label: string): StepRecord {
  const step: StepRecord = { id, label, status: "run", startedAt: nowIso() };
  job.steps = job.steps.filter((s) => s.id !== id);
  job.steps.push(step);
  return step;
}

export function closeStep(step: StepRecord, status: "ok" | "fail" | "skipped", detail?: string): void {
  step.status = status;
  step.finishedAt = nowIso();
  if (detail !== undefined) step.detail = detail;
}
