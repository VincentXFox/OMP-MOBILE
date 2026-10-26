import type { Database } from "bun:sqlite";
import { allFacts, projectNodes, type GraphFact, type GraphNode } from "./store.ts";

/** Сколько дней считается «свежим»: вес факта падает вдвое за этот срок. */
const HALF_LIFE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Насколько факт относится к текущему каталогу: 1 — точное совпадение,
 * 0.9 — подпроект, 0.6 — родитель (сессии часто живут в `~`, а проект — `~/omp-mobile`),
 * 0 — чужой проект, такие факты не подмешиваем.
 */
export function projectRelevance(factProject: string, cwd: string | null | undefined): number {
	if (cwd === undefined || cwd === null || cwd === "") return 1;
	const project = factProject.replace(/\/+$/u, "");
	const here = cwd.replace(/\/+$/u, "");
	if (project === here) return 1;
	if (project.startsWith(`${here}/`)) return 0.9;
	if (here.startsWith(`${project}/`) || (project === "" && here.startsWith("/"))) return project === "" || project === "/" ? 0.35 : 0.6;
	return 0;
}

export interface RankOptions {
	/** Каталог проекта; факты родителя берутся с меньшим весом, чужие — нет. */
	project?: string | null;
	/** Запрос на естественном языке; пустой — ранжируем по свежести и важности. */
	query?: string | null;
	limit?: number;
	/** Момент оценки (для тестов и повторяемости). */
	now?: number;
}

export interface RankedFact extends GraphFact {
	score: number;
	/** Почему факт в выдаче: совпавшие слова запроса. */
	matched: string[];
}

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_./-]+/u)
		.map((t) => t.replace(/^[./-]+|[./-]+$/gu, ""))
		.filter((t) => t.length >= 3);
}

/** Доля слов запроса, найденных в факте (0..1). */
function lexicalScore(queryTokens: readonly string[], factNorm: string): { score: number; matched: string[] } {
	if (queryTokens.length === 0) return { score: 0, matched: [] };
	const matched = queryTokens.filter((token) => factNorm.includes(token));
	return { score: matched.length / queryTokens.length, matched };
}

function recencyScore(lastSeen: number, now: number): number {
	const days = Math.max(0, (now - lastSeen) / DAY_MS);
	return Math.exp(-days / HALF_LIFE_DAYS);
}

/**
 * Ранжирование фактов: лексика + свежесть + важность + число упоминаний.
 *
 * Веса подобраны под задачу «подставить в контекст 5–10 фактов»: при пустом
 * запросе лексика равна нулю, и порядок задают свежесть и важность — так
 * агент в новом проекте видит свежие решения, а не случайные старые.
 */
export function rankFacts(facts: readonly GraphFact[], options: RankOptions = {}): RankedFact[] {
	const now = options.now ?? Date.now();
	const limit = options.limit ?? 10;
	const queryTokens = options.query === undefined || options.query === null || options.query.trim() === "" ? [] : tokens(options.query);
	const scored: RankedFact[] = facts.map((fact) => {
		const relevance = projectRelevance(fact.project, options.project ?? null);
		const lex = lexicalScore(queryTokens, fact.norm);
		const recency = recencyScore(fact.lastSeen, now);
		const mentions = Math.min(1, Math.log1p(fact.mentions) / Math.log(10));
		const base =
			0.42 * lex.score +
			0.28 * recency +
			0.18 * fact.importance +
			0.12 * mentions +
			// уверенность сдвигает спорные факты вниз, но не выбрасывает их
			0.02 * fact.confidence;
		const score = base * (0.4 + 0.6 * relevance);
		return { ...fact, score: Number(score.toFixed(6)), matched: lex.matched };
	});
	const relevant = scored.filter((fact) => projectRelevance(fact.project, options.project ?? null) > 0);
	relevant.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
	return relevant.slice(0, Math.max(1, limit));
}

/** Факты для ранжирования: корпус небольшой, поэтому берём всё и режем по проекту в JS. */
export function searchGraph(db: Database, options: RankOptions = {}): RankedFact[] {
	return rankFacts(allFacts(db), options);
}

function projectLabel(project: string): string {
	const parts = project.split("/").filter(Boolean);
	return parts.slice(-2).join("/");
}

function shortDate(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

const KIND_LABEL: Record<string, string> = {
	decision: "решение",
	insight: "причина",
	fix: "исправлено",
	rule: "правило",
	error: "ошибка",
	fact: "факт",
};

/**
 * Компактный блок графа для инъекции в контекст агента.
 *
 * Мнемопи это не заменяет: там личные факты и эпизоды, здесь — проверяемые
 * утверждения проекта с датой и источником. Блок остаётся в пределах maxChars,
 * чтобы не съесть окно контекста.
 */
export function contextBlock(db: Database, options: RankOptions & { maxChars?: number } = {}): string {
	const maxChars = options.maxChars ?? 1400;
	const ranked = searchGraph(db, { ...options, limit: options.limit ?? 12 });
	if (ranked.length === 0) return "";
	const lines: string[] = [];
	let used = 0;
	for (const fact of ranked) {
		const label = KIND_LABEL[fact.kind] ?? fact.kind;
		const text = fact.fact.length > 240 ? `${fact.fact.slice(0, 239)}…` : fact.fact;
		const line = `- [${label}] ${text} (${projectLabel(fact.project)}, ${shortDate(fact.lastSeen)})`;
		if (used + line.length > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return "";
	return ["Граф памяти проекта (проверяемые утверждения, свежие сверху):", ...lines].join("\n");
}

export function topNodes(db: Database, project: string, limit = 12): GraphNode[] {
	return projectNodes(db, project, limit);
}
