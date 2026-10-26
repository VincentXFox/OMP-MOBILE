import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bank layout on the host machine: ~/.omp/agent/memories/mnemopi/banks/<bank>/mnemopi.db */
const BANKS_DIR = join(homedir(), ".omp", "agent", "memories", "mnemopi", "banks");

/** Browsable memory tables, whitelisted: anything else is rejected at the route. */
export const MEMORY_TABLES = ["working_memory", "facts", "episodic_memory", "gists", "annotations"] as const;
export type MemoryTable = (typeof MEMORY_TABLES)[number];

export function isMemoryTable(value: string): value is MemoryTable {
  return (MEMORY_TABLES as readonly string[]).includes(value);
}

/** Банки называются `<scope>-<случайный хвост>`; хвост — служебный, в UI не нужен. */
function isBankName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

/** One normalized memory row; each table maps into this shape for the UI. */
export interface MemoryEntry {
  id: string;
  /** Из какой таблицы пришла запись — заполняется в режиме «по всем разделам». */
  table?: MemoryTable;
  title: string | null;
  body: string;
  ts: string | null;
  source: string | null;
  kind: string | null;
  importance: number | null;
  confidence: number | null;
  recallCount: number | null;
  sessionId: string | null;
  memoryId: string | null;
  /** Провенанс Mnemopi: occurred_on, has_source и прочие метки этой памяти. */
  annotations?: { kind: string; value: string }[];
  /** Короткая выжимка памяти (таблица gists), если она есть. */
  gist?: string | null;
  /** Для гиста — текст родительского эпизода, чтобы строка не читалась обрубком. */
  episode?: string | null;
}

export interface MemoryBankInfo {
  name: string;
  total: number;
  tables: { [K in MemoryTable]?: number };
  bytes: number;
  mtime: number;
}

export type MemorySort = "ts" | "importance" | "recall" | "confidence";

interface QueryOptions {
  q?: string;
  sort?: MemorySort;
  source?: string;
  kind?: string;
  minImportance?: number;
  limit: number;
  offset: number;
}

/** Всё, что нужно знать о таблице, чтобы одинаково её фильтровать и сортировать. */
interface TableSpec {
  columns: string;
  timeColumn: string;
  searchColumns: string;
  sourceColumn: string | null;
  kindColumn: string | null;
  importanceColumn: string | null;
  recallColumn: string | null;
  confidenceColumn: string | null;
}

