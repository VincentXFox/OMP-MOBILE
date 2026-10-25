import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Сводка туду-борда сессии для карточки агента на главной: «Задача 3/7» + полоска.
 * Полный борд читает клиент в самом чате (`app/src/lib/todo-board.ts`), здесь нужен
 * только счётчик — иначе главная тянула бы транскрипты всех агентов. */
export interface TodoProgress {
	done: number;
	total: number;
	/** Фаза с текущей задачей (подпись в карточке), иначе первая незакрытая. */
	activePhase: string | null;
}

/** Результат `todo` лежит в конце транскрипта, но после него агент успевает
 * написать много строк: 1 МиБ хвоста покрывает это с запасом. */
const WINDOW_BYTES = 1024 * 1024;
/** Сколько сессий помним: у каждой записи ключ — путь, значение — stat + сводка. */
const CACHE_LIMIT = 512;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	progress: TodoProgress | null;
}

const cache = new Map<string, CacheEntry>();

function readTail(path: string, size: number): string {
	const window = Math.min(size, WINDOW_BYTES);
	const buffer = Buffer.allocUnsafe(window);
	const fd = openSync(path, "r");
	try {
		// Хвост, а не весь файл: у сессий бывает по несколько мегабайт истории.
		readSync(fd, buffer, 0, window, size - window);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}

function progressFromDetails(details: unknown): TodoProgress | null {
	if (details === null || typeof details !== "object") return null;
	const phasesRaw = (details as Record<string, unknown>)["phases"];
	if (!Array.isArray(phasesRaw)) return null;
	let done = 0;
	let total = 0;
	let inProgressPhase: string | null = null;
	let openPhase: string | null = null;
	for (const phaseRaw of phasesRaw) {
		if (phaseRaw === null || typeof phaseRaw !== "object") continue;
		const phase = phaseRaw as Record<string, unknown>;
		const name = typeof phase["name"] === "string" ? phase["name"] : "";
		// Формы борда отличались между версиями инструмента: tasks и items.
		const tasksRaw = Array.isArray(phase["tasks"]) ? phase["tasks"] : Array.isArray(phase["items"]) ? phase["items"] : [];
		for (const taskRaw of tasksRaw) {
			if (taskRaw === null || typeof taskRaw !== "object") continue;
			const task = taskRaw as Record<string, unknown>;
			const content = typeof task["content"] === "string" ? task["content"] : typeof task["text"] === "string" ? task["text"] : "";
			if (content.length === 0) continue;
			const status = typeof task["status"] === "string" ? task["status"] : "pending";
			total += 1;
			if (status === "completed") done += 1;
			else if (status === "in_progress" && inProgressPhase === null) inProgressPhase = name;
			if (status !== "completed" && status !== "abandoned" && openPhase === null) openPhase = name;
		}
	}
	if (total === 0) return null;
	return { done, total, activePhase: inProgressPhase ?? openPhase };
}

/** Последний результат инструмента `todo` в хвосте файла. */
function scan(text: string, truncated: boolean): TodoProgress | null {
	const lines = text.split("\n");
	// Первая строка обрезана окном — разбирать её нельзя.
	const floor = truncated ? 1 : 0;
	for (let i = lines.length - 1; i >= floor; i--) {
		const line = lines[i]?.trim();
		if (line === undefined || line.length === 0) continue;
		if (!line.includes('"todo"')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const message = (parsed as Record<string, unknown>)["message"];
		if (message === null || typeof message !== "object") continue;
		const msg = message as Record<string, unknown>;
		if (msg["role"] !== "toolResult" || msg["toolName"] !== "todo") continue;
		const progress = progressFromDetails(msg["details"]);
		if (progress !== null) return progress;
	}
	return null;
}

/** Сводка туду-борда сессии; null — туду в ней не трогали. Кеш по (путь, mtime, size):
 * без него пятисекундный опрос реестра перечитывал бы хвосты всех сессий. */
export function todoProgressOf(path: string | null): TodoProgress | null {
	if (path === null || path === "") return null;
	let stat;
	try {
		stat = statSync(path);
	} catch {
		cache.delete(path);
		return null;
	}
	const hit = cache.get(path);
	if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
		return hit.progress;
	}
	let progress: TodoProgress | null;
	try {
		const truncated = stat.size > WINDOW_BYTES;
		progress = scan(readTail(path, stat.size), truncated);
	} catch {
		progress = null;
	}
	// В хвосте не нашлось — последний борд мог остаться выше окна: держим прошлое
	// значение, иначе полоска у работающего агента пропадала бы на ровном месте.
	if (progress === null && hit !== undefined) progress = hit.progress;
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, progress });
	return progress;
}
