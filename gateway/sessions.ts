import { appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Session store layout: ~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl */
const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");

/** Внешние хранилища того же формата, но вне корня omp.
 * Мост Telegram (`~/.tgbot/tg2omp.py`) запускает omp с `--session-dir
 * ~/.tgbot/sessions` и пишет плоские `*.jsonl` — без этого списка переписка с
 * ботом видна только в Telegram. */
const EXTRA_SESSION_DIRS: readonly string[] = [join(homedir(), ".tgbot", "sessions")];

/** Внешние каталоги сессий для индекса поиска — тот же список, что читает листинг. */
export function extraSessionDirs(): readonly string[] {
  return EXTRA_SESSION_DIRS;
}

/** Slug для внешнего каталога: в списке сессий он виден рядом с cwd. */
function slugOfExternalDir(dir: string): string {
  return `external:${dir.split("/").filter(Boolean).pop() ?? dir}`;
}
/** Title slot is bytes 0–255; the first user message can sit past 8 KB in
 * sessions that open with big injected records — 64 KB covers real files. */
const HEAD_BYTES = 65_536;
const TAIL_BYTES = 16_384;

export type SessionStatus = "live" | "complete" | "aborted" | "error" | "interrupted" | "unknown";

export interface SessionSummary {
  id: string;
  path: string;
  projectSlug: string;
  cwd: string | null;
  title: string | null;
  titleSource: string | null;
  /** parentSession from the header — fork/sibling continuations point at their root. */
  parentId: string | null;
  /** First user message text — Cyrillic preview when omp never titled the session. */
  preview: string | null;
  /** Creation time parsed from the filename (mtime jumps on every resume). */
  createdTs: number;
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

function parseHead(head: string): { id: string | null; cwd: string | null; title: string | null; titleSource: string | null; parentId: string | null } {
  let id: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let titleSource: string | null = null;
  let parentId: string | null = null;
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj === null || typeof obj !== "object") continue;
      const rec = obj as { type?: unknown; id?: unknown; cwd?: unknown; title?: unknown; source?: unknown; parentSession?: unknown };
      if (rec.type === "session") {
        if (typeof rec.id === "string") id = rec.id;
        if (typeof rec.cwd === "string") cwd = rec.cwd;
        if (typeof rec.parentSession === "string" && parentId === null) parentId = rec.parentSession;
      }
      if (rec.type === "title" && typeof rec.title === "string" && title === null) {
        title = rec.title;
        if (typeof rec.source === "string") titleSource = rec.source;
      }
      if (id !== null && title !== null) break;
    } catch {
      // skip malformed head line
    }
  }
  return { id, cwd, title, titleSource, parentId };
}

/** Обрезает host-шум (блоки памяти, системные ремарки, теги) — общее правило для
 * превью в списках и для текстового поиска по репликам. */
export function stripInjectedNoise(text: string): string {
  return text
    .replace(/<memories>[\s\S]*?<\/memories>/gi, " ")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<[^>\n]{1,64}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Первый запрос сессии, обрезанный до размера превью. */
function cleanPromptText(text: string): string | null {
  const clean = stripInjectedNoise(text).slice(0, 80);
  return clean.length > 0 ? clean : null;
}

/** Первый запрос пользователя в head-срезе — null, когда запроса нет. */
function firstUserText(head: string): string | null {
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object") continue;
    const rec = obj as { type?: unknown; attribution?: unknown; content?: unknown; message?: unknown };
    // Запрос, отправленный из приложения, приходит не message, а custom_message
    // («collab-prompt»): без этой ветки сессия, начатая с телефона, безымянна.
    if (rec.type === "custom_message" && rec.attribution === "user" && typeof rec.content === "string") {
      const clean = cleanPromptText(rec.content);
      if (clean !== null) return clean;
      continue;
    }
    if (rec.type !== "message" || rec.message === null || typeof rec.message !== "object") continue;
    const message = rec.message as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    const content = message.content;
    let text: string;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        if (!("type" in part) || part.type !== "text") continue;
        if (!("text" in part) || typeof part.text !== "string") continue;
        parts.push(part.text);
      }
      text = parts.join(" ");
    } else text = "";
    const clean = cleanPromptText(text);
    if (clean !== null) return clean;
  }
  return null;
}

