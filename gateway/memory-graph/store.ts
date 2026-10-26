import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Где живёт граф памяти: состояние машины, не репозиторий. */
export function graphDbPath(): string {
	const override = process.env["OMP_GRAPH_DB"];
	if (override !== undefined && override !== "") return override;
	const stateHome = process.env["XDG_STATE_HOME"];
	const base = stateHome !== undefined && stateHome !== "" ? stateHome : join(homedir(), ".local", "state");
	return join(base, "omp-pocket", "graph-memory.db");
}

export type EntityKind = "project" | "host" | "service" | "path" | "tool" | "topic" | "person";
export type FactKind = "decision" | "insight" | "fix" | "rule" | "error" | "fact";

/** Узел графа: сущность, упомянутая в фактах. */
export interface GraphNode {
	id: string;
	kind: EntityKind;
	name: string;
	firstSeen: number;
	lastSeen: number;
	mentions: number;
}

/** Факт — ребро графа с провенансом: кто/что связано, когда и из какой сессии. */
export interface GraphFact {
	id: string;
	kind: FactKind;
	fact: string;
	norm: string;
	src: string | null;
	dst: string | null;
	project: string;
	confidence: number;
	importance: number;
	validFrom: number;
	validTo: number | null;
	mentions: number;
	firstSeen: number;
	lastSeen: number;
	sessionId: string | null;
	quote: string | null;
}

export interface FactInput {
	kind: FactKind;
	fact: string;
	src?: { kind: EntityKind; name: string } | null;
	dst?: { kind: EntityKind; name: string } | null;
	project: string;
	confidence: number;
	importance: number;
	at: number;
	sessionId?: string | null;
	quote?: string | null;
}

export interface GraphStats {
	facts: number;
	nodes: number;
	projects: number;
	byKind: { [K in FactKind]?: number };
	lastIndexedAt: number | null;
	dbBytes: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	mentions INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);

CREATE TABLE IF NOT EXISTS facts (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	fact TEXT NOT NULL,
	norm TEXT NOT NULL,
	src TEXT,
	dst TEXT,
	project TEXT NOT NULL,
	confidence REAL NOT NULL,
	importance REAL NOT NULL,
	valid_from INTEGER NOT NULL,
	valid_to INTEGER,
	mentions INTEGER NOT NULL DEFAULT 1,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	session_id TEXT,
	quote TEXT
);
CREATE INDEX IF NOT EXISTS facts_project ON facts(project);
CREATE INDEX IF NOT EXISTS facts_last_seen ON facts(last_seen);
CREATE INDEX IF NOT EXISTS facts_kind ON facts(kind);

CREATE TABLE IF NOT EXISTS indexed_files (
	path TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	mtime INTEGER NOT NULL,
	indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

/** Открыть (и при необходимости создать) базу графа. */
export function openGraphDb(path = graphDbPath()): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec(SCHEMA);
	return db;
}

/**
 * Открыть граф только на чтение — для хуков и внешних читателей: не создаёт
 * схему, не берёт блокировку записи, падает, если базы ещё нет.
 */
export function openGraphDbReadOnly(path = graphDbPath()): Database {
  return new Database(path, { readonly: true });
}

/** Идентификатор сущности: вид + нормализованное имя. */
export function nodeId(kind: EntityKind, name: string): string {
	return `${kind}:${normalizeEntityName(name)}`;
}

export function normalizeEntityName(name: string): string {
	return name.trim().toLowerCase().replace(/[.,;:)\]!?]+$/u, "");
}

/**
 * Нормализация текста факта для дедупликации и поиска: регистр, пробелы,
 * пунктуация по краям. Внутренние символы не трогаем — на них держится смысл
 * (`--restore`, `de5`, пути).
 */
export function normalizeFact(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.trim()
		.toLowerCase()
		.replace(/^[\s—–-]+/u, "")
		.replace(/[\s.,;:!?]+$/u, "");
}

