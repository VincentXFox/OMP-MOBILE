import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

/**
 * Библиотека системных промптов AI-инструментов.
 *
 * Источник — публичный репозиторий x1xhlol/system-prompts-and-models-of-ai-tools
 * (GPL-3.0): 111 файлов по 34 инструментам — Cursor, Windsurf, Devin, v0, Claude Code,
 * Xcode, Poke и т.д. Это не скилы (не процедуры), а уставы: чужой системный промпт
 * полезен как образец и как готовый характер агента.
 *
 * Чтение только из локального клона: никакого сетевого вызова на каждый поиск,
 * обновление — `git -C ~/prompts/ai-tools-prompts pull` (или deploy/skills-sync.sh).
 */

export function promptsRoot(): string {
  const fromEnv = process.env.OMP_POCKET_PROMPTS_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim().replace(/\/+$/, "");
  return join(homedir(), "prompts", "ai-tools-prompts");
}

export interface PromptDoc {
  /** Относительный путь внутри библиотеки — он же id и он же ключ безопасности. */
  id: string;
  /** Инструмент = каталог верхнего уровня («Cursor Prompts», «Anthropic»). */
  tool: string;
  title: string;
  bytes: number;
  /** Первые строки содержимого: по списку видно, о чём файл. */
  preview: string;
}

export interface PromptHit extends PromptDoc {
  /** Кусок текста вокруг первого совпадения (только при поиске по содержимому). */
  snippet: string | null;
}

interface IndexedDoc extends PromptDoc {
  path: string;
}

const INDEX_TTL_MS = 60_000;
const MAX_INDEX_FILE_BYTES = 400_000;
const MAX_READ_CHARS = 200_000;
const PREVIEW_CHARS = 400;
const SNIPPET_RADIUS = 120;

let index: IndexedDoc[] = [];
let indexedAt = 0;
const textCache = new Map<string, { mtimeMs: number; text: string }>();

function isPromptFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "readme.md" || lower === "license.md") return false;
  return lower.endsWith(".txt") || lower.endsWith(".json") || lower.endsWith(".md");
}

function readText(path: string): string {
  try {
    const stat = statSync(path);
    const cached = textCache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = readFileSync(path, "utf8").slice(0, MAX_INDEX_FILE_BYTES);
    if (textCache.size > 256) textCache.clear();
    textCache.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  } catch {
    return "";
  }
}

/** Плоский список файлов библиотеки: обход на два уровня вглубь (инструмент/подпапка/файл). */
function buildIndex(): IndexedDoc[] {
  const root = promptsRoot();
  const out: IndexedDoc[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        if (entry.name === "assets") continue;
        walk(path, depth + 1);
        continue;
      }
      if (!isPromptFile(entry.name)) continue;
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        continue;
      }
      const rel = relative(root, path).split(sep).join("/");
      const text = readText(path);
      out.push({
        id: rel,
        tool: rel.includes("/") ? rel.split("/")[0] ?? "—" : "—",
        title: basename(entry.name, extname(entry.name)),
        bytes,
        preview: text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
        path,
      });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.tool.localeCompare(b.tool, "ru") || a.title.localeCompare(b.title, "ru"));
}

function docs(): IndexedDoc[] {
  if (index.length > 0 && Date.now() - indexedAt < INDEX_TTL_MS) return index;
  index = existsSync(promptsRoot()) ? buildIndex() : [];
  indexedAt = Date.now();
  return index;
}

export function promptLibraryAvailable(): boolean {
  return existsSync(promptsRoot());
}

export interface PromptListResult {
  available: boolean;
  root: string;
  /** Инструменты с числом промптов — для чипов-фильтров. */
  tools: { name: string; count: number }[];
  docs: PromptHit[];
  total: number;
}

/** Поиск: пустой запрос — весь список (свежие инструменты первыми по алфавиту). */
export function listPrompts(opts: { q?: string; tool?: string; limit?: number } = {}): PromptListResult {
  const all = docs();
  const q = (opts.q ?? "").trim().toLowerCase();
  const tool = (opts.tool ?? "").trim();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);

  const byTool = new Map<string, number>();
  for (const doc of all) byTool.set(doc.tool, (byTool.get(doc.tool) ?? 0) + 1);

  const pool = tool.length > 0 ? all.filter((doc) => doc.tool === tool) : all;
  const hits: PromptHit[] = [];
  for (const doc of pool) {
    let snippet: string | null = null;
    if (q.length > 0) {
      const haystack = `${doc.tool} ${doc.title}`.toLowerCase();
      if (haystack.includes(q)) {
        snippet = null;
      } else {
        const text = readText(doc.path);
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const start = Math.max(0, at - SNIPPET_RADIUS);
        snippet = text.slice(start, Math.min(text.length, at + q.length + SNIPPET_RADIUS)).replace(/\s+/g, " ").trim();
      }
    }
    hits.push({ id: doc.id, tool: doc.tool, title: doc.title, bytes: doc.bytes, preview: doc.preview, snippet });
  }

  return {
    available: promptLibraryAvailable(),
    root: promptsRoot(),
    tools: [...byTool.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "ru")),
    docs: hits.slice(0, limit),
    total: hits.length,
  };
}

/** Полный текст по id. id проверяется по индексу — никаких путей «из запроса». */
export function readPrompt(id: string): { doc: PromptDoc; text: string; truncated: boolean } | null {
  const hit = docs().find((doc) => doc.id === id);
  if (hit === undefined) return null;
  // Вторая защита от обхода каталога: путь обязан лежать внутри библиотеки.
  const root = resolve(promptsRoot());
  const path = resolve(root, id);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  const text = readText(path);
  return {
    doc: { id: hit.id, tool: hit.tool, title: hit.title, bytes: hit.bytes, preview: hit.preview },
    text: text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) : text,
    truncated: text.length > MAX_READ_CHARS,
  };
}
