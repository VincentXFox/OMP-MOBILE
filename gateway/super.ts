import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { listHosts, type OmpHost } from "./hosts.ts";
import { getPane, isPaneGone, listPanes, panePids, readPane, sendPaneKeys, sendPaneText, type ManagedPane } from "./panes.ts";
import type { PaneStatus } from "./runtime/protocol.ts";

const PROMPT_TIMEOUT_MS = 12_000;
// Пока ждём подтверждения старта, хвост панели перечитываем часто (сокет
// рантайма), а collab-реестр — редко: `omp collab list` это отдельный процесс.
const CONFIRM_POLL_MS = 250;
const CONFIRM_HOST_POLL_MS = 2_000;
const PROMPT_TAIL_LINES = 30;
const MAX_DISPATCH_ITEMS = 12;
// Задача уходит в панель одним куском текста: 64 КБ хватает любой разумной
// формулировке и держит запрос к рантайму небольшим.
const MAX_DISPATCH_TEXT_BYTES = 64 * 1024;
const MAX_SUBAGENTS = 24;
const SUBAGENT_TAIL_BYTES = 8 * 1024;
const SUBAGENT_TAIL_WIDE_BYTES = 256 * 1024;
const SUBAGENT_ACTIVE_MS = 90_000;
const ACTIVITY_TAIL_LINES = 48;

export type KnownAgentStatus = "idle" | "working" | "blocked" | "done";
export type AgentStatus = KnownAgentStatus | "unknown";

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
  /** paneId панели — цель раздачи задач. */
  target: string;
  /** Имя панели; для служебной или безымянной — заголовок сессии либо каталог. */
  name: string;
  agentStatus: AgentStatus;
  cwd: string;
  /** Заголовок панели — что агент делает прямо сейчас. */
  title: string;
  /** В панели живёт живой агент и он не ждёт подтверждения — туда можно вводить задачу. */
  interactiveReady: boolean;
  host: SuperHostInfo | null;
  subagents: SuperSubagent[];
}

