import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runHerdr, unwrapHerdr } from "./agents.ts";
import { listHosts, type OmpHost } from "./hosts.ts";

const SPAWN_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 12_000;
const MAX_DISPATCH_ITEMS = 12;
// Kernel caps a single argv element at 128KB (MAX_ARG_STRLEN); herdr prompt passes
// the text as one argument, so 64KB leaves a 2x margin.
const MAX_DISPATCH_TEXT_BYTES = 64 * 1024;
const MAX_SUBAGENTS = 24;
const SUBAGENT_TAIL_BYTES = 8 * 1024;
const SUBAGENT_TAIL_WIDE_BYTES = 256 * 1024;
const SUBAGENT_ACTIVE_MS = 90_000;
const ACTIVITY_TAIL_LINES = 48;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** A subagent transcript found next to the host session (`<Name>.jsonl`). */
export interface SuperSubagent {
  name: string;
  sizeBytes: number;
  updatedAt: number;
  active: boolean;
  state: "working" | "done" | "unknown";
  activity: string;
}

/** Host-side session details merged from `omp collab list`. */
export interface SuperHostInfo {
  instanceId: string;
  sessionId: string;
  sessionName: string | null;
  model: { provider: string; id: string };
  startedAt: number;
  relayConnected: boolean;
  inputRequired: boolean;
  busy: boolean;
}

export interface SuperAgent {
  /** herdr pane id — the dispatch target ("w1:p1"). */
  target: string;
  /** herdr agent name ("demo-omp"). */
  name: string;
  agentStatus: AgentStatus;
  cwd: string;
  /** Stripped terminal title — what the agent is doing right now. */
  title: string;
  interactiveReady: boolean;
  host: SuperHostInfo | null;
  subagents: SuperSubagent[];
}

export interface SuperBoard {
  agents: SuperAgent[];
  /** Collab hosts with no herdr pane (started outside herdr). */
  orphans: { instanceId: string; cwd: string; sessionName: string | null; busy: boolean }[];
}

interface HerdrAgentRecord {
  agent: string;
  name: string;
  agentStatus: AgentStatus;
  cwd: string;
  paneId: string;
  title: string;
  interactiveReady: boolean;
}

function parseAgentList(result: unknown): HerdrAgentRecord[] {
  if (result === null || typeof result !== "object") return [];
  const parsed = result as { agents?: unknown }; // herdr CLI envelope, shape asserted here
  const agents = parsed.agents;
  if (!Array.isArray(agents)) return [];
  const out: HerdrAgentRecord[] = [];
  for (const entry of agents) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.agent !== "string" || typeof rec.name !== "string" || typeof rec.cwd !== "string") continue;
    if (typeof rec.pane_id !== "string") continue;
    const status = typeof rec.agent_status === "string" ? rec.agent_status : "unknown";
    out.push({
      agent: rec.agent,
      name: rec.name,
      agentStatus: (["idle", "working", "blocked", "done"] as const).includes(status as AgentStatus)
        ? (status as AgentStatus)
        : "unknown",
      cwd: rec.cwd,
      paneId: rec.pane_id,
      title: typeof rec.terminal_title_stripped === "string" ? rec.terminal_title_stripped : "",
      interactiveReady: rec.interactive_ready === true,
    });
  }
  return out;
}

function panePids(result: unknown): number[] {
  if (result === null || typeof result !== "object") return [];
  const info = (result as { process_info?: unknown }).process_info;
  if (info === null || typeof info !== "object") return [];
  const parsed = info as { foreground_process_group_id?: unknown; foreground_processes?: unknown };
  const pids: number[] = [];
  if (typeof parsed.foreground_process_group_id === "number") pids.push(parsed.foreground_process_group_id);
  if (Array.isArray(parsed.foreground_processes)) {
    for (const entry of parsed.foreground_processes) {
      if (entry !== null && typeof entry === "object") {
        const pid = (entry as { pid?: unknown }).pid;
        if (typeof pid === "number") pids.push(pid);
      }
    }
  }
  return pids;
}

