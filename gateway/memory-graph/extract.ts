import type { EntityKind, FactKind } from "./store.ts";

/** Кандидат в факт: то, что экстрактор вытащил из реплики, до записи в базу. */
export interface FactCandidate {
	kind: FactKind;
	fact: string;
	confidence: number;
	importance: number;
	src: { kind: EntityKind; name: string } | null;
	dst: { kind: EntityKind; name: string } | null;
	sessionId: string | null;
	quote: string | null;
}

export interface ExtractContext {
	/** Каталог проекта сессии: по нему факты группируются и ранжируются. */
	project: string;
	sessionId?: string | null;
}

/** Маркеры смысла: что за утверждение перед нами и насколько ему верить. */
const MARKERS: ReadonlyArray<{ kind: FactKind; re: RegExp; confidence: number; importance: number }> = [
	{
		kind: "decision",
		re: /(?:решил[иа]?|решение|договорились|выбрали|остановились\s+на|поэтому\s+(?:став|делаем|берём|ставим)|итог:)/iu,
		confidence: 0.82,
		importance: 0.85,
	},
	{
		kind: "insight",
		re: /(?:оказалось|причин[аы]|корень|root\s+cause|из-за\s+того|дефект\s+в|виноват[ао]?)/iu,
		confidence: 0.78,
		importance: 0.8,
	},
	{
		kind: "fix",
		re: /(?:починил|починен|исправил|исправлен|поправил|проверено|подтвердил|verified|fixed|resolved)/iu,
		confidence: 0.72,
		importance: 0.72,
	},
	{
		kind: "rule",
		re: /(?:всегда|никогда|нельзя|обязан|правило|предпочита|требуется|только\s+через)/iu,
		confidence: 0.68,
		importance: 0.66,
	},
	{
		kind: "error",
		re: /(?:ошибк[аиу]|падает|упал[ао]?|сломал|не\s+работает|краш|crash|exit\s+code\s+[1-9])/iu,
		confidence: 0.62,
		importance: 0.58,
	},
];

const KNOWN_TOOLS = [
	"omp",
	"bun",
	"node",
	"caddy",
	"nginx",
	"sqlite",
	"systemd",
	"git",
	"gh",
	"docker",
	"redis",
	"postgres",
	"ssh",
	"tsgo",
	"ffmpeg",
	"playwright",
	"mermaid",
] as const;

/** Служебные слова, которые не должны становиться узлами. */
const STOP_ENTITY = new Set(["это", "всё", "все", "там", "тут", "тогда", "потом", "сейчас", "надо", "нужно", "можно"]);

