import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listHosts } from "./hosts.ts";
import type { OmpHost } from "./hosts.ts";
import { runHerdr, unwrapHerdr } from "./agents.ts";

const SPAWN_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_CAP_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
export const MAX_TERMINAL_TEXT_BYTES = 8 * 1024;

// send-keys accepts single chars and short tokens ([a-zA-Z0-9-]) plus these named keys.
const KNOWN_KEY_NAMES: Record<string, true> = {
  enter: true,
  esc: true,
  space: true,
  tab: true,
  up: true,
  down: true,
  left: true,
  right: true,
  "ctrl+c": true,
};

async function runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  void Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    },
  );
  return promise;
}

export function truncateError(stderr: string): string {
  const text = stderr.trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

interface HerdrAgentRecord {
  agent: string;
  cwd: string;
  paneId: string;
}

function parseHerdrAgents(result: unknown): HerdrAgentRecord[] {
  if (result === null || typeof result !== "object") return [];
  const parsed = result as { agents?: unknown }; // herdr CLI envelope, shape asserted here
  const agents = parsed.agents;
  if (!Array.isArray(agents)) return [];
  const out: HerdrAgentRecord[] = [];
  for (const entry of agents) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as { agent?: unknown; cwd?: unknown; pane_id?: unknown };
    if (typeof rec.agent !== "string" || typeof rec.cwd !== "string" || typeof rec.pane_id !== "string") continue;
    out.push({ agent: rec.agent, cwd: rec.cwd, paneId: rec.pane_id });
  }
  return out;
}

// Pids of processes currently running in the pane (foreground group id + foreground processes).
function parsePanePids(result: unknown): number[] {
  if (result === null || typeof result !== "object") return [];
  const wrapper = result as { process_info?: unknown }; // herdr CLI envelope, shape asserted here
  const info = wrapper.process_info;
  if (info === null || typeof info !== "object") return [];
  const parsed = info as { foreground_process_group_id?: unknown; foreground_processes?: unknown };
  const pids: number[] = [];
  if (typeof parsed.foreground_process_group_id === "number") pids.push(parsed.foreground_process_group_id);
  if (Array.isArray(parsed.foreground_processes)) {
    for (const entry of parsed.foreground_processes) {
      if (entry === null || typeof entry !== "object") continue;
      const proc = entry as { pid?: unknown };
      if (typeof proc.pid === "number") pids.push(proc.pid);
    }
  }
  return pids;
}

// Map a collab-registry host to its herdr pane. `herdr agent list` has no pid field,
// so candidates are matched by cwd; when several omp agents share a cwd the instance's
// pid disambiguates via the pane's foreground process info.
async function findHerdrPane(host: OmpHost): Promise<string | null> {
  const listed = unwrapHerdr(await runHerdr(["agent", "list"], SPAWN_TIMEOUT_MS));
  if (!listed.ok) throw new Error(`herdr agent list failed: ${listed.error}`);
  const candidates = parseHerdrAgents(listed.result).filter((a) => a.agent === "omp" && a.cwd === host.cwd);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].paneId;
  for (const candidate of candidates) {
    const info = unwrapHerdr(await runHerdr(["pane", "process-info", "--pane", candidate.paneId], SPAWN_TIMEOUT_MS));
    if (info.ok && parsePanePids(info.result).includes(host.pid)) return candidate.paneId;
  }
  return candidates[0].paneId;
}

type PaneResolution =
  | { kind: "ok"; paneId: string }
  | { kind: "not_found"; error: string }
  | { kind: "not_herdr" }
  | { kind: "failed"; error: string };

async function resolvePane(instanceId: string): Promise<PaneResolution> {
  let host: OmpHost | undefined;
  try {
    host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (!host) return { kind: "not_found", error: "host not found" };
  try {
    const paneId = await findHerdrPane(host);
    if (paneId === null) return { kind: "not_herdr" };
    return { kind: "ok", paneId };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export type TerminalRead =
  | { kind: "ok"; paneId: string; text: string }
  | { kind: "not_found"; error: string }
  | { kind: "not_herdr" }
  | { kind: "failed"; error: string };

export async function readTerminal(instanceId: string): Promise<TerminalRead> {
  const pane = await resolvePane(instanceId);
  if (pane.kind !== "ok") return pane;
  const read = unwrapHerdr(await runHerdr(["pane", "read", pane.paneId], SPAWN_TIMEOUT_MS));
  if (!read.ok) return { kind: "failed", error: `herdr pane read failed: ${truncateError(read.error)}` };
  const text = typeof read.result === "string" ? read.result : read.result === null || read.result === undefined ? "" : JSON.stringify(read.result);
  return { kind: "ok", paneId: pane.paneId, text };
}

export type TerminalSend =
  | { kind: "ok" }
  | { kind: "bad_key"; error: string }
  | { kind: "not_found"; error: string }
  | { kind: "not_herdr" }
  | { kind: "failed"; error: string };

export async function sendTerminalKeys(instanceId: string, keys: string[]): Promise<TerminalSend> {
  const bad = keys.find((key) => !/^[a-zA-Z0-9-]+$/.test(key) && KNOWN_KEY_NAMES[key] !== true);
  if (bad !== undefined) return { kind: "bad_key", error: `unsupported key: ${bad}` };
  const pane = await resolvePane(instanceId);
  if (pane.kind !== "ok") return pane;
  const sent = unwrapHerdr(await runHerdr(["pane", "send-keys", pane.paneId, ...keys], SPAWN_TIMEOUT_MS));
  if (!sent.ok) return { kind: "failed", error: `herdr pane send-keys failed: ${truncateError(sent.error)}` };
  return { kind: "ok" };
}

export async function sendTerminalText(instanceId: string, text: string): Promise<TerminalSend> {
  const pane = await resolvePane(instanceId);
  if (pane.kind !== "ok") return pane;
  const sent = unwrapHerdr(await runHerdr(["pane", "send-text", pane.paneId, text], SPAWN_TIMEOUT_MS));
  if (!sent.ok) return { kind: "failed", error: `herdr pane send-text failed: ${truncateError(sent.error)}` };
  return { kind: "ok" };
}

export interface ProjectEntry {
  name: string;
  type: "dir" | "file";
  size: number;
}

export interface ProjectListing {
  entries: ProjectEntry[];
  hasGit: boolean;
}

export function listProjectFiles(dir: string): ProjectListing {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const entries: ProjectEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue; // hidden files are skipped; .git is reported via hasGit
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, type: "dir", size: 0 });
      continue;
    }
    let size = 0;
    try {
      size = statSync(join(dir, dirent.name)).size;
    } catch {
      size = 0; // vanished between readdir and stat
    }
    entries.push({ name: dirent.name, type: "file", size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), hasGit: existsSync(join(dir, ".git")) };
}

export type GitOutcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; error: string };

export async function projectGit(dir: string, mode: "status" | "diff"): Promise<GitOutcome> {
  const args = mode === "status" ? ["-C", dir, "status", "--porcelain=v1"] : ["-C", dir, "diff", "--unified=2"];
  const res = await runGit(args);
  if (res.code !== 0) return { kind: "failed", error: `git ${mode} failed: ${truncateError(res.stderr || res.stdout)}` };
  let text = res.stdout;
  if (Buffer.byteLength(text, "utf8") > GIT_OUTPUT_CAP_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, GIT_OUTPUT_CAP_BYTES).toString("utf8");
  }
  return { kind: "ok", text };
}