function toHostInfo(host: OmpHost): SuperHostInfo {
  return {
    instanceId: host.instanceId,
    sessionId: host.sessionId,
    sessionName: host.sessionName,
    model: host.model,
    startedAt: host.startedAt,
    relayConnected: host.relayConnected,
    inputRequired: host.inputRequired,
    busy: host.busy,
  };
}

// omp writes sessions under ~/.omp/agent/sessions/<cwd with / → ->>/<ts>_<sessionId>.jsonl;
// subagent transcripts live in a same-named directory as <AgentName>.jsonl.
function sessionPathsFor(cwd: string, sessionId: string): { transcript: string; dir: string | null } {
  const dir = join(homedir(), ".omp", "agent", "sessions", cwd.replaceAll("/", "-"));
  let transcript: string | null = null;
  let subDir: string | null = null;
  if (existsSync(dir)) {
    const suffix = `_${sessionId}`;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(suffix)) continue;
      if (entry.endsWith(".jsonl")) transcript = join(dir, entry);
      else subDir = join(dir, entry);
    }
  }
  return { transcript: transcript ?? "", dir: subDir };
}

// Last meaningful event decides what the subagent is doing: tool calls → working,
// plain text tail → done/unknown by freshness. Tail-only read; when the window lands
// mid-line of a huge event, retry once with a much larger window.
function subagentActivity(transcript: string, sizeBytes: number): { state: SuperSubagent["state"]; activity: string } {
  const readBytes = Math.min(SUBAGENT_TAIL_BYTES, sizeBytes);
  if (readBytes <= 0) return { state: "unknown", activity: "" };
  const first = parseTail(transcript, sizeBytes, readBytes);
  if (first !== null) return first;
  if (sizeBytes <= readBytes) return { state: "unknown", activity: "" };
  return parseTail(transcript, sizeBytes, Math.min(SUBAGENT_TAIL_WIDE_BYTES, sizeBytes)) ?? { state: "unknown", activity: "" };
}

function readTail(transcript: string, sizeBytes: number, readBytes: number): string | null {
  try {
    const fd = openSync(transcript, "r");
    try {
      const buf = Buffer.alloc(readBytes);
      const read = readSync(fd, buf, 0, readBytes, sizeBytes - readBytes);
      return buf.toString("utf8", 0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseTail(transcript: string, sizeBytes: number, readBytes: number): { state: SuperSubagent["state"]; activity: string } | null {
  const text = readTail(transcript, sizeBytes, readBytes);
  if (text === null) return null;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    let event: unknown;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue; // truncated first line of the tail
    }
    if (event === null || typeof event !== "object") continue;
    const rec = event as Record<string, unknown>;
    if (rec.type === "toolCall") {
      const args = rec.arguments !== null && typeof rec.arguments === "object" ? (rec.arguments as Record<string, unknown>) : undefined;
      const intent = typeof args?.i === "string" ? args.i : "";
      return { state: "working", activity: `${String(rec.name)}${intent ? `: ${intent}` : ""}` };
    }
    if (rec.type === "custom" && rec.customType === "tool_execution_start") {
      const data = rec.data !== null && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : undefined;
      const intent = typeof data?.intent === "string" ? data.intent : "";
      return { state: "working", activity: `${String(data?.toolName ?? "tool")}${intent ? `: ${intent}` : ""}` };
    }
    if (rec.type === "message" && rec.message !== null && typeof rec.message === "object") {
      const message = rec.message as Record<string, unknown>;
      if (message.role === "toolResult" && typeof message.toolName === "string") {
        return { state: "working", activity: `${message.toolName}: выполняется` };
      }
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part === null || typeof part !== "object") continue;
        const block = part as Record<string, unknown>;
        if (block.type !== "text" || typeof block.text !== "string") continue;
        const snippet = block.text.trim().replaceAll("\n", " ");
        return { state: "unknown", activity: snippet.slice(0, 200) };
      }
    }
  }
  return null; // no complete event in the window — caller retries with a wider one
}

