import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIdle, assertPassiveIdle, assertCurrentTranscriptHeader, checkpointHistory, handover, idleMigrationArgv, migrationStore, publishMigration, recordRemapFile, resolveCurrentTranscript, verifyHistory, type HandoverIO, type MigrationRecord } from "../migrate.ts";
import type { OmpHost } from "../../hosts.ts";
import type { TurnState } from "../classify.ts";

const raw = '{"type":"session","id":"session"}\n{"id":"entry 1","type":"message","text":"hello"}\n';
const host = { instanceId: "old", sessionId: "session", pid: 42, busy: false, inputRequired: false } as OmpHost;
const turn = { status: "finished", needsContinuation: false, unresolved: [], pendingAtExit: [] } as unknown as TurnState;
const fresh = { ...host, instanceId: "new", pid: 43 };
function fixture() {
  const events: string[] = [];
  let alive = true;
  const record: MigrationRecord = { version: 1, host, sessionFile: "/exact session.jsonl", argv: ["omp", "--resume", "/exact session.jsonl"], phase: "prepared", checkpoint: checkpointHistory(raw, "session"), paneId: null };
  const io: HandoverIO = {
    save: r => { events.push(`save:${r.phase}`); },
    validateOld: async () => { events.push("validate"); },
    createEmptyPane: async () => { events.push("create"); return "native"; },
    preflight: async () => { events.push("preflight"); },
    stopOld: async () => { events.push("stop"); alive = false; },
    oldAlive: () => alive,
    readHistory: () => raw,
    preserveStopped: () => {},
    launch: async (_pane, argv) => { assert.equal(alive, false); assert.equal(argv.includes("--restore"), false); events.push("launch"); },
    registered: async () => { events.push("registered"); return fresh; },
    publish: async () => { events.push("publish"); },
    closeEmpty: async () => { events.push("close"); },
  };
  return { record, io, events, dead: () => { alive = false; } };
}

test("busy, approval and unfinished operations defer; ordinary idle is allowed", () => {
  assert.doesNotThrow(() => assertIdle(host, turn));
  for (const h of [{ ...host, busy: true }, { ...host, inputRequired: true }]) assert.throws(() => assertIdle(h, turn));
  for (const t of [null, { ...turn, needsContinuation: true }, { ...turn, status: "in_flight" }, { ...turn, unresolved: [{}] }, { ...turn, pendingAtExit: [{}] }]) assert.throws(() => assertIdle(host, t as TurnState | null));
});

