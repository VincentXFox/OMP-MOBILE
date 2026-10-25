import { closeSync, openSync, readFileSync, unlinkSync, writeSync, fsyncSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readBootId } from "./jobState.ts";

export interface LockInfo {
  pid: number;
  bootId: string;
  jobId: string;
  at: string;
}

export interface HeldLock {
  info: LockInfo;
  release: () => void;
}

export class LockBusyError extends Error {
  constructor(readonly holder: LockInfo | null) {
    super(
      holder === null
        ? "апдейт уже выполняется (lock занят, владелец неизвестен)"
        : `апдейт уже выполняется: job ${holder.jobId}, pid ${holder.pid} с ${holder.at}`,
    );
    this.name = "LockBusyError";
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v["pid"] !== "number" || typeof v["bootId"] !== "string" || typeof v["jobId"] !== "string") return null;
    return { pid: v["pid"], bootId: v["bootId"], jobId: v["jobId"], at: typeof v["at"] === "string" ? v["at"] : "" };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Максимальная длительность задачи: старше — считаем лок брошенным. */
const MAX_LOCK_AGE_MS = 2 * 60 * 60 * 1000;

/** Lock мёртв, если владелец другого boot'а, его pid не существует или лок протух по возрасту. */
export function isStale(info: LockInfo): boolean {
  if (info.bootId !== readBootId() || !pidAlive(info.pid)) return true;
  if (info.at === "") return false;
  const started = Date.parse(info.at);
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > MAX_LOCK_AGE_MS;
}

/** Межпроцессный lock апдейта. O_EXCL не даёт двум оркестраторам (или шлюзу
 * и оркестратору) вести один апдейт; устаревший lock снимается по pid/bootId. */
export function acquireLock(path: string, jobId: string): HeldLock {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = { pid: process.pid, bootId: readBootId(), jobId, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(info)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        info,
        release: () => {
          const current = readLock(path);
          if (current !== null && current.pid === info.pid && current.bootId === info.bootId && current.jobId === info.jobId) {
            try {
              unlinkSync(path);
            } catch {
              // уже снят
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(path);
      if (holder === null) {
        // Нечитаемый lock = занят: снимать его вслепую значит позволить угон мастеринга (D8).
        throw new LockBusyError(null);
      }
      if (isStale(holder)) {
        try {
          unlinkSync(path);
        } catch {
          // гонка: снял другой процесс
        }
        continue;
      }
      throw new LockBusyError(holder);
    }
  }
  throw new LockBusyError(readLock(path));
}

export function lockHolder(path: string): LockInfo | null {
  const holder = readLock(path);
  return holder !== null && !isStale(holder) ? holder : null;
}
