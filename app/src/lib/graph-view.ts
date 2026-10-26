/** Чистые помощники раздела «Граф»: подписи видов, подсветка совпавших слов,
 * строка метаданных карточки. Вынесены из компонента, чтобы проверять тестами. */

import type { GraphFact } from "./gateway";

export interface HighlightSegment {
	text: string;
	/** true — кусок совпал со словом запроса и рисуется `<mark>`. */
	hit: boolean;
}

const KIND_LABEL: Record<string, string> = {
	decision: "решение",
	insight: "причина",
	fix: "исправлено",
	rule: "правило",
	error: "ошибка",
	fact: "факт",
};

/** Вид факта по-русски; незнакомый вид возвращаем как есть, а не прячем. */
export function graphKindLabel(kind: string): string {
	const label = KIND_LABEL[kind];
	return label ?? kind;
}

/** Краткое имя проекта: в чипах нужен последний сегмент пути, полный — в title. */
export function shortProject(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	if (trimmed === "") return path;
	const at = trimmed.lastIndexOf("/");
	const tail = at === -1 ? trimmed : trimmed.slice(at + 1);
	return tail === "" ? trimmed : tail;
}

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Разбиение текста на куски по совпавшим словам. Подсветка — узлами React,
 * поэтому возвращаем сегменты, а не HTML. Длинные слова идут первыми: иначе
 * «память» перебьёт «память графа» и хвост останется неподсвеченным. */
export function highlightSegments(text: string, terms: readonly string[]): HighlightSegment[] {
	if (text === "") return [];
	const words = [...new Set(terms.map(term => term.trim()).filter(term => term !== ""))].sort((a, b) => b.length - a.length);
	if (words.length === 0) return [{ text, hit: false }];
	const re = new RegExp(words.map(escapeRe).join("|"), "giu");
	const segments: HighlightSegment[] = [];
	let at = 0;
	for (;;) {
		const found = re.exec(text);
		if (found === null) break;
		const start = found.index;
		const end = start + found[0].length;
		if (start > at) segments.push({ text: text.slice(at, start), hit: false });
		segments.push({ text: text.slice(start, end), hit: true });
		at = end;
		if (found[0].length === 0) re.lastIndex += 1;
	}
	if (segments.length === 0) return [{ text, hit: false }];
	if (at < text.length) segments.push({ text: text.slice(at), hit: false });
	return segments;
}

/** «26.10» или «26.10.2025», если год не текущий: в списке фактов год нужен редко. */
export function graphDateLabel(tsMs: number, now: number = Date.now()): string {
	if (!Number.isFinite(tsMs) || tsMs <= 0) return "без даты";
	const date = new Date(tsMs);
	const day = String(date.getDate()).padStart(2, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return sameYear ? `${day}.${month}` : `${day}.${month}.${date.getFullYear()}`;
}

/** Уверенность 0..1 в проценты; мусорные значения не дают «NaN%». */
export function graphPercent(value: number): string {
	if (!Number.isFinite(value)) return "0%";
	const clamped = Math.min(1, Math.max(0, value));
	return `${Math.round(clamped * 100)}%`;
}

/** Строка под фактом: «проект · дата · упоминаний N · уверенность X». */
export function graphFactMeta(fact: Pick<GraphFact, "project" | "lastSeen" | "mentions" | "confidence">, now?: number): string {
	const project = fact.project === "" ? "без проекта" : fact.project;
	const mentions = Number.isFinite(fact.mentions) ? Math.max(0, fact.mentions) : 0;
	return `${project} · ${graphDateLabel(fact.lastSeen, now)} · упоминаний ${mentions} · уверенность ${graphPercent(fact.confidence)}`;
}
