import { Glob } from "bun";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createdFromFilename, parseSessionHead, stripInjectedNoise } from "./sessions.ts";

/**
 * Полнотекстовый поиск по содержимому сессий.
 *
 * Файлы сессий весят 165 МБ, но осмысленного текста в них ~2 МБ: остальное —
 * записи вызовов инструментов, их результаты, размышления и служебные строки.
 * Поэтому индекс (только реплики) живёт целиком в памяти шлюза, наполняется
 * инкрементально по (mtime, size) и не требует ни базы, ни внешнего поисковика.
 * Полный проход корпуса — около секунды, прогрев идёт при старте шлюза.
 */

/** Только файлы сессий верхнего уровня: `sessions/<slug>/<ts>_<uuid>.jsonl`.
 * Транскрипты субагентов лежат в подпапках самой сессии, и их «пользовательские»
 * реплики — это задания родительского агента, а не слова человека. */
const SESSION_GLOB = "*/*.jsonl";
const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
const MAX_MESSAGE_CHARS = 20_000;
const SNIPPET_PAD = 70;
const MAX_SNIPPETS = 3;
export const SEARCH_QUERY_MIN = 2;
const DEFAULT_LIMIT = 40;

export type SessionSearchRole = "user" | "all";

interface IndexedMessage {
  ts: number;
  role: "user" | "assistant";
  text: string;
  /** text в нижнем регистре: SQLite-free LIKE по кириллице регистр сам не гасит. */
  norm: string;
}

interface IndexedSession {
  sessionId: string;
  path: string;
  cwd: string | null;
  title: string | null;
  preview: string | null;
  createdTs: number;
  modified: number;
  messages: IndexedMessage[];
}

const index = new Map<string, IndexedSession>();
const indexedStats = new Map<string, { mtimeMs: number; size: number }>();
let pendingFiles = 0;
let scanning: Promise<void> | null = null;
let lastScanMs: number | null = null;
let indexedAt: number | null = null;

export interface SessionSearchSnippet {
  role: "user" | "assistant";
  ts: number;
  /** Отрывок вокруг совпадения. */
  text: string;
  /** Смещение и длина совпадения внутри text — для подсветки на клиенте. */
  start: number;
  length: number;
}

export interface SessionSearchHit {
  sessionId: string;
  path: string;
  cwd: string | null;
  title: string | null;
  preview: string | null;
  createdTs: number;
  modified: number;
  /** Время последнего совпадения — по нему результаты идут сверху вниз. */
  lastMatchTs: number;
  /** Число совпавших реплик. */
  matches: number;
  /** message — все слова запроса нашлись в одной реплике; session — по разным. */
  scope: "message" | "session";
  snippets: SessionSearchSnippet[];
}

export interface SessionSearchStatus {
  sessions: number;
  messages: number;
  /** Сколько файлов ещё не дочитано — клиент по этому полю доопрашивает. */
  pendingFiles: number;
  indexing: boolean;
  indexedAt: number | null;
  lastScanMs: number | null;
}

/** Текстовые блоки сообщения: строка либо части с type=text (без thinking). */
function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join(" ");
}

/** Реплики из файла сессии. Строки-кандидаты отбираются подстрокой до JSON.parse:
 * вызовы инструментов и их результаты (их большинство) разбирать незачем. */
function extractMessages(text: string): IndexedMessage[] {
  const out: IndexedMessage[] = [];
  for (const line of text.split("\n")) {
    const isMessage = line.includes('"type":"message"');
    const isUserPrompt = !isMessage && line.includes('"custom_message"') && line.includes('"attribution":"user"');
    if (!isMessage && !isUserPrompt) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as { timestamp?: unknown; content?: unknown; message?: unknown };
    const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) || 0 : 0;
    // Запрос, отправленный из приложения, приходит custom_message («collab-prompt»).
    if (isUserPrompt) {
      addMessage(out, "user", ts, typeof record.content === "string" ? record.content : "");
      continue;
    }
    if (record.message === null || typeof record.message !== "object") continue;
    const message = record.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    addMessage(out, message.role, ts, textParts(message.content));
  }
  return out;
}

function addMessage(out: IndexedMessage[], role: "user" | "assistant", ts: number, raw: string): void {
  if (raw.trim().length === 0) return;
  const text = stripInjectedNoise(raw).slice(0, MAX_MESSAGE_CHARS);
  if (text.length === 0) return;
  out.push({ ts, role, text, norm: text.toLowerCase() });
}

async function indexFile(path: string, stat: { mtimeMs: number; size: number }): Promise<void> {
  const text = await Bun.file(path).text();
  const head = parseSessionHead(path);
  index.set(path, {
    sessionId: head.id ?? basename(path).replace(/\.jsonl$/, ""),
    path,
    cwd: head.cwd,
    title: head.title,
    preview: head.preview,
    createdTs: createdFromFilename(basename(path)) || stat.mtimeMs,
    modified: stat.mtimeMs,
    messages: extractMessages(text),
  });
  indexedStats.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
}