test("explicit passive handover accepts a paused transcript only with a fresh matching quiescent view", () => {
  const paused = { ...turn, status: "closed_by_signal", needsContinuation: true } as TurnState;
  const current = { ...host, alive: true, cwd: "/work", model: { provider: "p", id: "m" } };
  const snapshot = {
    instanceId: current.instanceId, sessionId: current.sessionId, cwd: current.cwd,
    header: { type: "session", version: 3, id: current.sessionId, cwd: current.cwd },
    entries: [{ type: "message" }],
    state: { cwd: current.cwd, model: current.model, isStreaming: false, isAborting: false, queuedMessageCount: 0 },
    meta: { readOnly: true, capturedAt: new Date().toISOString(), pid: current.pid, activeTools: 0, working: false },
  };
  const descendants = [{ pid: current.pid, argv: ["omp"] }, { pid: 50, argv: ["python3", "-m", "autoharness.stage_skill.server"] }];
  assert.throws(() => assertIdle(current, paused));
  assert.doesNotThrow(() => assertPassiveIdle(current, paused, snapshot, descendants));
  assert.doesNotThrow(() => assertPassiveIdle(current, { ...paused, status: "in_flight" }, snapshot, descendants));
  for (const changed of [{ ...current, busy: true }, { ...current, inputRequired: true }, { ...current, alive: false }, { ...current, pid: 99 }, { ...current, cwd: "/other" }, { ...current, model: { provider: "p", id: "changed" } }]) assert.throws(() => assertPassiveIdle(changed, paused, snapshot, descendants));
  for (const changed of [{ ...paused, unresolved: [{}] }, { ...paused, pendingAtExit: [{}] }]) assert.throws(() => assertPassiveIdle(current, changed as TurnState, snapshot, descendants));
  for (const state of [{ ...snapshot.state, isStreaming: true }, { ...snapshot.state, isAborting: true }, { ...snapshot.state, queuedMessageCount: 1 }, { ...snapshot.state, cwd: "/other" }]) assert.throws(() => assertPassiveIdle(current, paused, { ...snapshot, state }, descendants));
  for (const meta of [{ ...snapshot.meta, readOnly: false }, { ...snapshot.meta, activeTools: 1 }, { ...snapshot.meta, working: true }, { ...snapshot.meta, capturedAt: new Date(Date.now() - 6_000).toISOString() }]) assert.throws(() => assertPassiveIdle(current, paused, { ...snapshot, meta }, descendants));
  for (const changed of [{ ...snapshot, header: { ...snapshot.header, id: "foreign" } }, { ...snapshot, instanceId: "other" }, { ...snapshot, stream: {} }, { ...snapshot, uiRequest: {} }, { ...snapshot, droppedFrames: 1 }]) assert.throws(() => assertPassiveIdle(current, paused, changed, descendants));
  assert.throws(() => assertPassiveIdle(current, paused, undefined, descendants));
  assert.throws(() => assertPassiveIdle(current, paused, snapshot, []));
  assert.throws(() => assertPassiveIdle(current, paused, snapshot, [...descendants, { pid: 51, argv: ["bash", "-c", "work"] }]));
  assert.throws(() => assertPassiveIdle(current, paused, snapshot, [...descendants, { pid: 51, argv: ["python3", "-m", "autoharness.stage_skill.server"] }]));
});

test("passive queue change at final fresh validation prevents signaling or launching", async () => {
  const { record, io, events } = fixture();
  record.passive = true;
  const current = { ...host, alive: true, cwd: "/work", model: { provider: "p", id: "m" } };
  const paused = { ...turn, status: "in_flight", needsContinuation: true } as TurnState;
  let checks = 0;
  io.validateOld = async () => {
    const queuedMessageCount = ++checks === 3 ? 1 : 0;
    const snapshot = { instanceId: current.instanceId, sessionId: current.sessionId, cwd: current.cwd, header: { type: "session", version: 3, id: current.sessionId, cwd: current.cwd }, state: { cwd: current.cwd, model: current.model, isStreaming: false, isAborting: false, queuedMessageCount }, meta: { readOnly: true, capturedAt: new Date().toISOString(), pid: current.pid, activeTools: 0, working: false } };
    assertPassiveIdle(current, paused, snapshot, [{ pid: current.pid, argv: ["omp"] }]);
  };
  await assert.rejects(handover(record, io), /queued work/);
  assert.equal(checks, 3);
  assert.equal(events.includes("stop"), false);
  assert.equal(events.includes("launch"), false);
});

test("migration argv preserves exact safe startup options but overrides current model and never replays prompt", () => {
  assert.deepEqual(idleMigrationArgv(["old-omp", "--cwd", "/work/Проект 1", "--allow-home", "--model=old/model", "--provider", "old", "--thinking", "high", "--resume", "/old.jsonl"], "omp", "new/model", "/exact session.jsonl"), ["omp", "--cwd", "/work/Проект 1", "--allow-home", "--thinking", "high", "--model", "new/model", "--resume", "/exact session.jsonl"]);
  for (const arg of ["initial prompt", "--unknown"]) assert.throws(() => idleMigrationArgv(["omp", arg], "omp", "p/m", "/s.jsonl"), /refusing prompt replay/);
  assert.throws(() => idleMigrationArgv(["omp"], "omp", "p/m", ""), /transcript/);
});