const TABLE_SPEC: Record<MemoryTable, TableSpec> = {
  working_memory: {
    columns: `id, NULL AS title, content AS body, timestamp AS ts, source, memory_type AS kind,
       importance, NULL AS confidence, recall_count AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    timeColumn: "timestamp",
    searchColumns: "content",
    sourceColumn: "source",
    kindColumn: "memory_type",
    importanceColumn: "importance",
    recallColumn: "recall_count",
    confidenceColumn: null,
  },
  episodic_memory: {
    columns: `id, NULL AS title, content AS body, timestamp AS ts, source, memory_type AS kind,
       importance, NULL AS confidence, recall_count AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    timeColumn: "timestamp",
    searchColumns: "content",
    sourceColumn: "source",
    kindColumn: "memory_type",
    importanceColumn: "importance",
    recallColumn: "recall_count",
    confidenceColumn: null,
  },
  facts: {
    columns: `fact_id AS id, subject || ' ' || predicate AS title, object AS body, timestamp AS ts, NULL AS source,
       predicate AS kind, NULL AS importance, confidence, NULL AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    timeColumn: "timestamp",
    searchColumns: "subject || ' ' || predicate || ' ' || object",
    sourceColumn: null,
    kindColumn: "predicate",
    importanceColumn: null,
    recallColumn: null,
    confidenceColumn: "confidence",
  },
  gists: {
    columns: `id, NULL AS title, text AS body, timestamp AS ts, NULL AS source, NULL AS kind,
       NULL AS importance, NULL AS confidence, NULL AS recallCount, NULL AS sessionId, memory_id AS memoryId`,
    timeColumn: "timestamp",
    searchColumns: "text",
    sourceColumn: null,
    kindColumn: null,
    importanceColumn: null,
    recallColumn: null,
    confidenceColumn: null,
  },
  annotations: {
    // created_at — это CURRENT_TIMESTAMP SQLite: UTC без суффикса зоны. Отдаём ISO с «Z»,
    // иначе и JS-парсинг, и сортировка слияния читают его как локальное время (сдвиг на
    // смещение пояса и неверная группа дня).
    columns: `CAST(id AS TEXT) AS id, kind AS title, value AS body,
       CASE WHEN instr(created_at, ' ') > 0 THEN replace(created_at, ' ', 'T') || 'Z' ELSE created_at END AS ts,
       source, kind, NULL AS importance, confidence, NULL AS recallCount, NULL AS sessionId, memory_id AS memoryId`,
    timeColumn: "created_at",
    searchColumns: "kind || ' ' || value",
    sourceColumn: "source",
    kindColumn: "kind",
    importanceColumn: null,
    recallColumn: null,
    confidenceColumn: "confidence",
  },
};

function tableExists(db: Database, table: string): boolean {
  const row = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return (row?.n ?? 0) > 0;
}

function countRows(db: Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get();
  return row?.n ?? 0;
}

function openBankDb(bank: string): Database | null {
  if (!isBankName(bank)) return null;
  const file = join(BANKS_DIR, bank, "mnemopi.db");
  try {
    statSync(file);
  } catch {
    return null;
  }
  // Read-only handle per request: banks are live SQLite files written by the running
  // mnemopi daemon; WAL lets readers proceed while the daemon writes.
  return new Database(file, { readonly: true });
}

function likePattern(q: string): string {
  return `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** Колонка сортировки: оценка, которой у таблицы нет, откатывается на время. */
function sortColumn(spec: TableSpec, sort: MemorySort | undefined): string {
  const bySort: Record<MemorySort, string | null> = {
    ts: spec.timeColumn,
    importance: spec.importanceColumn,
    recall: spec.recallColumn,
    confidence: spec.confidenceColumn,
  };
  const column = sort === undefined ? spec.timeColumn : bySort[sort];
  return column ?? spec.timeColumn;
}

interface Where {
  sql: string;
  params: (string | number)[];
}

/** Варианты шаблона по регистру. LIKE в SQLite регистронезависим только для ASCII,
 * поэтому кириллицу сравниваем вариантами запроса: как есть, нижним, верхним и с
 * заглавной первой буквы. Асимметрии нет: «память» и «Память» дают одну выдачу.
 * Произвольный смешанный регистр («ПаМять») так не ловится — это ограничение
 * схемы Mnemopi (нормализованной колонки нет), а не недосмотр. */
function likeVariants(q: string): string[] {
  const capitalized = q.charAt(0).toUpperCase() + q.slice(1);
  const forms = [q, q.toLowerCase(), q.toUpperCase(), capitalized];
  return [...new Set(forms.filter(form => form.length > 0))].map(likePattern);
}

/** Условия отбора: текст, источник, вид записи и порог важности. */
function buildWhere(spec: TableSpec, opts: QueryOptions): Where {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    const variants = likeVariants(opts.q);
    const parts = variants.map(() => `(${spec.searchColumns}) LIKE ? ESCAPE '\\'`);
    clauses.push(`(${parts.join(" OR ")})`);
    params.push(...variants);
  }
  if (opts.source !== undefined) {
    // Фильтр по колонке, которой у таблицы нет, — это «ни одной строки», а не
    // «фильтр проигнорируем»: молчаливое игнорирование врало в total.
    if (spec.sourceColumn === null) clauses.push("0");
    else {
      clauses.push(`${spec.sourceColumn} = ?`);
      params.push(opts.source);
    }
  }
  if (opts.kind !== undefined) {
    if (spec.kindColumn === null) clauses.push("0");
    else {
      clauses.push(`${spec.kindColumn} = ?`);
      params.push(opts.kind);
    }
  }
  if (opts.minImportance !== undefined) {
    if (spec.importanceColumn === null) clauses.push("0");
    else {
      clauses.push(`${spec.importanceColumn} >= ?`);
      params.push(opts.minImportance);
    }
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Может ли таблица применить фильтр: у неё должна быть нужная колонка. Без этого
 * таблицы без колонки попадали в выдачу НЕотфильтрованными, и total врал. */
function canFilter(spec: TableSpec, opts: QueryOptions): boolean {
  if (opts.source !== undefined && spec.sourceColumn === null) return false;
  if (opts.kind !== undefined && spec.kindColumn === null) return false;
  if (opts.minImportance !== undefined && spec.importanceColumn === null) return false;
  return true;
}

function queryEntries(db: Database, table: MemoryTable, opts: QueryOptions): { total: number; entries: MemoryEntry[] } {
  const spec = TABLE_SPEC[table];
  const where = buildWhere(spec, opts);
  const binder = [...where.params, opts.limit, opts.offset];
  const total = (() => {
    const row = db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM "${table}"${where.sql}`).get(...where.params);
    return row?.n ?? 0;
  })();
  const rows = db
    .query<MemoryEntry, (string | number)[]>(
      // Второй ключ сортировки — id: без него OFFSET-страницы режут блоки равных
      // значений (у важности их сотни) произвольно, и «Показать ещё» может
      // показать строку дважды, пропустив другую.
      `SELECT ${spec.columns} FROM "${table}"${where.sql} ORDER BY ${sortColumn(spec, opts.sort)} DESC NULLS LAST, id ASC LIMIT ? OFFSET ?`,
    )
    .all(...binder);
  return { total, entries: rows.map(row => ({ ...row, table })) };
}

/** Провенанс и выжимки страницы: две пачки запросов на всю страницу, не по одной
 * на запись. Родителя ищем через memory_id (gists/annotations ссылаются на память). */
function enrichPage(db: Database, table: MemoryTable, entries: MemoryEntry[]): void {
  if (entries.length === 0) return;
  if (table === "working_memory" || table === "episodic_memory") {
    const ids = entries.map(entry => entry.id);
    const placeholders = ids.map(() => "?").join(", ");
    if (tableExists(db, "annotations")) {
      const rows = db
        .query<{ memory_id: string; kind: string; value: string }, string[]>(
          `SELECT memory_id, kind, value FROM annotations WHERE memory_id IN (${placeholders}) ORDER BY id`,
        )
        .all(...ids);
      const byMemory = new Map<string, { kind: string; value: string }[]>();
      for (const row of rows) {
        const list = byMemory.get(row.memory_id) ?? [];
        list.push({ kind: row.kind, value: row.value });
        byMemory.set(row.memory_id, list);
      }
      for (const entry of entries) entry.annotations = byMemory.get(entry.id) ?? [];
    }
    // Гисты ссылаются только на эпизоды (episodic_memory), поэтому для памяти
    // отдельный запрос не нужен.
    if (table === "episodic_memory" && tableExists(db, "gists")) {
      const rows = db
        .query<{ memory_id: string; text: string }, string[]>(`SELECT memory_id, text FROM gists WHERE memory_id IN (${placeholders})`)
        .all(...ids);
      const gistByMemory = new Map(rows.map(row => [row.memory_id, row.text]));
      for (const entry of entries) entry.gist = gistByMemory.get(entry.id) ?? null;
    }
    return;
  }
  if (table === "gists") {
    const memoryIds = entries.map(entry => entry.memoryId).filter((id): id is string => id !== null && id.length > 0);
    if (memoryIds.length === 0 || !tableExists(db, "episodic_memory")) return;
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = db
      .query<{ id: string; content: string }, string[]>(`SELECT id, content FROM episodic_memory WHERE id IN (${placeholders})`)
      .all(...memoryIds);
    const episodeById = new Map(rows.map(row => [row.id, row.content]));
    for (const entry of entries) entry.episode = entry.memoryId === null ? null : (episodeById.get(entry.memoryId) ?? null);
    return;
  }
  if (table === "annotations") {
    const memoryIds = entries.map(entry => entry.memoryId).filter((id): id is string => id !== null && id.length > 0);
    if (memoryIds.length === 0 || !tableExists(db, "working_memory")) return;
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = db
      .query<{ id: string; content: string }, string[]>(`SELECT id, content FROM working_memory WHERE id IN (${placeholders})`)
      .all(...memoryIds);
    const memoryById = new Map(rows.map(row => [row.id, row.content]));
    for (const entry of entries) entry.episode = entry.memoryId === null ? null : (memoryById.get(entry.memoryId) ?? null);
  }
}

export function listBanks(): MemoryBankInfo[] {
  let dirs: string[];
  try {
    dirs = readdirSync(BANKS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(isBankName);
  } catch {
    return [];
  }
  const banks: MemoryBankInfo[] = [];
  for (const name of dirs) {
    const dbPath = join(BANKS_DIR, name, "mnemopi.db");
    let stat;
    try {
      stat = statSync(dbPath);
    } catch {
      continue;
    }
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      continue;
    }
    try {
      const tables: { [K in MemoryTable]?: number } = {};
      for (const table of MEMORY_TABLES) tables[table] = countRows(db, table);
      const total = Object.values(tables).reduce((sum, n) => sum + (n ?? 0), 0);
      banks.push({ name, total, tables, bytes: stat.size, mtime: stat.mtimeMs });
    } finally {
      db.close();
    }
  }
  return banks.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export function listEntries(
  bank: string,
  table: MemoryTable,
  opts: QueryOptions,
): { total: number; entries: MemoryEntry[] } | null {
  const db = openBankDb(bank);
  if (!db) return null;
  try {
    if (!tableExists(db, table)) return { total: 0, entries: [] };
    const result = queryEntries(db, table, opts);
    enrichPage(db, table, result.entries);
    return result;
  } finally {
    db.close();
  }
}

/** Поиск сразу по всем разделам: «где я это писал» не должно требовать угадать
 * вкладку. Слияние строго по времени: пул берётся по тому же ключу, по которому
 * сливаем, иначе при sort != ts строки теряются и повторяются. */
export function searchAllEntries(bank: string, opts: QueryOptions): { total: number; entries: MemoryEntry[] } | null {
  const db = openBankDb(bank);
  if (!db) return null;
  try {
    let total = 0;
    const merged: MemoryEntry[] = [];
    const optsForMerge: QueryOptions = { ...opts, sort: "ts" };
    for (const table of MEMORY_TABLES) {
      if (!tableExists(db, table)) continue;
      // Таблица без нужной колонки фильтр применить не может: в такой выдаче
      // строки шли бы НЕотфильтрованными, а total считал бы их как совпадения.
      if (!canFilter(TABLE_SPEC[table], optsForMerge)) continue;
      const result = queryEntries(db, table, { ...optsForMerge, offset: 0, limit: optsForMerge.limit + optsForMerge.offset });
      total += result.total;
      enrichPage(db, table, result.entries);
      merged.push(...result.entries);
    }
    merged.sort((a, b) => Date.parse(b.ts ?? "") - Date.parse(a.ts ?? ""));
    return { total, entries: merged.slice(opts.offset, opts.offset + opts.limit) };
  } finally {
    db.close();
  }
}

export interface MemoryFacets {
  sources: { value: string; count: number }[];
  kinds: { value: string; count: number }[];
}

/** Значения для чипов-фильтров с частотами: без них фильтр — угадайка. */
export function listFacets(bank: string, table: MemoryTable): MemoryFacets | null {
  const db = openBankDb(bank);
  if (!db) return null;
  try {
    if (!tableExists(db, table)) return { sources: [], kinds: [] };
    const spec = TABLE_SPEC[table];
    const group = (column: string | null): { value: string; count: number }[] => {
      if (column === null) return [];
      const rows = db
        .query<{ value: string | null; count: number }, []>(
          `SELECT ${column} AS value, count(*) AS count FROM "${table}" WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column} ORDER BY count DESC, value`,
        )
        .all();
      return rows.filter((row): row is { value: string; count: number } => row.value !== null);
    };
    return { sources: group(spec.sourceColumn), kinds: group(spec.kindColumn) };
  } finally {
    db.close();
  }
}
