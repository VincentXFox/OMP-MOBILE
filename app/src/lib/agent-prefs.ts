/**
 * Локальные предпочтения хаба агентов. Ключ — sessionId, а не instanceId: он
 * переживает перезапуск сессии, сбой питания и remap instanceId в шлюзе, поэтому
 * «закреплён» и «недавно открыт» не теряются вместе с процессом.
 */

const PINS_KEY = "ompPocket.agPins";
const OPENED_KEY = "ompPocket.agOpened";
const COLLAPSED_KEY = "ompPocket.agCollapsed";
/** Хватит на все живые сессии; старые вытесняются по времени открытия. */
const OPENED_LIMIT = 80;

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return fallback;
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? (parsed as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// приватный режим или переполнение — предпочтение живёт до перезагрузки
	}
}

function readPins(): string[] {
	const pins = readJson<unknown>(PINS_KEY, []);
	return Array.isArray(pins) ? pins.filter((p): p is string => typeof p === "string") : [];
}

/** Закреплённые сессии, свежезакреплённые первыми. */
export function pinnedSessions(): string[] {
	return readPins();
}

/** Переключает закрепление и возвращает новый список. */
export function togglePinned(sessionId: string): string[] {
	const pins = readPins();
	const next = pins.includes(sessionId) ? pins.filter(p => p !== sessionId) : [sessionId, ...pins];
	writeJson(PINS_KEY, next);
	return next;
}

/** Времена последнего открытия по sessionId — один разбор localStorage на рендер списка. */
export function openedTimes(): Record<string, number> {
	const opened = readJson<Record<string, unknown>>(OPENED_KEY, {});
	const out: Record<string, number> = {};
	for (const [id, at] of Object.entries(opened)) if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
	return out;
}

/** Отметка «открывал»: поднимает сессию в списке наверх — ищем глазами то,
 * с чем работали последним, а не то, что старше по времени запуска. */
export function markOpened(sessionId: string): void {
	const opened = openedTimes();
	opened[sessionId] = Date.now();
	const entries = Object.entries(opened).sort((a, b) => b[1] - a[1]).slice(0, OPENED_LIMIT);
	writeJson(OPENED_KEY, Object.fromEntries(entries));
}

/** Явные состояния секций, выбранные пользователем: отсутствие ключа = дефолт
 * секции (у «Черновиков» и «Спят» он свёрнутый, у остальных раскрытый). */
export function sectionCollapsedPrefs(): Record<string, boolean> {
	const stored = readJson<Record<string, unknown>>(COLLAPSED_KEY, {});
	const out: Record<string, boolean> = {};
	for (const [id, collapsed] of Object.entries(stored)) if (typeof collapsed === "boolean") out[id] = collapsed;
	return out;
}

export function setSectionCollapsed(sectionId: string, collapsed: boolean): Record<string, boolean> {
	const next = { ...sectionCollapsedPrefs(), [sectionId]: collapsed };
	writeJson(COLLAPSED_KEY, next);
	return next;
}
