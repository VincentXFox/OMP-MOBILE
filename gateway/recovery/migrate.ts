import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { OmpHost } from "../hosts.ts";
import type { TurnState } from "./classify.ts";

/** Only repeat known startup options, never positional initial prompts. */
export function idleMigrationArgv(base: readonly string[], executable: string, model: string, sessionFile: string, currentCwd?: string): string[] {
  if (base.length === 0 || sessionFile === "") throw new Error("exact argv and transcript are required");
  const result = [executable];
  const values = new Set(["--cwd", "--thinking", "--session-dir", "--model", "--provider"]);
  const selectors = new Set(["--resume", "-r", "--restore", "--session", "--fork", "--goal"]);
  const bare = new Set(["--continue", "-c", "--no-session", "--from-claude", "--from-codex"]);
  for (let i = 1; i < base.length; i++) {
    const arg = base[i]!;
    const flag = arg.split("=")[0]!;
    const inline = arg.includes("=");
    if (bare.has(flag)) continue;
    if (selectors.has(flag)) { if (!inline) i++; continue; }
    if (flag === "--allow-home" && !inline) { result.push(arg); continue; }
    if (!values.has(flag)) throw new Error(`unsupported launch argument at index ${i}; refusing prompt replay`);
    const value = inline ? arg.slice(arg.indexOf("=") + 1) : base[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`incomplete launch option ${flag}`);
    if (flag === "--model" || flag === "--provider" || (flag === "--cwd" && currentCwd !== undefined)) continue;
    result.push(...(inline ? [arg] : [flag, value]));
  }
  return [...result, ...(currentCwd === undefined ? [] : ["--cwd", currentCwd]), "--model", model, "--resume", sessionFile];
}

/** A long-lived process may fork/change sessions without changing its startup
 * argv. Only a file whose native header identifies the CURRENT host is usable. */
export function resolveCurrentTranscript(host: Pick<OmpHost, "sessionId" | "cwd">, candidates: readonly (string | null | undefined)[], read = (path: string) => readFileSync(path, "utf8")): { path: string; header: Record<string, unknown> } | null {
  const matches: { path: string; header: Record<string, unknown> }[] = [];
  for (const path of new Set(candidates.filter((path): path is string => typeof path === "string" && path !== ""))) {
    let raw: string;
    try { raw = read(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    // External transcripts may prepend metadata before their native header.
    // Inspect the complete file, but never choose between multiple headers.
    const headers: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const entry: unknown = JSON.parse(line);
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).type === "session") headers.push(entry as Record<string, unknown>);
    }
    if (headers.length > 1) throw new Error("multiple session headers in transcript; refusing to guess");
    const header = headers[0];
    if (header?.id === host.sessionId && header.cwd === host.cwd) matches.push({ path, header });
  }
  if (matches.length > 1) throw new Error("multiple transcripts identify the current session; refusing to guess");
  return matches[0] ?? null;
}

/** Compare the authenticated live header with the exact file, including fork
 * provenance; checking just a stale startup selector or just ID is insufficient. */
export function assertCurrentTranscriptHeader(header: Record<string, unknown>, value: unknown): void {
  const normalized = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalized);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalized(entry)]));
    return item;
  };
  const snapshot = value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
  if (JSON.stringify(normalized(snapshot?.header)) !== JSON.stringify(normalized(header))) throw new Error("authenticated current session header differs from transcript");
}

export function assertIdle(host: OmpHost, turn: TurnState | null): void {
  if (host.busy || host.inputRequired || turn === null || turn.status === "in_flight" || turn.needsContinuation || turn.unresolved.length > 0 || turn.pendingAtExit.length > 0) {
    throw new Error("deferred: busy, approval, unfinished turn or pending operations; retry when idle");
  }
}

/** Explicit paused-state handover; the view reader itself authenticates the
 * instance and rejects streams/UI requests/dropped frames before returning. */
