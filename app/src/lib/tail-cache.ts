import type { SessionEntry } from "@oh-my-pi/pi-wire";

/**
 * Кеш хвоста сессии для повторных открытий.
 *
 * Зачем: полный снапшот сессии идёт через релей и у тяжёлых сессий занимает мегабайты.
 * Первое открытие ускоряет превью с шлюза (§ быстрый хвост), а повторные — этот кеш:
 * сохранённые последние записи рисуются мгновенно, до сети, и затем заменяются живым
 * снапшотом. Кеш — ускоритель, а не источник правды: любая ошибка чтения/записи
 * просто означает «покажем как раньше».
 *
 * Хранилище — localStorage: синхронное, поэтому первая отрисовка не ждёт промиса.
 * Размер ограничен LRU по числу сессий и отсечкой по байтам, иначе квота 5 МБ
 * закончится на десятке длинных сессий.
 */

const KEY_PREFIX = "ompPocket.tail.v1.";
const ORDER_KEY = "ompPocket.tail.v1.order";
const MAX_SESSIONS = 6;
const MAX_BYTES = 300_000;

interface CachedTail {
	at: number;
	entries: SessionEntry[];
}

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

function readOrder(store: Storage): string[] {
	try {
		const raw = store.getItem(ORDER_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

function writeOrder(store: Storage, order: readonly string[]): void {
	try {
		store.setItem(ORDER_KEY, JSON.stringify(order));
	} catch {
		// квота/приватный режим — кеш просто не обновится
	}
}

/** Прочитать хвост: null означает «кеша нет», а не ошибку. */
export function readTail(sessionId: string | null): SessionEntry[] | null {
	if (sessionId === null || sessionId === "") return null;
	const store = storage();
	if (store === null) return null;
	try {
		const raw = store.getItem(KEY_PREFIX + sessionId);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || !("entries" in parsed)) return null;
		const entries = (parsed as CachedTail).entries;
		if (!Array.isArray(entries) || entries.length === 0) return null;
		// Касание в LRU: последняя открытая сессия — в конце списка.
		const order = readOrder(store).filter(id => id !== sessionId);
		order.push(sessionId);
		writeOrder(store, order);
		return entries as SessionEntry[];
	} catch {
		return null;
	}
}

/** Сохранить хвост (последние записи) и вытеснить самые старые сессии. */
export function writeTail(sessionId: string | null, entries: readonly SessionEntry[]): void {
	if (sessionId === null || sessionId === "") return;
	if (entries.length === 0) return;
	const store = storage();
	if (store === null) return;
	let payload: string;
	try {
		payload = JSON.stringify({ at: Date.now(), entries: entries.slice(-40) } satisfies CachedTail);
	} catch {
		return;
	}
	if (payload.length > MAX_BYTES) return; // слишком тяжёлый хвост — не кладём, кеш не обязателен
	try {
		store.setItem(KEY_PREFIX + sessionId, payload);
	} catch {
		// Квота кончилась: сначала вытесняем старые, затем пробуем ещё раз.
		const order = readOrder(store).filter(id => id !== sessionId);
		for (const id of order.slice(0, Math.ceil(order.length / 2))) {
			try {
				store.removeItem(KEY_PREFIX + id);
			} catch {
				// пропускаем
			}
		}
		try {
			store.setItem(KEY_PREFIX + sessionId, payload);
		} catch {
			return;
		}
	}
	const order = readOrder(store).filter(id => id !== sessionId);
	order.push(sessionId);
	while (order.length > MAX_SESSIONS) {
		const evicted = order.shift();
		if (evicted === undefined) break;
		try {
			store.removeItem(KEY_PREFIX + evicted);
		} catch {
			// пропускаем
		}
	}
	writeOrder(store, order);
}
