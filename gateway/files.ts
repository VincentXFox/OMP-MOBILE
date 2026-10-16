import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listHosts } from "./hosts.ts";
import type { OmpHost } from "./hosts.ts";
import { runHerdr, unwrapHerdr } from "./agents.ts";
import { resolveBin } from "./bins.ts";

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
  // Проверено вживую (w3:pJ, «a-b.c_d»): эти символы send-keys принимает
  // как обычные клавиши.
  "-": true,
  ".": true,
  _: true,
};

// Символ → именованная клавиша herdr («/» должен открывать slash-меню omp).
const CHAR_KEY_ALIASES: Record<string, string> = {
  "/": "slash",
  " ": "space",
};

/** Печатаемые ASCII → клавиши herdr; не-ASCII/управляющие — null. */
function textToKeys(text: string): string[] | null {
  const keys: string[] = [];
  for (const ch of text) {
    const alias = CHAR_KEY_ALIASES[ch];
    if (alias !== undefined) keys.push(alias);
    else if (/^[\x21-\x7e]$/.test(ch)) keys.push(ch);
    else return null;
  }
  return keys.length === 0 ? null : keys;
}

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

// Посимвольный набор: печатаемые ASCII — как клавиши, «/» и пробел — именованные.
export async function sendTerminalChars(instanceId: string, text: string): Promise<TerminalSend> {
  const keys = textToKeys(text);
  if (keys === null) return { kind: "bad_key", error: "empty text or unsupported char" };
  const pane = await resolvePane(instanceId);
  if (pane.kind !== "ok") return pane;
  const sent = unwrapHerdr(await runHerdr(["pane", "send-keys", pane.paneId, ...keys], SPAWN_TIMEOUT_MS));
  if (!sent.ok) return { kind: "failed", error: `herdr pane send-keys failed: ${truncateError(sent.error)}` };
  return { kind: "ok" };
}

// ---- настройки чата (модель + уровень усилия) ----

export interface AgentModelOption {
  selector: string;
  name: string;
  thinking: string[];
  contextWindow: number;
}

export interface AgentChatSettings {
  model: { provider: string; id: string } | null;
  thinking: string | null;
  models: AgentModelOption[];
}

export type AgentSettingsOutcome =
  | { kind: "ok"; settings: AgentChatSettings }
  | { kind: "not_found"; error: string }
  | { kind: "not_herdr" }
  | { kind: "bad_request"; error: string }
  | { kind: "failed"; error: string };

/** Чтение настроек не бывает bad_request — узкий тип для GET-роута. */
export type AgentSettingsRead = Exclude<AgentSettingsOutcome, { kind: "bad_request" }>;

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache: { at: number; entries: AgentModelOption[] } | null = null;

async function runOmpModels(): Promise<AgentModelOption[]> {
  let ompBin: string;
  try {
    ompBin = await resolveBin("omp");
  } catch (err) {
    throw new Error(`omp недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([ompBin, "models", "ls", "--json"], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`omp недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  const timer = setTimeout(() => proc.kill(), 15_000);
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  void Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    },
  );
  const res = await promise;
  if (res.code !== 0) throw new Error(`omp models ls failed: ${truncateError(res.stderr)}`);
  const parsed = JSON.parse(res.stdout) as { models?: Array<Record<string, unknown>> };
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return models
    .filter((m) => typeof m.selector === "string" && typeof m.name === "string")
    .map((m) => ({
      selector: m.selector as string,
      name: m.name as string,
      thinking: Array.isArray(m.thinking) ? m.thinking.filter((l): l is string => typeof l === "string") : [],
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 0,
    }));
}

/** Каталог моделей omp для пикеров; при сбое отдаём прошлый снимок, если он есть. */
export async function listModelOptions(): Promise<AgentModelOption[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache.entries;
  try {
    const entries = await runOmpModels();
    modelsCache = { at: Date.now(), entries };
    return entries;
  } catch (err) {
    if (modelsCache) return modelsCache.entries;
    throw err;
  }
}

// Уровень усилия omp печатает глифом перед моделью в статус-строке панели
// («π > ◒ DeepSeek V4 Flash > …»): «Thinking set to …» из старых версий больше нет.
// Маппинг снят вживую на v18.10.4: off→⦸, auto→⟳, low→◔, high→◒, max→◉.
const THINKING_GLYPHS: Record<string, string> = {
  "⦸": "off",
  "⟳": "auto",
  "◔": "low",
  "◒": "high",
  "◉": "max",
};