/** `2026-10-13T22-05-45-325Z_<uuid>.jsonl` → epoch ms (0 when unparsable). */
export function createdFromFilename(file: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(file);
  if (m === null) return 0;
  return Date.UTC(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)) - 1, Number(m[1].slice(8, 10)), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
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
  // (каталог, slug) — корень omp по подпапкам плюс внешние хранилища плоским списком.
  const roots: { dir: string; slug: string }[] = [];
  try {
    for (const slug of readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)) {
      roots.push({ dir: join(SESSIONS_DIR, slug), slug });
    }
  } catch {
    // недоступный корень omp не мешает читать внешние хранилища
  }
  for (const dir of EXTRA_SESSION_DIRS) roots.push({ dir, slug: slugOfExternalDir(dir) });

  const out: SessionSummary[] = [];
  for (const { dir, slug } of roots) {
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
      const headSlice = readSlice(path, 0, HEAD_BYTES).text;
      const head = parseHead(headSlice);
      const id = head.id ?? file.match(/_([0-9a-fA-F-]{36})\.jsonl$/)?.[1] ?? file.replace(/\.jsonl$/, "");
      const status: SessionStatus = liveIds.has(id)
        ? "live"
        : statusFromTail(readSlice(path, Math.max(0, stat.size - TAIL_BYTES), TAIL_BYTES).text, stat.size <= TAIL_BYTES);
      // Пустой title-слот («» после инициализации сессии) — это «имени нет»:
      // в списках такую сессию называет первый запрос, а не голый UUID.
      const title = head.title !== null && head.title.trim().length > 0 ? head.title.trim() : null;
      const preview = title === null ? firstUserText(headSlice) : null;
      out.push({
        id,
        path,
        projectSlug: slug,
        cwd: head.cwd,
        title,
        titleSource: head.titleSource,
        parentId: head.parentId,
        preview,
        createdTs: createdFromFilename(file) || stat.mtimeMs,
        status,
        modified: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Head records of a session file (id, cwd, title, parent) — nulls when unreadable.
 * `preview` — первый запрос пользователя, когда omp ещё не дал сессии заголовок:
 * без него свежая сессия в списках безымянна. */
export function parseSessionHead(path: string): {
  id: string | null;
  cwd: string | null;
  title: string | null;
  titleSource: string | null;
  parentId: string | null;
  preview: string | null;
} {
  try {
    const headSlice = readSlice(path, 0, HEAD_BYTES).text;
    const head = parseHead(headSlice);
    const title = head.title !== null && head.title.trim().length > 0 ? head.title.trim() : null;
    return { ...head, title, preview: title === null ? firstUserText(headSlice) : null };
  } catch {
    return { id: null, cwd: null, title: null, titleSource: null, parentId: null, preview: null };
  }
}

/** Хвост транскрипта для мгновенной отрисовки в приложении.
 *
 * Зачем: коллаб-гость получает ВСЮ историю сессии (у больших она 5–10 МБ) и до
 * конца снапшота ничего не видит — открытие чата занимает секунды. Хвост читается
 * локально (шлюз на той же машине, что и omp) и рисуется сразу, пока снапшот едет.
 *
 * Безопасность: путь принимается только внутри корня сессий и только .jsonl —
 * иначе эндпоинт стал бы чтением произвольных файлов.
 */
export function tailEntries(path: string, limit = 80): unknown[] | null {
  const roots = [SESSIONS_DIR, ...EXTRA_SESSION_DIRS].map((d) => (d.endsWith("/") ? d : `${d}/`));
  if (typeof path !== "string" || !path.endsWith(".jsonl") || !roots.some((r) => path.startsWith(r))) return null;
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null;
  }
  if (size <= 0) return [];
  // Хвост в 4 МБ покрывает сотни записей; больше читать незачем — нам нужен экран.
  const window = Math.min(size, 4 * 1024 * 1024);
  const slice = readSlice(path, size - window, window).text;
  const lines = slice.split("\n");
  const out: unknown[] = [];
  // Первая строка обрезана окном — пропускаем её, если окно не с начала файла.
  for (let i = window < size ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0 || line.length > 200_000) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") continue;
      if (!("type" in parsed) || typeof parsed.type !== "string") continue;
      if (!("id" in parsed) || typeof parsed.id !== "string") continue;
      out.push(parsed);
    } catch {
      continue;
    }
  }
  return out.slice(-Math.min(Math.max(limit, 1), 200));
}

/** Locate a session jsonl by omp session id — the uuid is embedded in the filename. */
export function findSessionFile(sessionId: string): string | null {
  let slugs: string[];
  try {
    slugs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const dir = join(SESSIONS_DIR, slug);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    if (hit !== undefined) return join(dir, hit);
  }
  for (const dir of EXTRA_SESSION_DIRS) {
    try {
      const hit = readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
      if (hit !== undefined) return join(dir, hit);
    } catch {
      continue;
    }
  }
  return null;
}

/** Каталог сессий читается: отличает «файла действительно нет» от «ФС недоступна». */
export function sessionsRootReadable(): boolean {
  try {
    readdirSync(SESSIONS_DIR);
    return true;
  } catch {
    return false;
  }
}

export type RenameOutcome =
  | { kind: "ok"; title: string; previousTitle: string | null }
  | { kind: "no_slot"; error: string }
  | { kind: "too_long"; error: string };

/**
 * Rewrite the omp title slot in place: line 1 of every session file is a
 * fixed-width 256-byte record `{"type":"title",...,"pad":"   "}` terminated by
 * \n — omp pads it with spaces precisely so renames never shift bytes.
 * Appends the same title_change audit record omp itself writes on /rename.
 */