export function factId(norm: string): string {
	return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

interface FactRow {
	id: string;
	kind: string;
	fact: string;
	norm: string;
	src: string | null;
	dst: string | null;
	project: string;
	confidence: number;
	importance: number;
	valid_from: number;
	valid_to: number | null;
	mentions: number;
	first_seen: number;
	last_seen: number;
	session_id: string | null;
	quote: string | null;
}

function toFact(row: FactRow): GraphFact {
	return {
		id: row.id,
		kind: row.kind as FactKind,
		fact: row.fact,
		norm: row.norm,
		src: row.src,
		dst: row.dst,
		project: row.project,
		confidence: row.confidence,
		importance: row.importance,
		validFrom: row.valid_from,
		validTo: row.valid_to,
		mentions: row.mentions,
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
		sessionId: row.session_id,
		quote: row.quote,
	};
}

/** Вставить или обновить узел; возвращает его id. */
export function upsertNode(db: Database, kind: EntityKind, name: string, at: number): string {
	const id = nodeId(kind, name);
	db.query(
		`INSERT INTO nodes (id, kind, name, first_seen, last_seen, mentions) VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(id) DO UPDATE SET last_seen = ?, mentions = mentions + 1`,
	).run(id, kind, name.trim(), at, at, at);
	return id;
}

/**
 * Вставить факт или усилить существующий. Повтор того же факта (по нормализованному
 * тексту) не плодит строку: растут `mentions`, свежесть и уверенность.
 */
export function upsertFact(db: Database, input: FactInput): "inserted" | "merged" {
	const norm = normalizeFact(input.fact);
	const id = factId(norm);
	const src = input.src ? upsertNode(db, input.src.kind, input.src.name, input.at) : null;
	const dst = input.dst ? upsertNode(db, input.dst.kind, input.dst.name, input.at) : null;
	const existing = db.query<{ id: string }, [string]>("SELECT id FROM facts WHERE id = ?").get(id);
	if (existing !== null) {
		// last_seen не должен «съезжать назад»: повторная индексация старого файла
		// приходит с его mtime, который бывает раньше уже записанного наблюдения.
		db.query(
			`UPDATE facts SET mentions = mentions + 1,
			 last_seen = MAX(last_seen, ?), first_seen = MIN(first_seen, ?),
			 confidence = MAX(confidence, ?), importance = MAX(importance, ?),
			 src = COALESCE(src, ?), dst = COALESCE(dst, ?)
			 WHERE id = ?`,
		).run(input.at, input.at, input.confidence, input.importance, src, dst, id);
		return "merged";
	}
	db.query(
		`INSERT INTO facts (id, kind, fact, norm, src, dst, project, confidence, importance,
			valid_from, valid_to, mentions, first_seen, last_seen, session_id, quote)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
	).run(
		id,
		input.kind,
		input.fact.trim(),
		norm,
		src,
		dst,
		input.project,
		input.confidence,
		input.importance,
		input.at,
		input.at,
		input.at,
		input.sessionId ?? null,
		input.quote ?? null,
	);
	return "inserted";
}

/** Состояние файла сессии: инкрементальный индекс не перечитывает проиндексированное. */
export function fileState(db: Database, path: string): { size: number; mtime: number } | null {
	const row = db.query<{ size: number; mtime: number }, [string]>("SELECT size, mtime FROM indexed_files WHERE path = ?").get(path);
	return row === null ? null : { size: row.size, mtime: row.mtime };
}

export function markFileIndexed(db: Database, path: string, size: number, mtime: number, at = Date.now()): void {
	db.query(
		`INSERT INTO indexed_files (path, size, mtime, indexed_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, indexed_at = excluded.indexed_at`,
	).run(path, size, mtime, at);
}

export function setMeta(db: Database, key: string, value: string): void {
	db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: Database, key: string): string | null {
	const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
	return row?.value ?? null;
}

export function graphStats(db: Database, dbBytes = 0): GraphStats {
	const facts = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM facts").get()?.n ?? 0;
	const nodes = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? 0;
	const projects = db.query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM facts").get()?.n ?? 0;
	const byKind: GraphStats["byKind"] = {};
	for (const row of db.query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM facts GROUP BY kind").all()) {
		byKind[row.kind as FactKind] = row.n;
	}
	const last = getMeta(db, "lastIndexedAt");
	return { facts, nodes, projects, byKind, lastIndexedAt: last === null ? null : Number(last), dbBytes };
}

/** Все факты (для ранжирования в JS: корпус на тысячи строк, SQL-скан дешевле индексов). */
export function allFacts(db: Database, project?: string | null): GraphFact[] {
	const rows =
		project === undefined || project === null
			? db.query<FactRow, []>("SELECT * FROM facts").all()
			: db.query<FactRow, [string]>("SELECT * FROM facts WHERE project = ?").all(project);
	return rows.map(toFact);
}

export function factsById(db: Database, ids: readonly string[]): GraphFact[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(",");
	return db.query<FactRow, string[]>(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...ids).map(toFact);
}

export function projectNodes(db: Database, project: string, limit: number): GraphNode[] {
	// Узлы проекта = узлы, на которые ссылаются его факты, по числу упоминаний.
	const rows = db.query<{ id: string; kind: string; name: string; first_seen: number; last_seen: number; mentions: number }, [string, string, number]>(
		`SELECT n.* FROM nodes n
		 WHERE n.id IN (
			SELECT src FROM facts WHERE project = ? AND src IS NOT NULL
			UNION SELECT dst FROM facts WHERE project = ? AND dst IS NOT NULL
		 )
		 ORDER BY n.mentions DESC, n.last_seen DESC LIMIT ?`,
	).all(project, project, limit);
	return rows.map((row) => ({ id: row.id, kind: row.kind as EntityKind, name: row.name, firstSeen: row.first_seen, lastSeen: row.last_seen, mentions: row.mentions }));
}