function parseThinkingGlyph(text: string): string | null {
  const match = /π\s*>\s*(\S+)\s/.exec(text);
  return match === null ? null : (THINKING_GLYPHS[match[1]] ?? null);
}

function settingsError(resolution: PaneResolution): AgentSettingsRead | null {
  if (resolution.kind === "ok") return null;
  if (resolution.kind === "not_found") return { kind: "not_found", error: resolution.error };
  if (resolution.kind === "not_herdr") return { kind: "not_herdr" };
  return { kind: "failed", error: resolution.error };
}

// Расширенное чтение панели: подтверждения («Model set to …») могут уехать
// за видимый экран, берём последние N строк снимка.
async function readPanelTail(paneId: string, lines: number): Promise<string | null> {
  const read = unwrapHerdr(await runHerdr(["pane", "read", paneId, "--lines", String(lines)], SPAWN_TIMEOUT_MS));
  if (!read.ok) return null;
  return typeof read.result === "string" ? read.result : null;
}

async function currentSettings(instanceId: string, catalog: AgentModelOption[], paneId?: string): Promise<AgentChatSettings> {
  let model: AgentChatSettings["model"] = null;
  try {
    const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
    if (host) model = { provider: host.model.provider, id: host.model.id };
  } catch {
    // collab list недоступен — модель останется null, уровень берём с панели.
  }
  let tail: string | null = null;
  if (paneId !== undefined) tail = await readPanelTail(paneId, 60);
  else {
    const read = await readTerminal(instanceId);
    tail = read.kind === "ok" ? read.text : null;
  }
  const thinking = tail === null ? null : parseThinkingGlyph(tail.slice(-4000));
  return { model, thinking, models: catalog };
}