/** Дочитывает изменённые файлы, укладываясь в бюджет. Вызовы параллельны, но
 * сканирование одно: второй запрос ждёт тот же промис, а не запускает своё. */
export function refreshIndex(budgetMs: number): Promise<void> {
  if (scanning !== null) return scanning;
  scanning = (async () => {
    const started = performance.now();
    pendingFiles = 0;
    const paths: string[] = [];
    for (const rel of new Glob(SESSION_GLOB).scanSync({ cwd: SESSIONS_DIR })) paths.push(join(SESSIONS_DIR, rel));
    for (const path of paths) {
      let stat: { mtimeMs: number; size: number };
      try {
        const s = statSync(path);
        if (!s.isFile()) continue;
        stat = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        continue;
      }
      const known = indexedStats.get(path);
      if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue;
      if (performance.now() - started > budgetMs) {
        pendingFiles++;
        continue;
      }
      try {
        await indexFile(path, stat);
      } catch {
        // нечитаемый файл (гонка удаления, права) — просто не индексируем
      }
    }
    const alive = new Set(paths);
    for (const path of [...index.keys()]) {
      if (alive.has(path)) continue;
      index.delete(path);
      indexedStats.delete(path);
    }
    lastScanMs = Math.round(performance.now() - started);
    indexedAt = Date.now();
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

/** Прогрев при старте шлюза: первый поиск с телефона не должен ждать сканирование. */
export function warmSearchIndex(): Promise<void> {
  return refreshIndex(120_000);
}

/**
 * Обновление индекса с бюджетом ожидания: идущий полный прогрев не держит ответ
 * до конца сканирования — лучше отдать частичный индекс и остаток в pendingFiles.
 */
export function refreshIndexWithin(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  void refreshIndex(ms).finally(() => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}

export function searchIndexStatus(): SessionSearchStatus {
  let messages = 0;
  for (const entry of index.values()) messages += entry.messages.length;
  return { sessions: index.size, messages, pendingFiles, indexing: scanning !== null, indexedAt, lastScanMs };
}

/** Отрывок вокруг первого совпадения: индексы берём из norm (та же длина), текст —
 * из оригинала, поэтому в подсказке сохраняется регистр автора. */
function snippetOf(message: IndexedMessage, term: string): SessionSearchSnippet {
  const at = message.norm.indexOf(term);
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(message.text.length, at + term.length + SNIPPET_PAD);
  return { role: message.role, ts: message.ts, text: message.text.slice(start, end), start: at - start, length: term.length };
}

/** Поиск по репликам. Два уровня: сильный (все слова запроса в одной реплике —
 * так ищут фразу) и слабый (слова нашлись в разных репликах одной сессии — так
 * ищут «где я про это писал»). Сравнение — подстрока без регистра, поэтому падеж
 * и порядок слов не мешают. */
export function searchSessions(query: string, role: SessionSearchRole, limit = DEFAULT_LIMIT): SessionSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 0);
  if (terms.length === 0) return [];
  const hits: SessionSearchHit[] = [];
  for (const entry of index.values()) {
    const strongSnippets: SessionSearchSnippet[] = [];
    const weakSnippets: SessionSearchSnippet[] = [];
    const foundTerms = new Set<string>();
    let strongCount = 0;
    let anyCount = 0;
    let strongTs = 0;
    let anyTs = 0;
    for (const message of entry.messages) {
      if (role === "user" && message.role !== "user") continue;
      const inMessage = terms.filter(term => message.norm.includes(term));
      if (inMessage.length === 0) continue;
      for (const term of inMessage) foundTerms.add(term);
      anyCount++;
      if (message.ts > anyTs) anyTs = message.ts;
      const snippet = snippetOf(message, inMessage[0] ?? terms[0] ?? query.toLowerCase());
      if (inMessage.length === terms.length) {
        strongCount++;
        if (message.ts > strongTs) strongTs = message.ts;
        if (strongSnippets.length < MAX_SNIPPETS) strongSnippets.push(snippet);
      } else if (weakSnippets.length < MAX_SNIPPETS) {
        weakSnippets.push(snippet);
      }
    }
    // Слабое совпадение годится, только если нашлись ВСЕ слова — иначе это шум.
    if (strongCount === 0 && foundTerms.size < terms.length) continue;
    const strong = strongCount > 0;
    hits.push({
      sessionId: entry.sessionId,
      path: entry.path,
      cwd: entry.cwd,
      title: entry.title,
      preview: entry.preview,
      createdTs: entry.createdTs,
      modified: entry.modified,
      lastMatchTs: (strong ? strongTs : anyTs) || entry.modified,
      matches: strong ? strongCount : anyCount,
      scope: strong ? "message" : "session",
      snippets: strong ? strongSnippets : weakSnippets,
    });
  }
  hits.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "message" ? -1 : 1) || b.lastMatchTs - a.lastMatchTs || b.matches - a.matches);
  return hits.slice(0, limit);
}
