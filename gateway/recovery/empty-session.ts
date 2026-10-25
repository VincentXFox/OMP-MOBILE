import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

type RecordValue = Record<string, any>;
export interface EmptyHost {
  instanceId: string; sessionId: string; pid: number; cwd: string;
  model: { provider: string; id: string }; alive: boolean; busy: boolean;
  inputRequired: boolean; sessionFile: string | null;
}
export interface EmptySnapshot {
  instanceId: string; sessionId: string; cwd: string;
  header: RecordValue; entries: RecordValue[]; state: RecordValue;
  meta: { readOnly: true; capturedAt: string; pid: number; activeTools: number; working: boolean };
}
export interface EmptyPlan { sessionId: string; output: string; content: string; snapshot: EmptySnapshot }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Empty session materialization refused: ${message}`);
}
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Accept only a fresh view-client capture of the proven, settings-only native layout. */
export function validateEmptySnapshot(value: unknown, sessionId: string, host: EmptyHost, now = Date.now()): EmptySnapshot {
  requireValue(UUID.test(sessionId) && record(value), "invalid session identity or snapshot");
  const s = value as unknown as EmptySnapshot;
  requireValue(record(s.meta) && s.meta.readOnly === true, "snapshot must come from a read-only client");
  const age = now - Date.parse(s.meta.capturedAt);
  requireValue(Number.isFinite(age) && age >= 0 && age <= 30_000, "stale or future snapshot");
  requireValue(s.meta.activeTools === 0 && s.meta.working === false, "snapshot is busy");
  requireValue(host.alive === true && host.busy === false && host.inputRequired === false && host.sessionFile === null, "host is busy, unavailable, or already has a transcript");
  requireValue(s.sessionId === sessionId && host.sessionId === sessionId && s.instanceId === host.instanceId && s.meta.pid === host.pid && Number.isInteger(host.pid) && host.pid > 0, "host identity changed");
  requireValue(typeof s.cwd === "string" && s.cwd === host.cwd && isAbsolute(s.cwd), "host cwd changed");
  requireValue(record(s.header) && s.header.type === "session" && s.header.version === 3 && s.header.id === sessionId && s.header.cwd === s.cwd, "invalid native session header");
  requireValue(typeof s.header.timestamp === "string" && Number.isFinite(Date.parse(s.header.timestamp)) && new Date(s.header.timestamp).toISOString() === s.header.timestamp, "invalid native timestamp");
  requireValue(record(s.state) && s.state.cwd === s.cwd, "snapshot state cwd changed");
  requireValue(s.state.messages === undefined || (Array.isArray(s.state.messages) && s.state.messages.length === 0), "snapshot contains messages");
  requireValue(s.state.isStreaming === false && s.state.isAborting === false && s.state.queuedMessageCount === 0, "snapshot has active or queued work");
  requireValue(record(s.state.model) && s.state.model.provider === host.model.provider && s.state.model.id === host.model.id, "current model changed");
  requireValue(Array.isArray(s.entries) && s.entries.length === 2 && s.entries[0]?.type === "model_change" && s.entries[1]?.type === "thinking_level_change", "only the two settings entries are supported");
  const ids = new Set<string>();
  let parent: string | null = null;
  for (const entry of s.entries) {
    requireValue(record(entry) && typeof entry.id === "string" && /^[a-zA-Z0-9_-]+$/.test(entry.id) && !ids.has(entry.id), "invalid or duplicate entry id");
    requireValue(entry.parentId === parent && typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)), "broken settings entry linkage or timestamp");
    requireValue(!("message" in entry) && !("content" in entry), "entry contains message content");
    ids.add(entry.id); parent = entry.id;
  }
  const modelEntry = s.entries[0];
  const nativeSelector = `${host.model.provider}/${host.model.id}`;
  // Native v18.12.6 stores the combined selector in `model`; older layouts use
  // separate provider/modelId fields. If both exist, require both to agree.
  const combinedModel = typeof modelEntry.model === "string" && modelEntry.model === nativeSelector;
  const splitModel = modelEntry.provider === host.model.provider && modelEntry.modelId === host.model.id;
  requireValue((combinedModel || splitModel) && (modelEntry.model === undefined || combinedModel) && ((modelEntry.provider === undefined && modelEntry.modelId === undefined) || splitModel), "settings model differs from current model");
  requireValue(typeof s.state.thinkingLevel === "string" && s.entries[1].thinkingLevel === s.state.thinkingLevel, "thinking level differs from captured state");
  return s;
}

/** Derive the directory from existing same-cwd sessions; never guess a cwd slug. */
export function planEmptySession(value: unknown, sessionId: string, host: EmptyHost, output: string, sessionsRoot: string, sessions: readonly { cwd: string | null; path: string }[], now = Date.now()): EmptyPlan {
  const snapshot = validateEmptySnapshot(value, sessionId, host, now);
  const root = realpathSync(sessionsRoot);
  requireValue(isAbsolute(output) && resolve(output) === output, "output must be an exact absolute canonical path");
  const candidates = new Set(sessions.filter(s => s.cwd === snapshot.cwd).map(s => realpathSync(dirname(s.path))));
  requireValue(candidates.size === 1, "same-cwd session directory is missing or ambiguous");
  const dir = [...candidates][0]!;
  requireValue(dir.startsWith(root + sep) && dirname(dir) === root && !lstatSync(dir).isSymbolicLink(), "project directory is outside the native sessions root");
  const filename = `${snapshot.header.timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
  requireValue(dirname(output) === dir && basename(output) === filename && output === join(dir, filename), "output path differs from native session identity");
  requireValue(!existsSync(output), "output already exists");
  const header = JSON.stringify(snapshot.header);
  requireValue(Buffer.byteLength(header) <= 255, "native header exceeds the proven 255-byte slot");
  const content = header + " ".repeat(255 - Buffer.byteLength(header)) + "\n" + snapshot.entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  return { sessionId, output, content, snapshot };
}

