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

/** Bank directory names are machine-generated (`<scope>-<random>`); keep the route safe. */
function isBankName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

/** One normalized memory row; each table maps into this shape for the UI. */
export interface MemoryEntry {
  id: string;
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
}

export interface MemoryBankInfo {
  name: string;
  total: number;
  tables: { [K in MemoryTable]?: number };
  bytes: number;
  mtime: number;
}

interface QueryOptions {
  q?: string;
  limit: number;
  offset: number;
}

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

function queryEntries(db: Database, table: MemoryTable, opts: QueryOptions): { total: number; entries: MemoryEntry[] } {
  const params: (string | number)[] = [];
  let where = "";
  if (opts.q) {
    const searchColumns: Record<MemoryTable, string> = {
      working_memory: "content",
      episodic_memory: "content",
      facts: "subject || ' ' || predicate || ' ' || object",
      gists: "text",
      annotations: "kind || ' ' || value",
    };
    where = ` WHERE ${searchColumns[table]} LIKE ? ESCAPE '\\'`;
    params.push(likePattern(opts.q));
  }

  const total = (() => {
    const row = db.query<{ n: number }, unknown[]>(`SELECT count(*) AS n FROM "${table}"${where}`).get(...params);
    return row?.n ?? 0;
  })();

  const columns: Record<MemoryTable, string> = {
    working_memory: `id, NULL AS title, content AS body, timestamp AS ts, source, memory_type AS kind,
       importance, NULL AS confidence, recall_count AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    episodic_memory: `id, NULL AS title, content AS body, timestamp AS ts, source, memory_type AS kind,
       importance, NULL AS confidence, recall_count AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    facts: `fact_id AS id, subject || ' ' || predicate AS title, object AS body, timestamp AS ts, NULL AS source,
       predicate AS kind, NULL AS importance, confidence, NULL AS recallCount, session_id AS sessionId, NULL AS memoryId`,
    gists: `id, NULL AS title, text AS body, timestamp AS ts, NULL AS source, NULL AS kind,
       NULL AS importance, NULL AS confidence, NULL AS recallCount, NULL AS sessionId, memory_id AS memoryId`,
    annotations: `id, kind AS title, value AS body, created_at AS ts, source, kind, NULL AS importance, confidence,
       NULL AS recallCount, NULL AS sessionId, memory_id AS memoryId`,
  };

  const rows = db
    .query<MemoryEntry, unknown[]>(`SELECT ${columns[table]} FROM "${table}"${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset);
  return { total, entries: rows };
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
    return queryEntries(db, table, opts);
  } finally {
    db.close();
  }
}
