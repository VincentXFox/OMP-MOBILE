import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFromTranscript } from "./extract.ts";
import { fileState, graphStats, markFileIndexed, setMeta, upsertFact, type GraphStats } from "./store.ts";

/** Корни с транскриптами сессий: стандартный каталог omp плюс мост Telegram. */
export function sessionRoots(): string[] {
	const home = homedir();
	const roots = [join(home, ".omp", "agent", "sessions")];
	const extra = join(home, ".tgbot", "sessions");
	roots.push(extra);
	return roots;
}

export interface IndexOptions {
	/** Сколько файлов разбирать за один заход — чтобы ход шлюза не вставал. */
	maxFiles?: number;
	/** Бюджет времени в миллисекундах: упираемся — выходим, продолжим в следующий раз. */
	budgetMs?: number;
	now?: number;
}

export interface IndexResult {
	scanned: number;
	changed: number;
	facts: number;
	projects: number;
	exhausted: boolean;
	tookMs: number;
}

/** Все файлы сессий: `<root>/<slug>/<session>.jsonl` и плоские `<root>/*.jsonl`. */
export function listSessionFiles(roots: readonly string[] = sessionRoots()): string[] {
	const files: string[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(root, entry);
			let stat;
			try {
				stat = statSync(full);
			} catch {
				continue;
			}
			if (stat.isFile() && entry.endsWith(".jsonl")) {
				files.push(full);
			} else if (stat.isDirectory()) {
				let inner: string[];
				try {
					inner = readdirSync(full);
				} catch {
					continue;
				}
				for (const child of inner) {
					if (child.endsWith(".jsonl")) files.push(join(full, child));
				}
			}
		}
	}
	return files;
}

interface SessionMeta {
	cwd: string | null;
	title: string | null;
	sessionId: string | null;
}

/** Первые записи транскрипта: каталог проекта, заголовок, id сессии. */
function readSessionMeta(lines: readonly string[], fallbackSlug: string): SessionMeta {
	const meta: SessionMeta = { cwd: null, title: null, sessionId: null };
	for (const line of lines.slice(0, 12)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const record = parsed as Record<string, unknown>;
		const type = record["type"];
		if (type === "session") {
			if (typeof record["cwd"] === "string") meta.cwd = record["cwd"];
			if (typeof record["id"] === "string") meta.sessionId = record["id"];
		} else if (type === "title" && typeof record["title"] === "string") {
			meta.title = record["title"];
		}
	}
	if (meta.cwd === null) {
		// Старые файлы без записи session: имя каталога — последний сегмент проекта.
		const slug = fallbackSlug.replace(/^-/u, "");
		meta.cwd = slug.length > 0 ? `/${slug}` : "/";
	}
	return meta;
}

/**
 * Инкрементальный проход по транскриптам: неизменённые файлы пропускаются,
 * изменённые разбираются целиком (сессия дописывается в конец, но факты
 * дедуплицируются по тексту — повторный проход не плодит строки).
 */
export function indexSessions(db: Database, options: IndexOptions = {}): IndexResult {
	const started = Date.now();
	const budgetMs = options.budgetMs ?? 8000;
	const maxFiles = options.maxFiles ?? 40;
	const now = options.now ?? started;
	const files = listSessionFiles();
	let scanned = 0;
	let changed = 0;
	let facts = 0;
	const projects = new Set<string>();

	for (const file of files) {
		if (scanned >= maxFiles) break;
		if (Date.now() - started > budgetMs) return { scanned, changed, facts, projects: projects.size, exhausted: false, tookMs: Date.now() - started };
		let stat;
		try {
			stat = statSync(file);
		} catch {
			continue;
		}
		scanned += 1;
		const known = fileState(db, file);
		if (known !== null && known.size === stat.size && known.mtime === Math.floor(stat.mtimeMs)) continue;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		const slug = file.split("/").slice(-2, -1)[0] ?? "";
		const meta = readSessionMeta(lines, slug);
		const project = meta.cwd ?? "/";
		projects.add(project);
		const candidates = extractFromTranscript(lines, { project, sessionId: meta.sessionId });
		for (const candidate of candidates) {
			upsertFact(db, { ...candidate, project, at: Math.floor(stat.mtimeMs) });
			facts += 1;
		}
		markFileIndexed(db, file, stat.size, Math.floor(stat.mtimeMs), now);
		changed += 1;
	}

	setMeta(db, "lastIndexedAt", String(now));
	return { scanned, changed, facts, projects: projects.size, exhausted: scanned < maxFiles, tookMs: Date.now() - started };
}

/** Полная перестройка: чистим граф и индексируем заново (кнопка «Пересобрать»). */
export function rebuildGraph(db: Database, options: IndexOptions = {}): IndexResult {
	db.exec("DELETE FROM facts; DELETE FROM nodes; DELETE FROM indexed_files;");
	return indexSessions(db, { ...options, budgetMs: options.budgetMs ?? 60_000, maxFiles: options.maxFiles ?? 100_000 });
}

export function stats(db: Database): GraphStats {
	let bytes = 0;
	try {
		bytes = statSync(db.filename).size;
	} catch {
		bytes = 0;
	}
	return graphStats(db, bytes);
}