export function renameSession(path: string, rawTitle: string): RenameOutcome {
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (title.length === 0) return { kind: "no_slot", error: "пустое название" };
  const SLOT_BYTES = 256;
  const fd = openSync(path, "r+");
  try {
    const buf = Buffer.alloc(SLOT_BYTES);
    const read = readSync(fd, buf, 0, SLOT_BYTES, 0);
    if (read < SLOT_BYTES || buf[255] !== 0x0a) {
      return { kind: "no_slot", error: "файл не начинается со слота названия" };
    }
    let old: unknown;
    try {
      old = JSON.parse(buf.subarray(0, 255).toString("utf8"));
    } catch {
      return { kind: "no_slot", error: "слот названия повреждён" };
    }
    if (old === null || typeof old !== "object" || !("type" in old) || old.type !== "title") {
      return { kind: "no_slot", error: "первая запись — не слот названия" };
    }
    const previousTitle = "title" in old && typeof old.title === "string" ? old.title : null;

    const updatedAt = new Date().toISOString();
    // fit(t) = bytes of the record with an EMPTY pad + 1 for \n. The final line
    // is fit(t) + padLen and must total exactly 256 with padLen ≥ 1.
    const fit = (titleText: string): number =>
      Buffer.byteLength(JSON.stringify({ type: "title", v: 1, title: titleText, source: "user", updatedAt, pad: "" })) + 1;
    let finalTitle = title;
    if (fit(finalTitle) > 255) {
      // Shrink by whole characters (UTF-8 aware) until the record fits 256 bytes.
      let chars = [...finalTitle];
      while (chars.length > 0 && fit(chars.join("") + "…") > 255) chars = chars.slice(0, -1);
      if (chars.length === 0) return { kind: "too_long", error: "название не помещается в слот" };
      finalTitle = chars.join("") + "…";
    }
    const padLen = SLOT_BYTES - fit(finalTitle);
    const record = JSON.stringify({ type: "title", v: 1, title: finalTitle, source: "user", updatedAt, pad: " ".repeat(padLen) });
    const line = Buffer.from(`${record}\n`, "utf8");
    if (line.length !== SLOT_BYTES) return { kind: "too_long", error: "название не помещается в слот" };
    writeSync(fd, line, 0, line.length, 0);

    const audit = `${JSON.stringify({ type: "title_change", title: finalTitle, source: "user", previousTitle, updatedAt })}\n`;
    appendFileSync(path, audit, "utf8");
    return { kind: "ok", title: finalTitle, previousTitle };
  } finally {
    closeSync(fd);
  }
}

/** Одна запись ленты «Активность»: реплика или вызов инструмента из лога сессии. */
export interface ActivityRow {
  id: string;
  sessionId: string;
  sessionPath: string;
  sessionTitle: string | null;
  cwd: string | null;
  kind: "message" | "tool" | "error";
  role: string | null;
  text: string;
  ts: string;
}

/** Хвост лога сессии для ленты: последние ходы целиком. */
const ACTIVITY_TAIL_BYTES = 48 * 1024;
/** Сколько сессий смотреть: лента — «что было недавно», а не архив. */
const ACTIVITY_SESSIONS = 12;
/** Сколько записей брать из одной сессии. */
const ACTIVITY_PER_SESSION = 6;
/** Длина текста записи в ленте. */
const ACTIVITY_TEXT_CHARS = 240;

function activityText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (!("type" in part) || part.type !== "text") continue;
    if ("text" in part && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join(" ");
}

function activityRowsOf(session: SessionSummary): ActivityRow[] {
  if (session.size <= 0) return [];
  const offset = Math.max(0, session.size - ACTIVITY_TAIL_BYTES);
  const tail = readSlice(session.path, offset, ACTIVITY_TAIL_BYTES).text;
  const lines = tail.split("\n");
  if (offset > 0) lines.shift(); // первая строка среза может быть обрезана
  const rows: ActivityRow[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const rec = record as { type?: unknown; id?: unknown; timestamp?: unknown; message?: unknown };
    if (rec.type !== "message" || typeof rec.timestamp !== "string") continue;
    const message = rec.message !== null && typeof rec.message === "object" ? (rec.message as { role?: unknown }) : null;
    const role = message !== null && typeof message.role === "string" ? message.role : null;
    if (role === null || !["user", "assistant", "toolCall", "toolResult"].includes(role)) continue;
    const text = activityText(message).replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    const tool = role === "toolCall" || role === "toolResult";
    const kind: ActivityRow["kind"] = tool ? "tool" : role === "assistant" && /error|failed|panic/i.test(text) ? "error" : "message";
    rows.push({
      id: typeof rec.id === "string" ? rec.id : `${session.id}:${rec.timestamp}`,
      sessionId: session.id,
      sessionPath: session.path,
      sessionTitle: session.title,
      cwd: session.cwd,
      kind,
      role,
      text: text.slice(0, ACTIVITY_TEXT_CHARS),
      ts: rec.timestamp,
    });
  }
  return rows.slice(-ACTIVITY_PER_SESSION);
}

/** Лента активности по недавним сессиям: у вкладки «Активность» без открытого
 *  чата не было источника событий, и она всегда показывала пустоту. */
export function recentActivity(limit: number, liveIds: ReadonlySet<string>): ActivityRow[] {
  return listSessions(liveIds)
    .slice(0, ACTIVITY_SESSIONS)
    .flatMap(activityRowsOf)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, limit);
}
