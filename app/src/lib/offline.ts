/**
 * Офлайн-слой клиента: кэш ответов шлюза и очередь промптов.
 *
 * Зачем: на мобильной сети шлюз отвечает через секунды, а туннель иногда
 * пропадает целиком. Список сессий и хвост транскрипта меняются медленно,
 * поэтому последняя удачная копия показывается сразу, а свежая подменяет её,
 * когда сеть вернулась. Живость шлюза (opрос /api/hosts) сюда НЕ кэшируется —
 * индикатор связи должен остаться честным.
 *
 * Хранилище — IndexedDB; если его нет (приватный режим, тесты) — память.
 */

const DB_NAME = "pocket-offline";
const DB_VERSION = 1;
const HTTP_STORE = "http";
const OUTBOX_STORE = "outbox";
/** Потолок записи: тяжёлые ответы (полный транскрипт) не кэшируем. */
const MAX_BODY_BYTES = 1_500_000;
/** Сколько ключей держим, чтобы база не росла бесконечно. */
const MAX_HTTP_ENTRIES = 400;

export interface CachedHttp {
	body: unknown;
	/** Время получения ответа (мс). */
	at: number;
}

export interface QueuedPrompt {
	id: number;
	instanceId: string;
	text: string;
	at: number;
}

/** Последняя отметка «показана копия»: key → время получения копии. */
const staleMarks = new Map<string, number>();

/** Время копии для ключа, если последний успешный ответ пришёл из кэша. */
export function staleMark(key: string): number | null {
	return staleMarks.get(key) ?? null;
}

interface Backend {
	get(key: string): Promise<CachedHttp | null>;
	put(key: string, value: CachedHttp): Promise<void>;
	prune(): Promise<void>;
	enqueue(instanceId: string, text: string): Promise<number>;
	take(instanceId: string): Promise<QueuedPrompt[]>;
	count(instanceId: string): Promise<number>;
}

function memoryBackend(): Backend {
	const http = new Map<string, CachedHttp>();
	const outbox: QueuedPrompt[] = [];
	let seq = 1;
	return {
		async get(key) {
			return http.get(key) ?? null;
		},
		async put(key, value) {
			http.set(key, value);
			if (http.size > MAX_HTTP_ENTRIES) {
				const oldest = [...http.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (oldest) http.delete(oldest[0]);
			}
		},
		async prune() {},
		async enqueue(instanceId, text) {
			const id = seq++;
			outbox.push({ id, instanceId, text, at: Date.now() });
			return id;
		},
		async count(instanceId) {
			return outbox.filter(item => item.instanceId === instanceId).length;
		},
		async take(instanceId) {
			const mine = outbox.filter(item => item.instanceId === instanceId);
			for (const item of mine) outbox.splice(outbox.indexOf(item), 1);
			return mine;
		},
	};
}

function idbBackend(): Backend | null {
	if (typeof indexedDB === "undefined") return null;
	const open = (): Promise<IDBDatabase> =>
		new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(HTTP_STORE)) db.createObjectStore(HTTP_STORE);
				if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	const done = (tx: IDBTransaction): Promise<void> =>
		new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	let pending: Promise<IDBDatabase> | null = null;
	const db = (): Promise<IDBDatabase> => (pending ??= open());
	return {
		async get(key) {
			const store = (await db()).transaction(HTTP_STORE, "readonly").objectStore(HTTP_STORE);
			return new Promise<CachedHttp | null>((resolve, reject) => {
				const request = store.get(key);
				request.onsuccess = () => resolve((request.result as CachedHttp | undefined) ?? null);
				request.onerror = () => reject(request.error);
			});
		},
		async put(key, value) {
			const tx = (await db()).transaction(HTTP_STORE, "readwrite");
			tx.objectStore(HTTP_STORE).put(value, key);
			await done(tx);
		},
		async prune() {
			const tx = (await db()).transaction(HTTP_STORE, "readwrite");
			const store = tx.objectStore(HTTP_STORE);
			const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
				const request = store.getAllKeys();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			if (keys.length > MAX_HTTP_ENTRIES) {
				const records = await new Promise<Array<{ key: IDBValidKey; at: number }>>((resolve, reject) => {
					const request = store.getAll();
					request.onsuccess = () => {
						const values = request.result as CachedHttp[];
						resolve(keys.map((key, index) => ({ key, at: values[index]?.at ?? 0 })));
					};
					request.onerror = () => reject(request.error);
				});
				for (const record of records.sort((a, b) => a.at - b.at).slice(0, keys.length - MAX_HTTP_ENTRIES)) store.delete(record.key);
			}
			await done(tx);
		},
		async enqueue(instanceId, text) {
			const tx = (await db()).transaction(OUTBOX_STORE, "readwrite");
			const request = tx.objectStore(OUTBOX_STORE).add({ instanceId, text, at: Date.now() } satisfies Omit<QueuedPrompt, "id">);
			const id = await new Promise<number>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result as number);
				request.onerror = () => reject(request.error);
			});
			await done(tx);
			return id;
		},
		async count(instanceId) {
			const store = (await db()).transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE);
			const all = await new Promise<QueuedPrompt[]>((resolve, reject) => {
				const request = store.getAll();
				request.onsuccess = () => resolve(request.result as QueuedPrompt[]);
				request.onerror = () => reject(request.error);
			});
			return all.filter(item => item.instanceId === instanceId).length;
		},
		async take(instanceId) {
			const tx = (await db()).transaction(OUTBOX_STORE, "readwrite");
			const store = tx.objectStore(OUTBOX_STORE);
			const all = await new Promise<QueuedPrompt[]>((resolve, reject) => {
				const request = store.getAll();
				request.onsuccess = () => resolve(request.result as QueuedPrompt[]);
				request.onerror = () => reject(request.error);
			});
			const mine = all.filter(item => item.instanceId === instanceId).sort((a, b) => a.at - b.at);
			for (const item of mine) store.delete(item.id);
			await done(tx);
			return mine;
		},
	};
}