export async function getAgentSettings(instanceId: string): Promise<AgentSettingsRead> {
  const pane = await resolvePane(instanceId);
  const blocked = settingsError(pane);
  if (blocked) return blocked;
  try {
    return { kind: "ok", settings: await currentSettings(instanceId, await listModelOptions(), pane.kind === "ok" ? pane.paneId : undefined) };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Пауза после партии клавиш: TUI не переваривает залп, набранный без пауз. */
const SETTLE_MS = 350;
/** Пауза на открытие модального пикера. */
const MODAL_MS = 900;
/** Позиции меню усилия (/effort) в порядке отрисовки. */
const EFFORT_LEVELS = ["off", "auto", "low", "high", "max"];

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

type PaneKeys = { ok: true } | { ok: false; error: string };

/** Партия клавиш в панель с паузой на перерисовку TUI. */
async function pressKeys(paneId: string, keys: string[], settleMs = SETTLE_MS): Promise<PaneKeys> {
  const sent = unwrapHerdr(await runHerdr(["pane", "send-keys", paneId, ...keys], SPAWN_TIMEOUT_MS));
  if (!sent.ok) return { ok: false, error: `herdr pane send-keys failed: ${truncateError(sent.error)}` };
  await delay(settleMs);
  return { ok: true };
}

async function typeIntoPane(paneId: string, text: string): Promise<PaneKeys> {
  const keys = textToKeys(text);
  if (keys === null) return { ok: false, error: `в панель не набрать: ${JSON.stringify(text)}` };
  return pressKeys(paneId, keys);
}

/** Маркеры открытого меню/пикера в панели: их закрывает esc. */
const MENU_MARKERS = /assign roles|type to search|Thinking Level|↑\/↓ (?:models|providers)|⏎\/→ models/;

/** Текст в строке композера («╰─ …») — пусто, если строки нет. */
function composerText(tail: string): string {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf("╰─");
    if (idx >= 0) return lines[i].slice(idx + 2).trim();
  }
  return "";
}

/**
 * Привести панель к чистому композеру. Esc в чистом композере omp — это
 * rewind сессии, поэтому esc шлём только пока на экране открытое меню/пикер,
 * а остатки набранного текста убираем backspace'ами.
 */
async function clearComposer(paneId: string): Promise<PaneKeys> {
  for (let i = 0; i < 4; i++) {
    if (!MENU_MARKERS.test(await paneTail(paneId))) break;
    const esc = await pressKeys(paneId, ["esc"]);
    if (!esc.ok) return esc;
  }
  if (MENU_MARKERS.test(await paneTail(paneId))) return { ok: false, error: "меню в панели не закрывается" };
  const typed = composerText(await paneTail(paneId));
  if (typed.length === 0) return { ok: true };
  return pressKeys(paneId, Array.from({ length: Math.min(typed.length + 4, 32) }, () => "backspace"));
}

async function paneTail(paneId: string): Promise<string> {
  return (await readPanelTail(paneId, 40)) ?? "";
}

/** Текущий уровень усилия — подсветка «❯ level» в открытом меню /effort. */
function highlightedLevel(text: string): string | null {
  const match = /❯\s+(\w+)/.exec(text);
  return match === null || !EFFORT_LEVELS.includes(match[1]) ? null : match[1];
}

/**
 * Смена модели в живом TUI: «/» → «model» → пикер → поиск селектора →
 * роль default → уровень усилия по умолчанию → закрыть пикер.
 * Каждый шаг проверяется по экрану панели; при расхождении — ошибка,
 * а не молчаливо отправленное в чат сообщение (так ломался прежний вариант).
 */
async function switchModelInPane(paneId: string, selector: string): Promise<PaneKeys> {
  const cleared = await clearComposer(paneId);
  if (!cleared.ok) return cleared;
  const palette = await pressKeys(paneId, ["slash"], 600);
  if (!palette.ok) return palette;
  const command = await typeIntoPane(paneId, "model");
  if (!command.ok) return command;
  await pressKeys(paneId, ["enter"], MODAL_MS);
  // Свежеоткрытый пикер: «⏎/→ models · ↑/↓ providers · type to search».
  if (!/type to search/.test(await paneTail(paneId))) return { ok: false, error: "пикер моделей не открылся" };

  const search = await typeIntoPane(paneId, selector);
  if (!search.ok) return search;
  if (!/assign roles/.test(await paneTail(paneId))) return { ok: false, error: "поиск в пикере моделей не сработал" };

  await pressKeys(paneId, ["enter"], MODAL_MS);
  if (!/→\s*\[/.test(await paneTail(paneId))) return { ok: false, error: `модель ${selector} не нашлась в пикере` };
  await pressKeys(paneId, ["enter"], MODAL_MS);
  if (/inherit/.test(await paneTail(paneId))) await pressKeys(paneId, ["enter"], MODAL_MS);
  // Закрываем по состоянию экрана: первый esc чистит поиск, второй закрывает
  // пикер; лишний esc в чистом композере — rewind сессии.
  for (let i = 0; i < 3; i++) {
    if (!/type to search/.test(await paneTail(paneId))) break;
    const esc = await pressKeys(paneId, ["esc"]);
    if (!esc.ok) return esc;
  }
  if (/type to search/.test(await paneTail(paneId))) return { ok: false, error: "пикер моделей не закрылся" };
  return { ok: true };
}

/** Смена уровня усилия: «/effort» → стрелками до нужного уровня → enter. */
async function switchThinkingInPane(paneId: string, level: string): Promise<PaneKeys> {
  const cleared = await clearComposer(paneId);
  if (!cleared.ok) return cleared;
  const palette = await pressKeys(paneId, ["slash"], 600);
  if (!palette.ok) return palette;
  const command = await typeIntoPane(paneId, "effort");
  if (!command.ok) return command;
  await pressKeys(paneId, ["enter"], MODAL_MS);
  if (!(await paneTail(paneId)).includes("Thinking Level")) return { ok: false, error: "меню усилия не открылось" };

  let tail = await paneTail(paneId);
  for (let step = 0; step <= EFFORT_LEVELS.length; step++) {
    const current = highlightedLevel(tail);
    if (current === null) return { ok: false, error: "не вижу текущий уровень усилия" };
    if (current === level) break;
    const moved = await pressKeys(paneId, [EFFORT_LEVELS.indexOf(level) < EFFORT_LEVELS.indexOf(current) ? "up" : "down"]);
    if (!moved.ok) return moved;
    tail = await paneTail(paneId);
  }
  if (highlightedLevel(tail) !== level) return { ok: false, error: `уровень ${level} не выбрался` };
  const applied = await pressKeys(paneId, ["enter"], 600);
  if (!applied.ok) return applied;
  for (let i = 0; i < 3; i++) {
    if (!(await paneTail(paneId)).includes("Thinking Level")) break;
    const esc = await pressKeys(paneId, ["esc"]);
    if (!esc.ok) return esc;
  }
  if ((await paneTail(paneId)).includes("Thinking Level")) return { ok: false, error: "меню усилия не закрылось" };
  return { ok: true };
}

export async function setAgentSettings(
  instanceId: string,
  change: { model?: unknown; thinking?: unknown },
): Promise<AgentSettingsOutcome> {
  const pane = await resolvePane(instanceId);
  const blocked = settingsError(pane);
  if (blocked) return blocked;
  if (pane.kind !== "ok") return { kind: "failed", error: "pane" };

  let catalog: AgentModelOption[];
  try {
    catalog = await listModelOptions();
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }

  let modelSelector: string | null = null;
  if (change.model !== undefined) {
    if (typeof change.model !== "string" || change.model.trim() === "") {
      return { kind: "bad_request", error: "model must be a non-empty string" };
    }
    const entry = catalog.find((m) => m.selector === change.model);
    if (!entry) return { kind: "bad_request", error: `Неизвестная модель: ${change.model}` };
    modelSelector = entry.selector;
  }
  let thinkingLevel: string | null = null;
  if (change.thinking !== undefined) {
    if (typeof change.thinking !== "string" || !EFFORT_LEVELS.includes(change.thinking)) {
      return { kind: "bad_request", error: `Уровень усилия: один из ${EFFORT_LEVELS.join(", ")}` };
    }
    thinkingLevel = change.thinking;
  }
  if (modelSelector === null && thinkingLevel === null) {
    return { kind: "bad_request", error: "Ничего не передано: нужны model и/или thinking" };
  }

  // Esc — клавиша прерывания хода и диалогов: под живой работой клавиши не шлём.
  const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
  if (host !== undefined && (host.busy || host.inputRequired)) {
    return { kind: "bad_request", error: "Агент занят — дождись конца хода и попробуй снова" };
  }

  const before = await currentSettings(instanceId, catalog, pane.paneId);
  const currentSelector = before.model === null ? null : `${before.model.provider}/${before.model.id}`;
  if (modelSelector !== null && modelSelector !== currentSelector) {
    const switched = await switchModelInPane(pane.paneId, modelSelector);
    if (!switched.ok) return { kind: "failed", error: switched.error };
  }
  if (thinkingLevel !== null && thinkingLevel !== before.thinking) {
    const switched = await switchThinkingInPane(pane.paneId, thinkingLevel);
    if (!switched.ok) return { kind: "failed", error: switched.error };
  }

  let settings = await currentSettings(instanceId, catalog, pane.paneId);
  const appliedSelector = settings.model === null ? null : `${settings.model.provider}/${settings.model.id}`;
  if (modelSelector !== null && appliedSelector !== modelSelector) {
    return { kind: "failed", error: `omp не подтвердил смену модели (сейчас ${appliedSelector ?? "неизвестно"})` };
  }
  if (thinkingLevel !== null && settings.thinking !== thinkingLevel) {
    // глиф статус-строки перерисовывается не мгновенно — читаем ещё раз
    await delay(500);
    settings = await currentSettings(instanceId, catalog, pane.paneId);
    if (settings.thinking !== thinkingLevel) {
      return { kind: "failed", error: `уровень усилия не подтвердился (сейчас ${settings.thinking ?? "неизвестен"})` };
    }
  }
  return { kind: "ok", settings };
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

const HOME = homedir();

/**
 * Project paths may only be real directories inside $HOME (no dot-dirs at any
 * level: blocks ~/.ssh, ~/.omp, ~/.config, …) or inside /tmp (agent scratch).
 * Everything else — /etc, other users, hidden config — is rejected.
 */
export function isAllowedProjectPath(dir: string): boolean {
	let resolved: string;
	try {
		resolved = realpathSync(dir);
	} catch {
		return false;
	}
	if (!statSync(resolved).isDirectory()) return false;
	const home = HOME + "/";
	// Сам дом — тоже «проект» (агенты Main/restores живут в /home/vincentfox).
	if (resolved === HOME) return true;
	if (!resolved.startsWith(home)) return resolved.startsWith("/tmp/") && !resolved.slice(5).split("/").some(s => s.startsWith("."));
	const rest = resolved.slice(home.length);
	return !rest.split("/").some(s => s.startsWith("."));
}

/** .git в этом каталоге или выше, в пределах разрешённого пути. */
function hasGitAbove(dir: string): boolean {
	try {
		let cur = realpathSync(dir);
		if (!statSync(cur).isDirectory()) return false;
		for (;;) {
			if (existsSync(join(cur, ".git"))) return true;
			const parent = dirname(cur);
			if (parent === cur || !isAllowedProjectPath(parent)) return false;
			cur = parent;
		}
	} catch {
		return false;
	}
}

export function listProjectFiles(dir: string): ProjectListing {
	if (!isAllowedProjectPath(dir)) throw new Error("path not allowed");
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
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), hasGit: hasGitAbove(dir) };
}

export type GitOutcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; error: string };

