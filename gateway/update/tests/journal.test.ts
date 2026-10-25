import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonLine } from "../atomic.ts";
import { lastSeq, readJournal, UpdateJournal } from "../journal.ts";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "omp-journal-")), name);
}

describe("журнал событий задачи", () => {
  test("seq монотонен между экземплярами и переживает перезапуск", () => {
    const path = tempFile("job.jsonl");
    const first = new UpdateJournal(path, "job-1");
    first.append("CHECKING", "start", "начало");
    first.append("PREPARING", "check", "диск");
    const second = new UpdateJournal(path, "job-1");
    second.append("INSTALLING", "step", "установка");
    expect(lastSeq(path)).toBe(3);
    expect(readJournal(path).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  test("replay по since отдаёт только новые события", () => {
    const path = tempFile("job.jsonl");
    const journal = new UpdateJournal(path, "job-2");
    journal.append("CHECKING", "a");
    journal.append("PREPARING", "b");
    journal.append("INSTALLING", "c");
    expect(readJournal(path, 2).map((event) => event.kind)).toEqual(["c"]);
    expect(readJournal(path, 3)).toEqual([]);
  });

  test("битый хвост (обрыв записи) пропускается, читаемые события остаются", () => {
    const path = tempFile("job.jsonl");
    appendJsonLine(path, { seq: 1, at: "2026-01-01T00:00:00Z", jobId: "j", phase: "CHECKING", kind: "start", message: null, data: null });
    writeFileSync(path, '{"seq":2,"at":"2026-', { flag: "a" });
    const events = readJournal(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
  });

  test("limit оставляет последние события (UI не задыхается на длинном журнале)", () => {
    const path = tempFile("job.jsonl");
    const journal = new UpdateJournal(path, "job-3");
    for (let i = 0; i < 10; i++) journal.append("INSTALLING", `step-${i}`);
    const tail = readJournal(path, 0, 3);
    expect(tail.map((event) => event.kind)).toEqual(["step-7", "step-8", "step-9"]);
  });
});