test("a fork in the same PID resolves the current native child instead of the stale startup parent", () => {
  const current = { sessionId: "child", cwd: "/tmp" };
  const parent = { type: "session", version: 3, id: "parent", cwd: "/old-project" };
  const child = { type: "session", version: 3, id: "child", cwd: "/tmp", parentSession: "parent" };
  const prefix = JSON.stringify({ type: "custom", customType: "external_metadata", data: {} }) + "\n";
  const files: Record<string, string> = { "/parent.jsonl": prefix + JSON.stringify(parent) + "\n", "/child.jsonl": prefix + JSON.stringify(child) + "\n" };
  const read = (path: string) => files[path]!;
  const selected = resolveCurrentTranscript(current, ["/parent.jsonl", "/child.jsonl", "/child.jsonl"], read);
  assert.deepEqual(selected, { path: "/child.jsonl", header: child });
  assert.doesNotThrow(() => assertCurrentTranscriptHeader(selected!.header, { header: { parentSession: "parent", cwd: "/tmp", id: "child", version: 3, type: "session" } }));
  for (const header of [parent, { ...child, parentSession: "foreign" }, { ...child, cwd: "/other" }]) assert.throws(() => assertCurrentTranscriptHeader(selected!.header, { header }), /authenticated current session header/);
  assert.equal(resolveCurrentTranscript(current, ["/parent.jsonl"], read), null);
  assert.equal(resolveCurrentTranscript({ ...current, cwd: "/wrong" }, ["/child.jsonl"], read), null);
  assert.throws(() => resolveCurrentTranscript(current, ["/child.jsonl", "/copy.jsonl"], path => path === "/copy.jsonl" ? files["/child.jsonl"]! : read(path)), /multiple transcripts/);
  assert.throws(() => resolveCurrentTranscript(current, ["/child.jsonl"], () => files["/child.jsonl"]! + JSON.stringify(child) + "\n"), /multiple session headers/);
  assert.throws(() => resolveCurrentTranscript(current, ["/child.jsonl"], () => files["/child.jsonl"]! + JSON.stringify(parent) + "\n"), /multiple session headers/);
  assert.equal(resolveCurrentTranscript(current, ["/metadata-only.jsonl"], () => prefix), null);
  assert.equal(files["/parent.jsonl"], prefix + JSON.stringify(parent) + "\n");
});

test("current cwd replaces every stale separate or inline cwd without replaying a startup selector", () => {
  for (const oldCwd of [["--cwd", "/old project"], ["--cwd=/old project"], ["--cwd=/old", "--cwd", "/older"]]) {
    assert.deepEqual(idleMigrationArgv(["omp", ...oldCwd, "--thinking", "high", "--resume", "/parent.jsonl"], "omp", "p/current", "/child.jsonl", "/tmp"), ["omp", "--thinking", "high", "--cwd", "/tmp", "--model", "p/current", "--resume", "/child.jsonl"]);
  }
});

test("a current session change during final authenticated header validation never stops the original process", async () => {
  const { record, io, events } = fixture();
  const header = { type: "session", id: "session", cwd: "/tmp", parentSession: "parent" };
  let checks = 0;
  io.validateOld = async () => {
    const selected = resolveCurrentTranscript({ sessionId: "session", cwd: "/tmp" }, ["/current.jsonl"], () => JSON.stringify(header));
    assertCurrentTranscriptHeader(selected!.header, { header: ++checks === 3 ? { ...header, id: "next-session" } : header });
  };
  await assert.rejects(handover(record, io), /authenticated current session header/);
  assert.equal(checks, 3);
  assert.equal(events.includes("stop"), false);
  assert.equal(events.includes("launch"), false);
});