const ENTITY_RES: ReadonlyArray<{ kind: EntityKind; re: RegExp }> = [
	{ kind: "path", re: /(?:~\/|\/)[\w./-]{2,}/gu },
	// Файлы без пути: `todo-board.ts`, `config.json` — самый частый вид сущности в отчётах.
	{ kind: "path", re: /[\w-]+\.(?:ts|tsx|js|mjs|json|jsonl|md|css|scss|py|sh|sql|yml|yaml|toml|db)\b/gu },
	{ kind: "service", re: /\b[\w.-]+\.(?:service|timer|socket)\b/gu },
	{ kind: "host", re: /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z][a-z0-9-]{1,18}\d{1,3}|[a-z0-9-]+\.(?:local|sslip\.io|ru|com))\b/giu },
	{ kind: "tool", re: new RegExp(`\\b(?:${KNOWN_TOOLS.join("|")})\\b`, "giu") },
	// Без `\b`: в JS граница слова считается по ASCII, и `\bПочинил` не совпадает никогда.
	{ kind: "topic", re: /(?:^|[\s(«"'—-])([A-ZА-Я][\w-]{3,})/gu },
];

/** Минимум/максимум длины утверждения: короче — обрывок, длиннее — простыня. */
const MIN_FACT_CHARS = 28;
const MAX_FACT_CHARS = 320;

function clean(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.replace(/\*\*/gu, "")
		.trim();
}

/** Режем текст на утверждения: по переводу строки и по концам предложений. */
export function splitClaims(text: string): string[] {
	const out: string[] = [];
	for (const rawLine of text.split(/\n+/u)) {
		const line = rawLine.replace(/^[\s>*•\-–—\d.)]+/u, "").trim();
		if (line.length === 0) continue;
		for (const part of line.split(/(?<=[.!?…])\s+/u)) {
			const claim = clean(part);
			if (claim.length === 0) continue;
			out.push(claim);
		}
	}
	return out;
}

/** Слишком «технические» строки (код, таблицы, диффы) фактами не считаем. */
function looksLikeCode(claim: string): boolean {
	// Кодовый блок в реплике: два и более инлайн-фрагмента — это уже цитата кода.
	if ((claim.match(/`/gu) ?? []).length >= 2 && /[;{}()=]/u.test(claim)) return true;
	if ((claim.match(/`/gu) ?? []).length >= 3) return true;
	if (/^\s*(?:\||```|diff --git|[-+]{3}\s|\$\s|bun |npm |git )/u.test(claim)) return true;
	// Операторы JS/TS в количестве: факт «починил parse() в files.ts» переживёт
	// (один маркер), а `foo(); if (x) { return 1; }` — нет.
	const codeMarks = (claim.match(/[;{}=]/gu) ?? []).length + (claim.match(/=>|\(\)/gu) ?? []).length;
	if (codeMarks >= 3) return true;
	return false;
}

export function extractEntities(claim: string, project: string): Array<{ kind: EntityKind; name: string }> {
	const found: Array<{ kind: EntityKind; name: string }> = [];
	const seen = new Set<string>();
	const push = (kind: EntityKind, raw: string): void => {
		const name = raw.replace(/[.,;:)\]!?]+$/u, "").trim();
		if (name.length < 2 || STOP_ENTITY.has(name.toLowerCase())) return;
		const key = `${kind}:${name.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		found.push({ kind, name });
	};
	for (const { kind, re } of ENTITY_RES) {
		re.lastIndex = 0;
		for (const match of claim.matchAll(re)) {
			const raw = (match[1] ?? match[0]).trim();
			if (raw.length === 0) continue;
			// Заглавное слово в самом начале — это начало предложения, а не имя.
			if (kind === "topic" && match.index === 0) continue;
			push(kind, raw);
		}
	}
	const projectName = project.split("/").filter(Boolean).pop();
	if (projectName !== undefined && projectName.length > 2 && claim.toLowerCase().includes(projectName.toLowerCase())) {
		push("project", projectName);
	}
	return found.slice(0, 6);
}

/**
 * Разбор одной реплики в кандидаты фактов.
 *
 * Точность важнее полноты: в граф должно попадать то, что потом не стыдно
 * подставить в контекст агента. Поэтому требуем маркер смысла И сущность.
 */
export function extractClaims(text: string, ctx: ExtractContext): FactCandidate[] {
	const out: FactCandidate[] = [];
	const seen = new Set<string>();
	for (const claim of splitClaims(text)) {
		if (claim.length < MIN_FACT_CHARS || claim.length > MAX_FACT_CHARS) continue;
		if (looksLikeCode(claim)) continue;
		const marker = MARKERS.find((m) => m.re.test(claim));
		if (marker === undefined) continue;
		const entities = extractEntities(claim, ctx.project);
		if (entities.length === 0) continue;
		const key = claim.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			kind: marker.kind,
			fact: claim,
			confidence: marker.confidence,
			importance: marker.importance,
			src: entities[0] ?? null,
			dst: entities[1] ?? null,
			sessionId: ctx.sessionId ?? null,
			quote: claim,
		});
	}
	return out;
}

/** Текст реплики из записи транскрипта; null — реплика не текстовая (или это не реплика). */
export function messageText(entry: unknown): string | null {
	if (entry === null || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	const message = record["message"];
	if (message === null || typeof message !== "object") return null;
	const role = (message as Record<string, unknown>)["role"];
	if (role !== "assistant" && role !== "user") return null;
	const content = (message as Record<string, unknown>)["content"];
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		const typed = part as Record<string, unknown>;
		if (typed["type"] === "text" && typeof typed["text"] === "string") parts.push(typed["text"]);
	}
	return parts.length === 0 ? null : parts.join("\n");
}

/** Разбор целого транскрипта (строки JSONL) в кандидаты фактов. */
export function extractFromTranscript(lines: readonly string[], ctx: ExtractContext): FactCandidate[] {
	const out: FactCandidate[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const text = messageText(parsed);
		if (text === null) continue;
		out.push(...extractClaims(text, ctx));
	}
	return out;
}
