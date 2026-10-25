import { readFileSync } from "node:fs";
import { appendJsonLine } from "./atomic.ts";
import type { Phase } from "./jobState.ts";

/** Событие журнала апдейта. seq монотонен в пределах job-файла, поэтому UI
 * может переподключиться и запросить `since=<seq>` без пропусков и дублей. */
export interface UpdateEvent {
  seq: number;
  at: string;
  jobId: string;
  phase: Phase;
  kind: string;
  message: string | null;
  data: Record<string, unknown> | null;
}

function parseEvent(value: unknown): UpdateEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["seq"] !== "number" || typeof v["at"] !== "string" || typeof v["kind"] !== "string") return null;
  if (typeof v["jobId"] !== "string" || typeof v["phase"] !== "string") return null;
  return {
    seq: v["seq"],
    at: v["at"],
    jobId: v["jobId"],
    phase: v["phase"] as Phase,
    kind: v["kind"],
    message: typeof v["message"] === "string" ? v["message"] : null,
    data: typeof v["data"] === "object" && v["data"] !== null ? (v["data"] as Record<string, unknown>) : null,
  };
}

/** Чтение журнала: битый хвост (обрыв записи) пропускается, seq берётся по максимуму. */
export function readJournal(path: string, sinceSeq = 0, limit = 500): UpdateEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: UpdateEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const event = parseEvent(parsed);
    if (event === null || event.seq <= sinceSeq) continue;
    events.push(event);
  }
  return events.length > limit ? events.slice(events.length - limit) : events;
}

export function lastSeq(path: string): number {
  const events = readJournal(path, 0, 10_000);
  return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0);
}

export class UpdateJournal {
  #seq: number;

  constructor(
    private readonly path: string,
    private readonly jobId: string,
  ) {
    this.#seq = lastSeq(path);
  }

  get seq(): number {
    return this.#seq;
  }

  append(phase: Phase, kind: string, message?: string, data?: Record<string, unknown>): UpdateEvent {
    this.#seq += 1;
    const event: UpdateEvent = {
      seq: this.#seq,
      at: new Date().toISOString(),
      jobId: this.jobId,
      phase,
      kind,
      message: message ?? null,
      data: data ?? null,
    };
    appendJsonLine(this.path, event);
    return event;
  }
}
