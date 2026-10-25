import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, isStale, lockHolder, LockBusyError } from "../lock.ts";
import { readBootId } from "../jobState.ts";

function tempLock(): string {
  return join(mkdtempSync(join(tmpdir(), "omp-lock-")), "update.lock");
}

describe("межпроцессный lock апдейта", () => {
  test("второй захват падает с LockBusyError, пока владелец жив", () => {
    const path = tempLock();
    const held = acquireLock(path, "job-a");
    expect(lockHolder(path)?.jobId).toBe("job-a");
    expect(() => acquireLock(path, "job-b")).toThrow(LockBusyError);
    held.release();
    expect(lockHolder(path)).toBeNull();
    const next = acquireLock(path, "job-b");
    next.release();
  });

  test("lock с мёртвым pid считается протухшим и снимается", () => {
    const path = tempLock();
    writeFileSync(path, `${JSON.stringify({ pid: 999_999, bootId: readBootId(), jobId: "dead", at: "2026-01-01T00:00:00Z" })}\n`);
    expect(isStale({ pid: 999_999, bootId: readBootId(), jobId: "dead", at: "" })).toBe(true);
    const held = acquireLock(path, "fresh");
    expect(JSON.parse(readFileSync(path, "utf8")).jobId).toBe("fresh");
    held.release();
  });

  test("lock другого boot'а снимается даже при живом pid", () => {
    const path = tempLock();
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, bootId: "other-boot", jobId: "old-boot", at: "" })}\n`);
    const held = acquireLock(path, "new-boot");
    expect(held.info.jobId).toBe("new-boot");
    held.release();
  });

  test("release не снимает чужой lock", () => {
    const path = tempLock();
    const first = acquireLock(path, "first");
    first.release();
    const second = acquireLock(path, "second");
    // имитация: первый освобождает повторно — чужой файл не должен исчезнуть
    first.release();
    expect(lockHolder(path)?.jobId).toBe("second");
    second.release();
  });
});
