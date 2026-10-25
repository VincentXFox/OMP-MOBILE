import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  assertTransition,
  canTransition,
  closeStep,
  isTerminal,
  newJob,
  openStep,
  parseJob,
  readJobFile,
  saveJob,
  TransitionError,
} from "../jobState.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-job-"));
}

describe("машина состояний апдейта", () => {
  test("полный счастливый путь допустим и упирается в COMPLETED", () => {
    const job = newJob("omp", "job-1");
    for (const phase of ["CHECKING", "PREPARING", "CHECKPOINTING", "INSTALLING", "RESTARTING", "VERIFYING", "RESTORING", "RESUMING", "COMPLETED"] as const) {
      advance(job, phase);
    }
    expect(job.phase).toBe("COMPLETED");
    expect(isTerminal(job.phase)).toBe(true);
    expect(job.finishedAt).not.toBeNull();
  });

  test("нельзя прыгнуть сразу в COMPLETED и нельзя выйти из терминальной фазы", () => {
    const job = newJob("omp", "job-2");
    expect(() => advance(job, "COMPLETED")).toThrow(TransitionError);
    expect(() => advance(job, "RESTARTING")).toThrow(TransitionError);
    expect(canTransition("FAILED", "CHECKING")).toBe(false);
    expect(() => assertTransition("COMPLETED", "FAILED")).toThrow(TransitionError);
  });

  test("откат разрешён только после установки/проверки, не из CHECKING", () => {
    expect(canTransition("IDLE", "ROLLING_BACK")).toBe(true);
    expect(canTransition("CHECKING", "ROLLING_BACK")).toBe(false);
    expect(canTransition("INSTALLING", "ROLLING_BACK")).toBe(true);
    expect(canTransition("VERIFYING", "ROLLING_BACK")).toBe(true);
    expect(canTransition("ROLLING_BACK", "ROLLED_BACK")).toBe(true);
  });

  test("повторный шаг с тем же id не дублируется", () => {
    const job = newJob("gateway", "job-3");
    const first = openStep(job, "install.pull", "git pull");
    closeStep(first, "ok", "up to date");
    const second = openStep(job, "install.pull", "git pull");
    expect(job.steps.filter((step) => step.id === "install.pull")).toHaveLength(1);
    expect(second.status).toBe("run");
  });
});

describe("durable state-файл", () => {
  test("round-trip сохраняет все поля, включая чекпоинт и откат", () => {
    const dir = tempDir();
    const path = join(dir, "job.json");
    const job = newJob("frontend", "job-4");
    job.checkpointFile = "/tmp/checkpoint.json";
    job.previousArtifacts = "/tmp/prev";
    job.rollback = { available: true, reason: "предыдущий бинарь сохранён" };
    job.versions = { from: "1.2.3", to: "1.3.0" };
    saveJob(path, job);
    const read = readJobFile(path);
    expect(read).not.toBeNull();
    expect(read?.checkpointFile).toBe("/tmp/checkpoint.json");
    expect(read?.previousArtifacts).toBe("/tmp/prev");
    expect(read?.rollback?.available).toBe(true);
    expect(read?.versions.to).toBe("1.3.0");
  });

  test("битый файл не превращается в «пустое состояние» — читатель видит null", () => {
    const dir = tempDir();
    const path = join(dir, "job.json");
    writeFileSync(path, '{"schema":2,"jobId":"x","component":"omp","phase":"COMPLE');
    expect(readJobFile(path)).toBeNull();
    expect(parseJob({ schema: 2, jobId: "x", component: "nope", phase: "IDLE" })).toBeNull();
  });

  test("запись атомарна: после сохранения нет временных файлов рядом", () => {
    const dir = tempDir();
    const path = join(dir, "job.json");
    saveJob(path, newJob("omp", "job-5"));
    const entries = Array.from(new Bun.Glob("*").scanSync({ cwd: dir }));
    expect(entries).toEqual(["job.json"]);
    expect(JSON.parse(readFileSync(path, "utf8")) as unknown).toBeTruthy();
  });
});