export interface SuperBoard {
  agents: SuperAgent[];
  /** Collab-хосты без панели шлюза — запущены вне панелей шлюза. */
  orphans: { instanceId: string; cwd: string; sessionName: string | null; busy: boolean }[];
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDOVER_NAME = /^handover:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runtime handover names remain stable for retries; only their displayed label changes. */
export function superAgentName(pane: Pick<ManagedPane, "name" | "cwd">, host: Pick<OmpHost, "sessionTitle" | "sessionName"> | null): string {
  if (pane.name.trim() !== "" && !HANDOVER_NAME.test(pane.name)) return pane.name;
  for (const value of [host?.sessionTitle, host?.sessionName]) {
    const label = value?.trim() ?? "";
    if (label !== "" && !SESSION_UUID.test(label) && !HANDOVER_NAME.test(label)) return label;
  }
  return basename(pane.cwd) || pane.cwd;
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

// Панель ↔ collab-хост: точная привязка по `instanceId` (её ставит шлюз, когда
// поднимает агента), а без неё — по pid процесса в дереве панели. Каталог для
// сопоставления не годится: два агента в одном cwd — обычное дело.
async function matchHosts(panes: ManagedPane[], hosts: OmpHost[]): Promise<Map<string, OmpHost>> {
  const matched = new Map<string, OmpHost>();
  const taken = new Set<string>();
  for (const pane of panes) {
    const bound = pane.instanceId === null ? undefined : hosts.find((h) => h.instanceId === pane.instanceId && !taken.has(h.instanceId));
    if (bound !== undefined) {
      matched.set(pane.paneId, bound);
      taken.add(bound.instanceId);
      continue;
    }
    const free = hosts.filter((h) => !taken.has(h.instanceId));
    if (free.length === 0) continue;
    let pids: number[];
    try {
      pids = await panePids(pane.paneId);
    } catch (error) {
      if (isPaneGone(error)) continue;
      throw error;
    }
    const byPid = free.find((h) => pids.includes(h.pid));
    if (byPid !== undefined) {
      matched.set(pane.paneId, byPid);
      taken.add(byPid.instanceId);
    }
  }
  return matched;
}

async function hostOfPane(pane: ManagedPane, hosts: OmpHost[]): Promise<OmpHost | null> {
  return (await matchHosts([pane], hosts)).get(pane.paneId) ?? null;
}

// Состояние агента живёт в collab-реестре: рантайм про collab ничего не знает,
// а статус панели описывает лишь её собственную оболочку. Хоста нет, а в панели
// `shell` — агент отработал и вернул оболочку: это «завершено», а не «неизвестно».
// `unknown` остаётся панели, которая ещё поднимается (`starting`) или зависла.
function agentStatusOf(host: OmpHost | null, paneStatus: PaneStatus): AgentStatus {
  if (host === null) return paneStatus === "shell" ? "done" : "unknown";
  if (host.busy) return "working";
  if (host.inputRequired) return "blocked";
  return "idle";
}

export async function superBoard(): Promise<SuperBoard> {
  const [panes, collab] = await Promise.all([
    listPanes(),
    listHosts().catch(() => ({ hosts: [] as OmpHost[] })),
  ]);
  const matched = await matchHosts(panes, collab.hosts);

  const agents: SuperAgent[] = panes.map((pane) => {
    const host = matched.get(pane.paneId) ?? null;
    return {
      target: pane.paneId,
      name: superAgentName(pane, host),
      agentStatus: agentStatusOf(host, pane.status),
      cwd: pane.cwd,
      title: pane.title ?? "",
      // «Готов принимать ввод» — в панели живёт живой агент и он не ждёт
      // подтверждения: свободная оболочка означает, что агент завершился.
      interactiveReady: host !== null && host.alive && !host.inputRequired,
      host: host === null ? null : toHostInfo(host),
      subagents: host === null ? [] : listSubagents(pane.cwd, host.sessionId),
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

// Гейт перед вводом в панель: без живого агента на переднем плане работает
// `bash -i`, и текст задания исполнился бы как shell-команда (вплоть до `rm -rf`).
// Поэтому любой ввод требует живого collab-хоста у панели.
function liveAgentError(pane: ManagedPane, host: OmpHost | null): string | null {
  if (host !== null && host.alive) return null;
  if (pane.status === "shell") {
    return "агент в панели не запущен — запустите или продолжите сессию; задача не отправлена";
  }
  if (host !== null) return "агент завершил работу — запустите или продолжите сессию; задача не отправлена";
  return "агент не зарегистрирован в реестре; задача не отправлена";
}

// Отправка задачи в панель: состояние агента берём из collab-реестра, текст
// вводим в панель, затем подтверждаем старт — либо агент стал busy, либо текст
// виден в хвосте панели. Сверхбыстрый турн завершается раньше, чем шлюз успевает
// увидеть busy, и тогда факт доставки решает хвост.
async function dispatchOne(item: DispatchAssignment): Promise<DispatchOutcome> {
  const pane = await getPane(item.target);
  if (pane === null) return { target: item.target, ok: false, error: "агент не найден" };
  const hosts = await listHosts().catch(() => ({ hosts: [] as OmpHost[] }));
  const host = await hostOfPane(pane, hosts.hosts);
  const noAgent = liveAgentError(pane, host);
  if (noAgent !== null) return { target: item.target, ok: false, error: noAgent };
  if (pane.awaitingApproval === true || host?.inputRequired === true) {
    return { target: item.target, ok: false, error: "агент ждёт ввода (blocked) — задача не отправлена" };
  }
  const busyBefore = host?.busy === true;
  try {
    await sendPaneText(item.target, item.text);
    await sendPaneKeys(item.target, ["enter"]);
  } catch (error) {
    return { target: item.target, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
  // Агент уже в работе: новый турн стартует лишь после текущего, и ждать
  // подтверждения нечего — текст принят панелью.
  if (busyBefore) return { target: item.target, ok: true };
  return confirmDispatch(pane, item);
}

// Подтверждение, что промпт принят: busy в collab-реестре (опрос редкий —
// `omp collab list` это отдельный процесс) или текст в хвосте панели.
async function confirmDispatch(pane: ManagedPane, item: DispatchAssignment): Promise<DispatchOutcome> {
  const deadline = Date.now() + PROMPT_TIMEOUT_MS;
  let nextHostCheck = 0;
  let tailReadable = true;
  for (;;) {
    if (Date.now() >= nextHostCheck) {
      nextHostCheck = Date.now() + CONFIRM_HOST_POLL_MS;
      const hosts = await listHosts().catch(() => ({ hosts: [] as OmpHost[] }));
      if ((await hostOfPane(pane, hosts.hosts))?.busy === true) return { target: item.target, ok: true };
    }
    const visible = await promptVisibleInTail(item.target, item.text);
    if (visible === true) return { target: item.target, ok: true };
    if (visible === null) tailReadable = false;
    if (Date.now() >= deadline) break;
    await Bun.sleep(CONFIRM_POLL_MS);
  }
  if (!tailReadable) return { target: item.target, ok: false, error: "таймаут подтверждения — задача возможно принята, проверь доску" };
  return { target: item.target, ok: false, error: "агент не подтвердил старт задачи — возможно ещё инициализируется, повтори" };
}

// Поиск без учёта пробелов: TUI переносит промпт по строкам. `null` — хвост
// прочитать не удалось, и судить о доставке не по чему.
async function promptVisibleInTail(target: string, text: string): Promise<boolean | null> {
  const needle = text.replaceAll(/\s+/g, " ").trim().slice(0, 80);
  if (needle === "") return false;
  try {
    const tail = await readPane(target, "text", PROMPT_TAIL_LINES);
    return tail.replaceAll(/\s+/g, " ").includes(needle);
  } catch {
    return null;
  }
}

export function dispatchTasks(items: DispatchAssignment[]): Promise<DispatchOutcome[]> {
  return Promise.all(items.map(dispatchOne));
}

export interface SuperActivity {
  /** paneId панели — то же значение, что `target` на доске. */
  target: string;
  agentStatus: AgentStatus;
  title: string;
  cwd: string;
  name: string;
  tail: string;
  subagents: SuperSubagent[];
}

export async function superActivity(target: string): Promise<SuperActivity | null> {
  const pane = await getPane(target);
  if (pane === null) return null;
  const collab = await listHosts().catch(() => ({ hosts: [] as OmpHost[] }));
  const host = await hostOfPane(pane, collab.hosts);
  let tail: string;
  try {
    tail = await readPane(target, "text", ACTIVITY_TAIL_LINES);
  } catch (error) {
    tail = `не удалось прочитать терминал: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    target: pane.paneId,
    agentStatus: agentStatusOf(host, pane.status),
    title: pane.title ?? "",
    cwd: pane.cwd,
    name: superAgentName(pane, host),
    tail: tail.slice(-16 * 1024),
    subagents: host === null ? [] : listSubagents(pane.cwd, host.sessionId),
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
