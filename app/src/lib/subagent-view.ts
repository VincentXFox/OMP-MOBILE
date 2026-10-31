/**
 * Разбор сырого JSONL-транскрипта сабагента в строки, пригодные для чтения.
 *
 * Раньше дровер показывал файл целиком в `<pre>` — стена JSON и служебных строк.
 * Здесь то же самое превращается в короткие записи: реплика, вызов инструмента,
 * результат (свёрнутый по умолчанию) и системная строка.
 */

export type SubRowKind = "user" | "assistant" | "tool" | "result" | "system" | "raw";

export interface SubRow {
	kind: SubRowKind;
	/** Текст реплики или результата. */
	text?: string;
	/** Имя инструмента для kind === "tool". */
	name?: string;
	/** Короткий аргумент (команда, путь, шаблон). */
	arg?: string;
	/** Результат с ошибкой (эвристика по началу текста). */
	failed?: boolean;
}

const MAX_TEXT = 600;
const MAX_ARG = 140;
const MAX_RESULT = 1200;

function cleanText(value: string): string {
	return value.replace(/\r/g, "").trim();
}

/** Мусорные реплики вида «.» между вызовами инструментов не показываем. */
function isNoise(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length === 0 || /^[.\s·…]+$/.test(trimmed);
}

function shorten(value: string, max: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Для результатов переносы важны: сохраняем строки и режем только по длине. */
function shortenLines(value: string, max: number): string {
	const text = value.replace(/\r/g, "").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toolArg(name: string, args: Record<string, unknown>): string {
	const candidates = ["command", "cmd", "path", "file_path", "pattern", "query", "url", "prompt", "description", "i"];
	for (const key of candidates) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) return shorten(value, MAX_ARG);
	}
	const keys = Object.keys(args);
	if (keys.length === 0) return "";
	const first = args[keys[0] as string];
	if (typeof first === "string") return shorten(first, MAX_ARG);
	return shorten(JSON.stringify(args), MAX_ARG);
}

function looksFailed(text: string): boolean {
	return /^(?:error\b|ошибка\b|failed\b|traceback\b|exception\b)/i.test(text.trim()) || text.includes("exit code 1");
}

function blocksOf(content: unknown): { type: string; [key: string]: unknown }[] {
	if (Array.isArray(content)) return content.filter((item): item is { type: string } => Boolean(item) && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

/** Основной разбор: каждая строка — либо JSON-событие сессии, либо сырой текст. */
export function parseSubagentRows(raw: string): SubRow[] {
	const rows: SubRow[] = [];
	let pendingRaw: string[] = [];

	const flushRaw = (): void => {
		if (pendingRaw.length === 0) return;
		const text = cleanText(pendingRaw.join("\n"));
		pendingRaw = [];
		if (text.length > 0) rows.push({ kind: "raw", text: shorten(text, MAX_TEXT) });
	};

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (!trimmed.startsWith("{")) {
			pendingRaw.push(line);
			continue;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			pendingRaw.push(line);
			continue;
		}
		flushRaw();
		if (event.type !== "message") continue;
		const message = event.message as { role?: unknown; content?: unknown } | undefined;
		if (!message || typeof message !== "object") continue;
		const role = typeof message.role === "string" ? message.role : "";
		const blocks = blocksOf(message.content);

		if (role === "assistant") {
			for (const block of blocks) {
				if (block.type === "text") {
					const text = cleanText(String(block.text ?? ""));
					if (!isNoise(text)) rows.push({ kind: "assistant", text: shorten(text, MAX_TEXT) });
				} else if (block.type === "toolCall") {
					const name = String(block.name ?? "tool");
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					rows.push({ kind: "tool", name, arg: toolArg(name, args) });
				}
				// thinking пропускаем: это внутренняя кухня, она только шумит.
			}
		} else if (role === "toolResult") {
			const text = cleanText(
				blocks
					.map(block => (block.type === "text" ? String(block.text ?? "") : block.type === "image" ? "[изображение]" : ""))
					.join("\n"),
			);
			if (text.length > 0) rows.push({ kind: "result", text: shortenLines(text, MAX_RESULT), failed: looksFailed(text) });
		} else if (role === "user") {
			const text = cleanText(blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n"));
			if (!isNoise(text)) rows.push({ kind: "user", text: shorten(text, MAX_TEXT) });
		} else if (role === "developer") {
			const text = cleanText(blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n"));
			if (text.length > 0) rows.push({ kind: "system", text: shorten(text, 160) });
		}
	}
	flushRaw();
	return rows;
}

/** Строки результата для показа: свёрнуто до трёх строк, пока не раскрыли. */
export function previewLines(text: string, expanded: boolean, limit = 3): { lines: string[]; hidden: number } {
	const lines = text.split("\n");
	if (expanded || lines.length <= limit) return { lines, hidden: 0 };
	return { lines: lines.slice(0, limit), hidden: lines.length - limit };
}