export async function projectGit(dir: string, mode: "status" | "diff"): Promise<GitOutcome> {
	if (!isAllowedProjectPath(dir)) return { kind: "failed", error: "path not allowed" };
	const args = mode === "status" ? ["-C", dir, "status", "--porcelain=v1"] : ["-C", dir, "diff", "--unified=2"];
  const res = await runGit(args);
  if (res.code !== 0) return { kind: "failed", error: `git ${mode} failed: ${truncateError(res.stderr || res.stdout)}` };
  let text = res.stdout;
  if (Buffer.byteLength(text, "utf8") > GIT_OUTPUT_CAP_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, GIT_OUTPUT_CAP_BYTES).toString("utf8");
  }
  return { kind: "ok", text };
}

/** herdr принимает имена [a-z0-9_-]{1,32}; пользовательские имена — любые.
 *  Для herdr делаем читаемый слаг (транслит), для отображения — оригинал. */
const RU_TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
	й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
	у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
	э: "e", ю: "yu", я: "ya",
};

function herdrSlug(name: string): string {
	const lowered = name.toLowerCase().replace(/[а-яё]/g, (ch) => RU_TRANSLIT[ch] ?? "-");
	const slug = lowered
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+/, "")
		.slice(0, 32)
		.replace(/[-_]+$/, "");
	if (slug.length === 0 || !/^[a-z]/.test(slug)) return `agent-${slug.replace(/^[^a-z0-9]+/, "") || "unnamed"}`.slice(0, 32);
	return slug;
}