function listSubagents(cwd: string, sessionId: string): SuperSubagent[] {
  const { dir } = sessionPathsFor(cwd, sessionId);
  if (dir === null || !existsSync(dir)) return [];
  const out: SuperSubagent[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const transcript = join(dir, entry);
    let sizeBytes = 0;
    let updatedAt = 0;
    try {
      const st = statSync(transcript);
      if (!st.isFile()) continue;
      sizeBytes = st.size;
      updatedAt = st.mtimeMs;
    } catch {
      continue;
    }
    const { state, activity } = subagentActivity(transcript, sizeBytes);
    out.push({
      name: entry.slice(0, -".jsonl".length),
      sizeBytes,
      updatedAt,
      active: Date.now() - updatedAt < SUBAGENT_ACTIVE_MS,
      state,
      activity,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, MAX_SUBAGENTS);
}

// herdr agent list has no pid; agents sharing a cwd are disambiguated by the pane's
// foreground pids vs the collab host pid (same trick as files.findHerdrPane).
async function matchHosts(records: HerdrAgentRecord[], hosts: OmpHost[]): Promise<Map<string, OmpHost>> {
  const matched = new Map<string, OmpHost>();
  const taken = new Set<string>();
  for (const rec of records) {
    if (rec.agent !== "omp") continue;
    const candidates = hosts.filter((h) => h.cwd === rec.cwd && !taken.has(h.instanceId));
    let host = candidates.length === 1 ? candidates[0] : undefined;
    if (!host && candidates.length > 1) {
      const info = unwrapHerdr(await runHerdr(["pane", "process-info", "--pane", rec.paneId], SPAWN_TIMEOUT_MS));
      if (info.ok) {
        const pids = new Set(panePids(info.result));
        host = candidates.find((h) => pids.has(h.pid));
      }
    }
    if (host) {
      matched.set(rec.paneId, host);
      taken.add(host.instanceId);
    }
  }
  return matched;
}

export async function superBoard(): Promise<SuperBoard> {
  const [listed, collab] = await Promise.all([
    runHerdr(["agent", "list"], SPAWN_TIMEOUT_MS).then(unwrapHerdr),
    listHosts().catch(() => ({ hosts: [] as OmpHost[] })),
  ]);
  if (!listed.ok) throw new Error(`herdr agent list failed: ${listed.error}`);
  const records = parseAgentList(listed.result).filter((r) => r.agent === "omp");
  const matched = await matchHosts(records, collab.hosts);

  const agents: SuperAgent[] = records.map((rec) => {
    const host = matched.get(rec.paneId);
    return {
      target: rec.paneId,
      name: rec.name,
      agentStatus: rec.agentStatus,
      cwd: rec.cwd,
      title: rec.title,
      interactiveReady: rec.interactiveReady,
      host: host ? toHostInfo(host) : null,
      subagents: host ? listSubagents(rec.cwd, host.sessionId) : [],
    };
  });

  const used = new Set(agents.map((a) => a.host?.instanceId).filter((id): id is string => id !== undefined));
  const orphans = collab.hosts
    .filter((h) => !used.has(h.instanceId))
    .map((h) => ({ instanceId: h.instanceId, cwd: h.cwd, sessionName: h.sessionName, busy: h.busy }));
  return { agents, orphans };
}

export interface DispatchAssignment {
  target: string;
  text: string;
}

export type DispatchOutcome = { target: string; ok: true } | { target: string; ok: false; error: string };

// herdr agent prompt guards submission: blocked agents are rejected (agent_blocked)
// before any keystrokes reach the pane; --wait confirms the agent actually started.
// Ultra-fast turns finish before herdr observes "working" (agent_prompt_stalled);
// then the terminal tail decides whether the prompt actually landed.
async function dispatchOne(item: DispatchAssignment): Promise<DispatchOutcome> {
  const out = await runHerdr(
    ["agent", "prompt", item.target, item.text, "--wait", "--until", "working", "--timeout", String(PROMPT_TIMEOUT_MS)],
    SPAWN_TIMEOUT_MS,
  );
  const unwrapped = unwrapHerdr(out);
  if (unwrapped.ok) return { target: item.target, ok: true };
  const err = unwrapped.error;
  if (err.includes("agent_prompt_stalled")) {
    if (await promptVisibleInTail(item.target, item.text)) return { target: item.target, ok: true };
    return { target: item.target, ok: false, error: "агент не подтвердил старт задачи — возможно ещё инициализируется, повтори" };
  }
  if (err.includes("agent_blocked")) return { target: item.target, ok: false, error: "агент ждёт ввода (blocked) — задача не отправлена" };
  if (/not found|no such|unknown/i.test(err)) return { target: item.target, ok: false, error: "агент не найден" };
  if (err.includes("timeout")) return { target: item.target, ok: false, error: "таймаут подтверждения — задача возможно принята, проверь доску" };
  return { target: item.target, ok: false, error: err.slice(0, 300) };
}

// Whitespace-insensitive search: the TUI may wrap the prompt across lines.
async function promptVisibleInTail(target: string, text: string): Promise<boolean> {
  const read = unwrapHerdr(await runHerdr(["agent", "read", target, "--lines", "30", "--format", "text"], SPAWN_TIMEOUT_MS));
  if (!read.ok || typeof read.result !== "string") return false;
  const needle = text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
  if (needle === "") return false;
  return read.result.replaceAll(/\s+/g, " ").includes(needle);
}

export function dispatchTasks(items: DispatchAssignment[]): Promise<DispatchOutcome[]> {
  return Promise.all(items.map(dispatchOne));
}

export interface SuperActivity {
  target: string;
  agentStatus: AgentStatus;
  title: string;
  cwd: string;
  name: string;
  tail: string;
  subagents: SuperSubagent[];
}

export async function superActivity(target: string): Promise<SuperActivity | null> {
  const got = unwrapHerdr(await runHerdr(["agent", "get", target], SPAWN_TIMEOUT_MS));
  if (!got.ok) {
    if (/not found|no such|unknown/i.test(got.error)) return null;
    throw new Error(got.error);
  }
  // agent get prints {agent: {...record}} while agent list prints bare records.
  const result = got.result;
  const inner =
    result !== null && typeof result === "object" && (result as Record<string, unknown>).agent !== undefined
      ? (result as Record<string, unknown>).agent
      : result;
  const parsed = parseAgentList({ agents: [inner] });
  const rec = parsed[0];
  if (!rec) return null;

  const read = unwrapHerdr(await runHerdr(["agent", "read", target, "--lines", String(ACTIVITY_TAIL_LINES), "--format", "text"], SPAWN_TIMEOUT_MS));
  const tail = read.ok ? (typeof read.result === "string" ? read.result : JSON.stringify(read.result)) : `не удалось прочитать терминал: ${read.error}`;

  const collab = await listHosts().catch(() => ({ hosts: [] as OmpHost[] }));
  const matched = await matchHosts([rec], collab.hosts);
  const host = matched.get(rec.paneId);

  return {
    target: rec.paneId,
    agentStatus: rec.agentStatus,
    title: rec.title,
    cwd: rec.cwd,
    name: rec.name,
    tail: tail.slice(-16 * 1024),
    subagents: host ? listSubagents(rec.cwd, host.sessionId) : [],
  };
}

export function validateDispatchItems(value: unknown): { items: DispatchAssignment[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "items must be an array" };
  if (value.length === 0) return { error: "items must not be empty" };
  if (value.length > MAX_DISPATCH_ITEMS) return { error: `too many items (max ${MAX_DISPATCH_ITEMS})` };
  const items: DispatchAssignment[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return { error: "each item must be an object" };
    const rec = entry as Record<string, unknown>;
    if (typeof rec.target !== "string" || !/^[\w:@.-]+$/.test(rec.target)) return { error: "invalid target" };
    if (typeof rec.text !== "string" || rec.text.trim() === "") return { error: "text required" };
    if (Buffer.byteLength(rec.text, "utf8") > MAX_DISPATCH_TEXT_BYTES) return { error: "text too large (max 64KB)" };
    items.push({ target: rec.target, text: rec.text });
  }
  return { items };
}