export function assertPassiveIdle(host: OmpHost, turn: TurnState | null, value: unknown, processes: readonly { pid: number; argv: readonly string[] }[], now = Date.now()): void {
  const object = (item: unknown): Record<string, unknown> | null => item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const snapshot = object(value);
  const meta = object(snapshot?.meta);
  const header = object(snapshot?.header);
  const state = object(snapshot?.state);
  const model = object(state?.model);
  const refuse = (reason: string): never => { throw new Error(`passive handover deferred: ${reason}`); };
  if (!host.alive || host.busy || host.inputRequired || turn === null || turn.unresolved.length > 0 || turn.pendingAtExit.length > 0) refuse("host unavailable, busy, approval or pending operations");
  if (snapshot === null || meta === null || header === null || state === null || model === null) refuse("fresh authenticated view required");
  if (snapshot!.instanceId !== host.instanceId || snapshot!.sessionId !== host.sessionId || snapshot!.cwd !== host.cwd || meta!.pid !== host.pid || header!.type !== "session" || header!.version !== 3 || header!.id !== host.sessionId || header!.cwd !== host.cwd || state!.cwd !== host.cwd || model!.provider !== host.model.provider || model!.id !== host.model.id) refuse("view identity or current model changed");
  const age = typeof meta!.capturedAt === "string" ? now - Date.parse(meta!.capturedAt) : NaN;
  if (!Number.isFinite(age) || age < 0 || age > 5_000 || meta!.readOnly !== true || meta!.activeTools !== 0 || meta!.working !== false) refuse("view stale, writable or working");
  if (state!.isStreaming !== false || state!.isAborting !== false || state!.queuedMessageCount !== 0 || (snapshot!.stream !== undefined && snapshot!.stream !== null) || (snapshot!.uiRequest !== undefined && snapshot!.uiRequest !== null) || (snapshot!.droppedFrames !== undefined && snapshot!.droppedFrames !== 0)) refuse("view has streaming, approval or queued work");
  if (!processes.some(item => item.pid === host.pid)) refuse("original process tree unavailable");
  const children = processes.filter(item => item.pid !== host.pid);
  if (children.length > 1 || children.some(item => item.argv.length !== 3 || item.argv[0] !== "python3" || item.argv[1] !== "-m" || item.argv[2] !== "autoharness.stage_skill.server")) refuse("unknown or additional descendant process");
}

export interface HistoryCheckpoint { sessionId: string; sha256: string; entries: string[] }
const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