function privateWrite(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  // Windows does not support fsync on directory handles; each new file is still fsynced.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export interface MaterializeIO {
  hosts(): Promise<EmptyHost[]>;
  sessions(): readonly { cwd: string | null; path: string }[];
  findSessionFile(sessionId: string): string | null;
  /** Must obtain a new authenticated read-only view of this exact instance. */
  readSnapshot(expected: EmptySnapshot): Promise<unknown>;
}
/** Checkpoint first, then revalidate immediately before exclusive creation. No host mutation. */
export async function materializeEmptySession(args: { snapshotPath: string; checkpointPath: string; sessionId: string; output: string; sessionsRoot: string }, io: MaterializeIO): Promise<{ output: string; checkpoint: string; sha256: string }> {
  const raw = readFileSync(args.snapshotPath, "utf8");
  const value: unknown = JSON.parse(raw);
  const prepare = async (snapshot: unknown): Promise<EmptyPlan> => {
    const hosts = (await io.hosts()).filter(h => h.sessionId === args.sessionId && h.alive);
    requireValue(hosts.length === 1, "live host identity is missing or ambiguous");
    requireValue(io.findSessionFile(args.sessionId) === null, "session transcript already exists");
    return planEmptySession(snapshot, args.sessionId, hosts[0]!, args.output, args.sessionsRoot, io.sessions());
  };
  const plan = await prepare(value);
  const sha256 = createHash("sha256").update(plan.content).digest("hex");
  requireValue(resolve(args.checkpointPath) !== resolve(args.output) && resolve(args.checkpointPath) !== resolve(args.snapshotPath), "checkpoint must be a separate new file");
  privateWrite(args.checkpointPath, JSON.stringify({ version: 1, action: "materialize-empty-session", createdAt: new Date().toISOString(), sessionId: args.sessionId, output: plan.output, sha256, originalSnapshot: raw }, null, 2) + "\n");
  syncDirectory(dirname(args.checkpointPath));
  const refreshed = await io.readSnapshot(plan.snapshot);
  const fresh = await prepare(refreshed);
  requireValue(fresh.content === plan.content && JSON.stringify(fresh.snapshot.state.model) === JSON.stringify(plan.snapshot.state.model) && fresh.snapshot.state.thinkingLevel === plan.snapshot.state.thinkingLevel && readFileSync(args.snapshotPath, "utf8") === raw, "live snapshot changed during checkpoint");
  privateWrite(fresh.output, fresh.content);
  syncDirectory(dirname(fresh.output));
  return { output: fresh.output, checkpoint: args.checkpointPath, sha256 };
}
