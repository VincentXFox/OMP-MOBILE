import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Session store layout: ~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl */
const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
const HEAD_BYTES = 2048;
const TAIL_BYTES = 16_384;

export type SessionStatus = "live" | "complete" | "aborted" | "error" | "interrupted" | "unknown";

export interface SessionSummary {
  id: string;
  path: string;
  projectSlug: string;
  cwd: string | null;
  title: string | null;
  status: SessionStatus;
  modified: number;
  size: number;
}

/** Read a byte slice without loading the whole (potentially huge) session file. */
function readSlice(path: string, start: number, length: number): { text: string; whole: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(length, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8"), whole: size <= length };
  } finally {
    closeSync(fd);
  }
}

function parseHead(head: string): { id: string | null; cwd: string | null; title: string | null } {
  let id: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj === null || typeof obj !== "object") continue;
      const rec = obj as { type?: unknown; id?: unknown; cwd?: unknown; title?: unknown };
      if (rec.type === "session") {
        if (typeof rec.id === "string") id = rec.id;
        if (typeof rec.cwd === "string") cwd = rec.cwd;
      }
      if (rec.type === "title" && typeof rec.title === "string") title = rec.title;
      if (id !== null && title !== null) break;
    } catch {
      // skip malformed head line
    }
  }
  return { id, cwd, title };
}

/**
 * Update victims died mid-process: no session_exit record in the tail.
 * Scan backwards; first decisive marker wins.
 */
function statusFromTail(tail: string, whole: boolean): SessionStatus {
  const lines = tail.split("\n");
  if (!whole) lines.shift(); // drop the partial first line of the slice
  let sawTurn = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object") continue;
    const rec = obj as {
      type?: unknown;
      customType?: unknown;
      message?: { stopReason?: unknown } | null;
    };
    if (rec.type === "custom" && rec.customType === "session_exit") return "complete";
    if (rec.type === "message" && rec.message !== null && typeof rec.message === "object") {
      sawTurn = true;
      const stop = rec.message.stopReason;
      if (stop === "aborted") return "aborted";
      if (stop === "error") return "error";
    }
  }
  return sawTurn ? "interrupted" : "unknown";
}

export function listSessions(liveIds: ReadonlySet<string>): SessionSummary[] {
  let slugs: string[];
  try {
    slugs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const slug of slugs) {
    const dir = join(SESSIONS_DIR, slug);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      let stat: { size: number; mtimeMs: number };
      try {
        const s = statSync(path);
        if (!s.isFile()) continue;
        stat = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        continue;
      }
      const head = parseHead(readSlice(path, 0, HEAD_BYTES).text);
      const id = head.id ?? file.match(/_([0-9a-fA-F-]{36})\.jsonl$/)?.[1] ?? file.replace(/\.jsonl$/, "");
      const status: SessionStatus = liveIds.has(id)
        ? "live"
        : statusFromTail(readSlice(path, Math.max(0, stat.size - TAIL_BYTES), TAIL_BYTES).text, stat.size <= TAIL_BYTES);
      out.push({ id, path, projectSlug: slug, cwd: head.cwd, title: head.title, status, modified: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}