let nativeFlock: ((fd: number, operation: number) => number) | null = null;
function flock(fd: number, operation: number): number {
  if (nativeFlock === null) {
    const ffi = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
    const libc = ffi.dlopen("libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } });
    nativeFlock = (file, op) => libc.symbols.flock(file, op);
  }
  return nativeFlock(fd, operation);
}

/** Bun/Linux metadata locks are kernel-owned and released on process death.
 * Keep the separate lock inode: unlinking it would allow two inode owners. */
export function withStateFileLock<T>(path: string, write: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 2_000;
  if (process.platform === "linux") {
    if (!process.versions.bun) throw new Error("Linux metadata publication requires Bun flock support");
    const fd = openSync(lock, "a+", 0o600);
    try {
      while (flock(fd, 2 | 4) !== 0) {
        if (Date.now() >= deadline) throw new Error(`state file busy: ${lock}; retry publication`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return write();
    } finally { closeSync(fd); }
  }
  // Local Windows tests have no flock. Live deployment is Bun/Linux.
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o600); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report sharing/delete-pending contention as EPERM/EACCES.
      if (code !== "EEXIST" && !(process.platform === "win32" && (code === "EPERM" || code === "EACCES"))) throw error;
      if (Date.now() >= deadline) throw new Error(`state file locked: ${lock}; inspect holder before manual recovery`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return write();
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function recordRemapFile(path: string, oldId: string, newId: string): void {
  withStateFileLock(path, () => {
  let table: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.values(raw).some(value => typeof value !== "string")) throw new Error("invalid existing remap table");
    table = raw as Record<string, string>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  table[oldId] = newId;
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(table, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
  });
}

export async function publishMigration(oldId: string, newId: string, io: {
  adopt(id: string): void | Promise<void>;
  remap(oldId: string, newId: string): void | Promise<void>;
  bind(): Promise<void>;
}): Promise<void> {
  await io.adopt(newId);
  await io.remap(oldId, newId);
  await io.bind();
}

/** Strict JSONL identity and ordered entry hashes. Never guess a latest session. */
export function checkpointHistory(raw: string, sessionId: string): HistoryCheckpoint {
  const entries: string[] = [];
  let header = false;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.type === "session") {
      if (entry.id !== sessionId || header) throw new Error("transcript session identity mismatch");
      header = true;
    }
    entries.push(hash(JSON.stringify(entry)));
  }
  if (!header) throw new Error("missing verified session header");
  return { sessionId, sha256: hash(raw), entries };
}

export function verifyHistory(before: HistoryCheckpoint, raw: string): void {
  const after = checkpointHistory(raw, before.sessionId);
  let offset = 0;
  for (const entry of after.entries) if (entry === before.entries[offset]) offset++;
  if (offset !== before.entries.length) throw new Error("transcript history changed or lost entries; backup retained");
}

export interface MigrationRecord {
  version: 1;
  host: OmpHost;
  sessionFile: string;
  argv: string[];
  processStartTime?: string | null;
  /** Explicit consent to keep a proven quiescent interrupted turn paused. */
  passive?: boolean;
  phase: "prepared" | "stopping" | "stopped" | "launching" | "registered" | "complete";
  checkpoint: HistoryCheckpoint;
  paneId: string | null;
  newInstanceId?: string;
  error?: string;
}

/** One migrator globally; private atomic, fsynced checkpoints survive failure.
 * A crash-held lock is deliberately not guessed stale (PID reuse is unsafe). */
export function migrationStore(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const filename = (sessionId: string) => join(root, `${hash(sessionId)}.json`);
  return {
    lock(): () => void {
      const path = join(root, "migration.lock");
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fsyncSync(fd);
      syncDirectory(root);
      return () => { closeSync(fd); unlinkSync(path); };
    },
    read(sessionId: string): MigrationRecord | null {
      try { return JSON.parse(readFileSync(filename(sessionId), "utf8")) as MigrationRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    save(record: MigrationRecord): void {
      const path = filename(record.host.sessionId);
      const tmp = `${path}.${process.pid}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeFileSync(fd, JSON.stringify(record, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      syncDirectory(root);
    },
    backup(sessionId: string, raw: string, stopped = false): void {
      const path = `${filename(sessionId)}.${stopped ? "stopped." : ""}jsonl.backup`;
      let fd: number;
      try { fd = openSync(path, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && readFileSync(path, "utf8") === raw) return;
        throw error;
      }
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(root);
    },
  };
}

export interface HandoverIO {
  save(record: MigrationRecord): void;
  validateOld(): Promise<void>;
  createEmptyPane(): Promise<string>;
  preflight(paneId: string): Promise<void>;
  stopOld(): Promise<void>;
  oldAlive(): boolean;
  readHistory(): string;
  preserveStopped(raw: string): void;
  launch(paneId: string, argv: string[]): Promise<void>;
  registered(paneId: string): Promise<OmpHost>;
  publish(paneId: string, fresh: OmpHost): Promise<void>;
  closeEmpty(paneId: string): Promise<void>;
}

/** Only idle handovers. Once launch may have happened keep the pane for retry;
 * uncertain registration must never create another writer or kill that writer. */
export async function handover(record: MigrationRecord, io: HandoverIO): Promise<OmpHost> {
  try {
    if (record.phase === "prepared") {
      await io.validateOld();
      record.paneId ??= await io.createEmptyPane();
      io.save(record);
      await io.preflight(record.paneId);
      await io.validateOld();
      record.phase = "stopping";
      io.save(record);
    }
    if (record.phase === "stopping") {
      if (io.oldAlive()) { await io.validateOld(); io.save(record); await io.stopOld(); }
      if (io.oldAlive()) throw new Error("old process still alive; new reader blocked (no SIGKILL)");
      const stoppedHistory = io.readHistory();
      verifyHistory(record.checkpoint, stoppedHistory);
      io.preserveStopped(stoppedHistory);
      // Include the clean shutdown entries in the preservation checkpoint too.
      record.checkpoint = checkpointHistory(stoppedHistory, record.host.sessionId);
      record.phase = "stopped";
      io.save(record);
    }
    if (record.paneId === null) throw new Error("migration ledger has no prepared pane");
    if (record.phase === "stopped") {
      if (io.oldAlive()) throw new Error("old process is alive; refusing second writer");
      verifyHistory(record.checkpoint, io.readHistory());
      await io.preflight(record.paneId);
      record.phase = "launching";
      io.save(record);
      await io.launch(record.paneId, record.argv);
    }
    const fresh = await io.registered(record.paneId);
    if (io.oldAlive()) throw new Error("old process alive after launch; reconciliation required");
    verifyHistory(record.checkpoint, io.readHistory());
    record.newInstanceId = fresh.instanceId;
    record.phase = "registered";
    io.save(record);
    await io.publish(record.paneId, fresh);
    record.phase = "complete";
    delete record.error;
    io.save(record);
    return fresh;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    if (record.phase === "prepared" && record.paneId !== null) {
      await io.closeEmpty(record.paneId);
      record.paneId = null;
    }
    io.save(record);
    throw error;
  }
}