test("ownership adoption and durable address remap both precede binding and transaction success", async () => {
  const events: string[] = [];
  const io = { adopt: (id: string) => { events.push(`adopt:${id}`); }, remap: (old: string, next: string) => { events.push(`remap:${old}:${next}`); }, bind: async () => { events.push("bind"); } };
  await publishMigration("old", "new", io);
  assert.deepEqual(events, ["adopt:new", "remap:old:new", "bind"]);
  events.length = 0;
  await assert.rejects(publishMigration("old", "new", { ...io, remap: () => { throw new Error("disk failure"); } }), /disk failure/);
  assert.deepEqual(events, ["adopt:new"]);
});

test("remap persists across reads/process state, merges other addresses, and fails explicitly on corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-remap-"));
  try {
    const path = join(dir, "remap.json");
    recordRemapFile(path, "older", "previous");
    recordRemapFile(path, "old", "new");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { older: "previous", old: "new" });
    writeFileSync(path, "corrupt");
    assert.throws(() => recordRemapFile(path, "old", "other"));
    assert.equal(readFileSync(path, "utf8"), "corrupt");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two real processes preserve every remap and ownership update through shared RMW locks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-publish-race-"));
  const moduleUrl = new URL("../migrate.ts", import.meta.url).href;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const runs = [0, 1].map(writer => {
      const script = `import { recordRemapFile, withStateFileLock } from ${JSON.stringify(moduleUrl)};
        import { existsSync, readFileSync, writeFileSync } from 'node:fs';
        const dir = ${JSON.stringify(dir)};
        const writer = ${writer};
        writeFileSync(dir + '/ready-' + writer, 'ready');
        while (!existsSync(dir + '/go')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        for (let i = 0; i < 40; i++) {
          const id = writer + '-' + i;
          recordRemapFile(dir + '/remap.json', id, 'new-' + id);
          withStateFileLock(dir + '/started.json', () => {
            const ids = existsSync(dir + '/started.json') ? JSON.parse(readFileSync(dir + '/started.json', 'utf8')) : [];
            ids.push(id);
            writeFileSync(dir + '/started.json', JSON.stringify(ids));
          });
        }`;
      const args = process.versions.bun ? ["-e", script] : ["--experimental-strip-types", "--input-type=module", "-e", script];
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", data => { stderr += String(data); });
      return new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer failed (${code}): ${stderr}`)));
      });
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "ready-0")) || !existsSync(join(dir, "ready-1"))) {
      if (Date.now() > deadline) throw new Error("child startup timeout");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    writeFileSync(join(dir, "go"), "go");
    await Promise.all(runs);
    const remap = JSON.parse(readFileSync(join(dir, "remap.json"), "utf8"));
    const started = JSON.parse(readFileSync(join(dir, "started.json"), "utf8")) as string[];
    assert.equal(Object.keys(remap).length, 80);
    assert.equal(new Set(started).size, 80);
    for (let writer = 0; writer < 2; writer++) for (let i = 0; i < 40; i++) {
      assert.equal(remap[`${writer}-${i}`], `new-${writer}-${i}`);
      assert.ok(started.includes(`${writer}-${i}`));
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kernel metadata lock is released when its child owner dies", { skip: process.platform !== "linux" || !process.versions.bun }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-lock-crash-"));
  const path = join(dir, "remap.json");
  const ready = join(dir, "ready");
  const moduleUrl = new URL("../migrate.ts", import.meta.url).href;
  const script = `import { withStateFileLock } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync } from 'node:fs';
    withStateFileLock(${JSON.stringify(path)}, () => {
      writeFileSync(${JSON.stringify(ready)}, 'locked');
      for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    });`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", () => resolve()); });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("lock child startup timeout");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    child.kill("SIGKILL"); // Only the synthetic child created by this test.
    await exited;
    recordRemapFile(path, "old", "new");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { old: "new" });
    assert.ok(existsSync(`${path}.lock`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight and fresh idle checks precede stop; dead confirmation precedes launch and durable publication", async () => {
  const { record, io, events } = fixture();
  assert.equal(await handover(record, io), fresh);
  assert.equal(record.phase, "complete");
  assert.deepEqual(events.filter(e => !e.startsWith("save:")), ["validate", "create", "preflight", "validate", "validate", "stop", "preflight", "launch", "registered", "publish"]);
  assert.ok(events.indexOf("save:launching") < events.indexOf("launch"));
  assert.ok(events.indexOf("publish") < events.indexOf("save:complete"));
});

test("new busy state during final check cleans empty pane without stopping old", async () => {
  const { record, io, events } = fixture();
  let checks = 0;
  io.validateOld = async () => { if (++checks === 2) throw new Error("busy"); };
  await assert.rejects(handover(record, io), /busy/);
  assert.equal(events.includes("stop"), false);
  assert.equal(events.includes("launch"), false);
  assert.equal(events.includes("close"), true);
  assert.equal(record.paneId, null);
});

test("TERM timeout never launches or force-kills; same prepared pane survives retry", async () => {
  const { record, io, events } = fixture();
  io.stopOld = async () => { events.push("stop-timeout"); };
  await assert.rejects(handover(record, io), /still alive/);
  assert.equal(record.phase, "stopping");
  assert.equal(record.paneId, "native");
  assert.equal(events.includes("launch"), false);
});

test("registration timeout retry reuses pane and never starts second reader", async () => {
  const { record, io, events } = fixture();
  io.registered = async () => { throw new Error("timeout"); };
  await assert.rejects(handover(record, io), /timeout/);
  assert.equal(record.phase, "launching");
  assert.equal(events.includes("close"), false);
  io.registered = async () => fresh;
  await handover(record, io);
  assert.equal(events.filter(e => e === "launch").length, 1);
  assert.equal(events.filter(e => e === "create").length, 1);
});

test("publication failure retains registered phase for publication-only retry", async () => {
  const { record, io, events } = fixture();
  io.publish = async () => { throw new Error("disk full"); };
  await assert.rejects(handover(record, io), /disk full/);
  assert.equal(record.phase, "registered");
  const changed = { ...fresh, busy: true, inputRequired: true, model: { provider: "p", id: "changed" } };
  io.registered = async () => changed;
  io.publish = async (_pane, current) => { assert.equal(current, changed); };
  assert.equal(await handover(record, io), changed);
  assert.equal(events.filter(e => e === "launch").length, 1);
});

test("exact identity and all old entry content/order required; appended shutdown is allowed", () => {
  const before = checkpointHistory(raw, "session");
  assert.doesNotThrow(() => verifyHistory(before, raw + '{"id":"exit","type":"custom"}\n'));
  assert.throws(() => verifyHistory(before, raw.replace("hello", "lost")), /lost entries/);
  assert.throws(() => checkpointHistory(raw, "other"), /identity mismatch/);
  assert.throws(() => checkpointHistory("", "session"), /header/);
  assert.throws(() => checkpointHistory(raw + "{truncated", "session"));
});

test("history loss after shutdown blocks launch and preserves checkpoint", async () => {
  const { record, io, events } = fixture();
  io.readHistory = () => raw.replace("hello", "lost");
  await assert.rejects(handover(record, io), /lost entries/);
  assert.equal(events.includes("launch"), false);
  assert.equal(record.phase, "stopping");
});

test("private durable store has exclusive lock and never overwrites original backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-migrate-"));
  try {
    const store = migrationStore(dir);
    const unlock = store.lock();
    assert.throws(() => store.lock(), /EEXIST/);
    const { record } = fixture();
    store.backup("session", raw);
    assert.throws(() => store.backup("session", "changed"), /EEXIST/);
    store.save(record);
    assert.deepEqual(store.read("session"), record);
    assert.equal(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith(".backup"))!), "utf8"), raw);
    if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
    unlock();
    store.lock()();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
