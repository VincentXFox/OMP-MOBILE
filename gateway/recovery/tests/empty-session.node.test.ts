import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeEmptySession, planEmptySession, validateEmptySnapshot, type EmptyHost } from "../empty-session.ts";

const id = "01a17095-17f9-70f3-b002-f79db42f55a8";
const cwd = process.platform === "win32" ? "C:\\OMP\\herdr-remove" : "/OMP/herdr-remove";
const host: EmptyHost = { instanceId: "native-instance", sessionId: id, pid: 4321, cwd, model: { provider: "openai", id: "current-model" }, alive: true, busy: false, inputRequired: false, sessionFile: null };
function snapshot(now = Date.now()) {
  return { instanceId: host.instanceId, sessionId: id, cwd, header: { type: "session", version: 3, id, timestamp: "2026-10-25T12:34:56.123Z", cwd }, entries: [
    { type: "model_change", id: "abc123", parentId: null, timestamp: "2026-10-25T12:34:56.124Z", provider: "openai", modelId: "current-model" },
    { type: "thinking_level_change", id: "def456", parentId: "abc123", timestamp: "2026-10-25T12:34:56.125Z", thinkingLevel: "high" },
  ], state: { cwd, model: { ...host.model }, thinkingLevel: "high", isStreaming: false, isAborting: false, queuedMessageCount: 0 }, meta: { readOnly: true, capturedAt: new Date(now).toISOString(), pid: host.pid, activeTools: 0, working: false } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "empty-session-"));
  const sessionsRoot = join(root, "sessions");
  const project = join(sessionsRoot, "existing-project");
  mkdirSync(project, { recursive: true });
  const old = join(project, "previous.jsonl");
  writeFileSync(old, "existing unrelated transcript\n");
  const output = join(project, `2026-10-25T12-34-56-123Z_${id}.jsonl`);
  const s = snapshot();
  const snapshotPath = join(root, "view.json");
  writeFileSync(snapshotPath, JSON.stringify(s));
  const args = { sessionId: id, sessionsRoot, output, snapshotPath, checkpointPath: join(root, "checkpoint.json") };
  const sessions = [{ cwd, path: old }];
  const io = { hosts: async () => [host], sessions: () => sessions, findSessionFile: () => null, readSnapshot: async () => structuredClone(s) };
  return { root, project, old, args, sessions, io, s, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("fresh actual settings-only shape is accepted without invented messages fields", () => {
  const now = Date.now();
  assert.equal(validateEmptySnapshot(snapshot(now), id, host, now).sessionId, id);
});
test("verified v18.12.6 combined model selector and runtime metadata are preserved", () => {
  const now = Date.now();
  const s = snapshot(now);
  const actualHost = { ...host, model: { provider: "cheaperinference", id: "deepseek-v4.1-flash" } };
  s.state.model = { ...actualHost.model };
  (s.entries as any[])[0] = { type: "model_change", id: "8362ce70", parentId: null, timestamp: "2026-10-25T12:34:56.124Z", runtime: { version: "18.12.6" }, model: "cheaperinference/deepseek-v4.1-flash", resolvedModelIsFallback: false };
  (s.entries as any[])[1] = { type: "thinking_level_change", id: "0557a326", parentId: "8362ce70", timestamp: "2026-10-25T12:34:56.125Z", thinkingLevel: "high", configured: null };
  assert.deepEqual(validateEmptySnapshot(s, id, actualHost, now).entries, s.entries);
  (s.entries[0] as any).model = "cheaperinference/foreign-model";
  assert.throws(() => validateEmptySnapshot(s, id, actualHost, now), /settings model/);
  Object.assign(s.entries[0]!, { model: "cheaperinference/deepseek-v4.1-flash", provider: "wrong", modelId: "wrong" });
  assert.throws(() => validateEmptySnapshot(s, id, actualHost, now), /settings model/);
});
test("nonempty, stale, foreign, changed settings and active work are rejected", () => {
  const now = Date.now();
  const changes: ((s: any) => void)[] = [
    s => s.entries.push({ type: "message" }), s => s.entries[0].type = "message", s => s.state.messages = [{}],
    s => s.meta.capturedAt = new Date(now - 30_001).toISOString(), s => s.meta.capturedAt = new Date(now + 1).toISOString(),
    s => s.meta.readOnly = false, s => s.meta.pid++, s => s.sessionId = "other", s => s.instanceId = "other", s => s.header.id = "other",
    s => s.state.model.id = "other", s => s.entries[0].modelId = "other", s => s.entries[1].thinkingLevel = "low",
    s => s.entries[1].parentId = null, s => s.entries[1].id = s.entries[0].id,
    s => s.meta.activeTools = 1, s => s.meta.working = true, s => s.state.isStreaming = true,
    s => s.state.isAborting = true, s => s.state.queuedMessageCount = 1,
  ];
  for (const change of changes) { const s = snapshot(now); change(s); assert.throws(() => validateEmptySnapshot(s, id, host, now)); }
  for (const change of [{ busy: true }, { inputRequired: true }, { alive: false }, { sessionFile: "/existing" }, { pid: 4322 }]) {
    assert.throws(() => validateEmptySnapshot(snapshot(now), id, { ...host, ...change }, now));
  }
});
test("output must be exact native timestamp/id in a unique existing canonical same-cwd directory", () => {
  const f = fixture();
  try {
    const plan = () => planEmptySession(f.s, id, host, f.args.output, f.args.sessionsRoot, f.sessions);
    const p = plan();
    const lines = p.content.split("\n");
    assert.equal(Buffer.byteLength(lines[0]!), 255);
    assert.deepEqual(lines.slice(0, -1).map(l => JSON.parse(l)), [f.s.header, ...f.s.entries]);
    assert.throws(() => planEmptySession(f.s, id, host, join(f.project, "wrong.jsonl"), f.args.sessionsRoot, f.sessions));
    assert.throws(() => planEmptySession(f.s, id, host, f.args.output, f.args.sessionsRoot, []));
    const other = join(f.args.sessionsRoot, "another"); mkdirSync(other);
    assert.throws(() => planEmptySession(f.s, id, host, f.args.output, f.args.sessionsRoot, [...f.sessions, { cwd, path: join(other, "old.jsonl") }]));
    writeFileSync(f.args.output, "do not overwrite");
    assert.throws(plan, /already exists/);
    assert.equal(readFileSync(f.args.output, "utf8"), "do not overwrite");
  } finally { f.clean(); }
});
test("exclusive private file follows durable original snapshot checkpoint and host revalidation", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await materializeEmptySession(f.args, { ...f.io, hosts: async () => { if (++calls === 2) assert.equal(existsSync(f.args.checkpointPath), true); return [host]; } });
    assert.equal(calls, 2);
    assert.equal(JSON.parse(readFileSync(result.checkpoint, "utf8")).originalSnapshot, readFileSync(f.args.snapshotPath, "utf8"));
    assert.equal(readFileSync(f.old, "utf8"), "existing unrelated transcript\n");
    assert.equal(JSON.parse(readFileSync(result.output, "utf8").split("\n")[0]!).id, id);
    if (process.platform !== "win32") { assert.equal(statSync(result.output).mode & 0o777, 0o600); assert.equal(statSync(result.checkpoint).mode & 0o777, 0o600); }
    await assert.rejects(materializeEmptySession(f.args, f.io), /already exists/);
  } finally { f.clean(); }
});
test("host change after checkpoint leaves transcript absent", async () => {
  const f = fixture();
  try {
    let calls = 0;
    await assert.rejects(materializeEmptySession(f.args, { ...f.io, hosts: async () => [{ ...host, busy: ++calls === 2 }] }), /busy/);
    assert.equal(existsSync(f.args.output), false);
    assert.equal(existsSync(f.args.checkpointPath), true);
  } finally { f.clean(); }
});
test("concurrent output creation is never overwritten", async () => {
  const f = fixture();
  try {
    let calls = 0;
    await assert.rejects(materializeEmptySession(f.args, { ...f.io, hosts: async () => { if (++calls === 2) writeFileSync(f.args.output, "native writer won"); return [host]; } }), /already exists/);
    assert.equal(readFileSync(f.args.output, "utf8"), "native writer won");
  } finally { f.clean(); }
});
test("same-host same-model thinking change after checkpoint is rejected using a new view snapshot", async () => {
  const f = fixture();
  try {
    await assert.rejects(materializeEmptySession(f.args, { ...f.io, readSnapshot: async () => {
      assert.equal(existsSync(f.args.checkpointPath), true);
      const changed = structuredClone(f.s);
      changed.state.thinkingLevel = "low";
      changed.entries[1]!.thinkingLevel = "low";
      return changed;
    } }), /live snapshot changed/);
    assert.equal(existsSync(f.args.output), false);
  } finally { f.clean(); }
});
test("fresh view failure never materializes a file", async () => {
  const f = fixture();
  try {
    await assert.rejects(materializeEmptySession(f.args, { ...f.io, readSnapshot: async () => { throw new Error("view unavailable"); } }), /view unavailable/);
    assert.equal(existsSync(f.args.output), false);
  } finally { f.clean(); }
});