let backend: Backend | null = null;
function store(): Backend {
	if (backend === null) {
		backend = idbBackend() ?? memoryBackend();
	}
	return backend;
}

/** Только для тестов: подменить хранилище. */
export function __setBackend(next: Backend | null): void {
	backend = next;
}

export function memoryStoreForTests(): Backend {
	return memoryBackend();
}

function sizeOf(body: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(body)).length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Последняя удачная копия ответа, без обращения к сети. */
export async function readCached<T>(key: string): Promise<CachedHttp | null> {
	try {
		return (await store().get(key)) as CachedHttp | null;
	} catch {
		return null;
	}
}

/** Результат загрузки: значение и время копии, если оно пришло из чужого кэша. */
export interface Loaded<T> {
	value: T;
	/** null — данные свежие; число — это время снятия копии (кэш service worker). */
	staleAt: number | null;
}

/**
 * Запрос с кэшем: сеть → запись в кэш; сеть упала → последняя копия.
 * `at !== null` значит, что показана копия, снятая в это время — включая копию
 * из кэша service worker: он отдаёт её с заголовком `X-Pocket-Cache-At`.
 */
export async function cachedJsonMeta<T>(key: string, load: () => Promise<Loaded<T>>): Promise<{ value: T; at: number | null }> {
	try {
		const loaded = await load();
		if (loaded.staleAt !== null) {
			staleMarks.set(key, loaded.staleAt);
			return { value: loaded.value, at: loaded.staleAt };
		}
		if (sizeOf(loaded.value) <= MAX_BODY_BYTES) {
			try {
				await store().put(key, { body: loaded.value, at: Date.now() });
				await store().prune();
			} catch {
				// Хранилище недоступно — кэш просто не ведётся.
			}
		}
		staleMarks.delete(key);
		return { value: loaded.value, at: null };
	} catch (error) {
		const cached = await readCached<T>(key);
		if (cached === null) throw error;
		staleMarks.set(key, cached.at);
		return { value: cached.body as T, at: cached.at };
	}
}

/** Запрос с кэшем для обычного загрузчика (свежий ответ либо копия из браузера). */
export function cachedJson<T>(key: string, load: () => Promise<T>): Promise<{ value: T; at: number | null }> {
	return cachedJsonMeta<T>(key, async () => ({ value: await load(), staleAt: null }));
}

/** Промпт, отправленный без связи: переживёт перезагрузку страницы. */
export async function queuePrompt(instanceId: string, text: string): Promise<number | null> {
	try {
		return await store().enqueue(instanceId, text);
	} catch {
		return null;
	}
}

/** Забрать все отложенные промпты сессии (после успешной отправки они удалены). */
export async function takeQueuedPrompts(instanceId: string): Promise<QueuedPrompt[]> {
	try {
		return await store().take(instanceId);
	} catch {
		return [];
	}
}

/** Сколько промптов ждёт связи (для подписи над полем ввода). */
export async function queuedCount(instanceId: string): Promise<number> {
	try {
		return await store().count(instanceId);
	} catch {
		return 0;
	}
}