export type AgentRename =
  | { kind: "ok"; paneId: string; slug: string }
  | { kind: "not_found"; error: string }
  | { kind: "not_herdr" }
  | { kind: "failed"; error: string };

/** Переименовать herdr-агента (имя видно в списках приложения). */
export async function renameAgent(instanceId: string, name: string): Promise<AgentRename> {
  const pane = await resolvePane(instanceId);
  if (pane.kind !== "ok") return pane;
  const slug = herdrSlug(name);
  const out = unwrapHerdr(await runHerdr(["agent", "rename", pane.paneId, slug], SPAWN_TIMEOUT_MS));
  if (!out.ok) return { kind: "failed", error: out.error };
  return { kind: "ok", paneId: pane.paneId, slug };
}

export type ProjectFileRead =
  | { kind: "ok"; content: string }
  | { kind: "too_large" }
  | { kind: "failed"; error: string };

const PROJECT_FILE_MAX_BYTES = 256 * 1024;

/** Прочитать текстовый файл из проекта для прикрепления к сообщению. */
export function readProjectFile(dir: string, name: string): ProjectFileRead {
  try {
    if (!isAllowedProjectPath(dir)) return { kind: "failed", error: "path not allowed" };
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      return { kind: "failed", error: "bad file name" };
    }
    const full = join(realpathSync(dir), name);
    const st = statSync(full);
    if (!st.isFile()) return { kind: "failed", error: "not a file" };
    if (st.size > PROJECT_FILE_MAX_BYTES) return { kind: "too_large" };
    const content = readFileSync(full, "utf8");
    return { kind: "ok", content };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
