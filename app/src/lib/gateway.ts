import type { SessionEntry } from "@oh-my-pi/pi-wire";

export interface HostInfo {
	instanceId: string;
	generation: number;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	/** Явное имя, заданное пользователем (кириллица, живёт по sessionId). */
	displayName: string | null;
	cwd: string;
	model: { provider: string; id: string };
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy: boolean;
	access: "view" | "control";
	/** false = запись реестра с мёртвым процессом: join невозможен, нужен resume. */
	alive?: boolean;
	/** Полный путь к .jsonl сессии (для resume), null/undefined если не найден. */
	sessionFile?: string | null;
	/** Заголовок из файла сессии: имя на момент старта реестр не знает,
	 * у сессий без панели шлюза его нет вообще. */
	sessionTitle?: string | null;
	/** Первый запрос пользователя — имя для сессии без заголовка. */
	sessionPreview?: string | null;
	/** Стол штата: своя папка и закреплённая ответственность (null — агент вне штата). */
	desk?: DeskRef | null;
	/** Сводка туду-борда сессии для полоски в карточке (null — туду не трогали). */
	todo?: TodoProgressRef | null;
}

/** Прогресс туду-борда агента: счётчик и подпись текущей фазы. */
export interface TodoProgressRef {
	done: number;
	total: number;
	activePhase: string | null;
}

/** Стол штата: папка ~/OMP/<slug> и то, за что в ней отвечают. */
export interface DeskRef {
	slug: string;
	role: string;
	dir: string;
}

const BASES_KEY = "ompPocket.gwBases";
const ACTIVE_KEY = "ompPocket.gwActive";
const LEGACY_BASE_KEY = "ompPocket.gwBase";
const TOKEN_KEY = "ompPocket.token";

/** Пробелы и хвостовые слэши не делают адрес другим: `BASE/` ≡ `BASE`. */
function normalizeBase(v: string): string {
	return v.trim().replace(/\/+$/, "");
}

/** Список адресов шлюза. При первом чтении после обновления переносит старый одиночный ключ. */
function readBases(): string[] {
	try {
		const raw = localStorage.getItem(BASES_KEY);
		if (raw !== null) {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			const out: string[] = [];
			for (const item of parsed) {
				if (typeof item !== "string") continue;
				const base = normalizeBase(item);
				if (base && !out.includes(base)) out.push(base);
			}
			return out;
		}
		// Миграция: ompPocket.gwBase → массив; старый ключ удаляем.
		const legacy = localStorage.getItem(LEGACY_BASE_KEY);
		if (legacy !== null) {
			localStorage.removeItem(LEGACY_BASE_KEY);
			const base = normalizeBase(legacy);
			const migrated = base ? [base] : [];
			localStorage.setItem(BASES_KEY, JSON.stringify(migrated));
			return migrated;
		}
		return [];
	} catch {
		return [];
	}
}

/** Адреса-кандидаты в порядке приоритета (первый = желаемый, пустой список = origin приложения). */
export function getGatewayBases(): string[] {
	return readBases();
}

export function setGatewayBases(bases: string[]): void {
	const clean: string[] = [];
	for (const item of bases) {
		if (typeof item !== "string") continue;
		const base = normalizeBase(item);
		if (base && !clean.includes(base)) clean.push(base);
	}
	try {
		localStorage.setItem(BASES_KEY, JSON.stringify(clean));
	} catch {
		// storage unavailable — non-fatal
	}
}

/** Текущий рабочий адрес. "" = origin приложения (same-origin /api/*). */
export function getActiveBase(): string {
	try {
		const stored = localStorage.getItem(ACTIVE_KEY);
		if (stored !== null) return stored;
	} catch {
		// storage unavailable — падаем на первый из списка
	}
	return readBases()[0] ?? "";
}

export function setActiveBase(base: string): void {
	try {
		localStorage.setItem(ACTIVE_KEY, normalizeBase(base));
	} catch {
		// storage unavailable — non-fatal
	}
}

/** Активный адрес шлюза (для push.ts / sw.js): "" = тот же origin, что и приложение. */
export function getGatewayBase(): string {
	return getActiveBase();
}

export function getToken(): string {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

/** Кладёт файл (картинку или бинарник) на шлюз; урл секретный (UUID), без Bearer. */
export async function uploadAttachment(bytes: Uint8Array, mimeType: string, originalName = "file"): Promise<string> {
	const form = new FormData();
	const file = new File([bytes as BlobPart], originalName, { type: mimeType });
	form.append("file", file);
	const data = await request<{ url?: string }>("/api/attach", { method: "POST", body: form });
	if (!data.url) throw new Error("шлюз не вернул ссылку на вложение");
	return data.url;
}

export function setToken(v: string): void {
	try {
		if (v) localStorage.setItem(TOKEN_KEY, v);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage unavailable — non-fatal
	}
}

export class GatewayError extends Error {
	status: number;
	/** Машинный код ошибки из тела ответа шлюза ("agent_not_managed" и т.п.), если он есть. */
	code?: string;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.name = "GatewayError";
		this.status = status;
		this.code = code;
	}
}

function baseUrl(base: string, path: string): string {
	return `${normalizeBase(base)}${path}`;
}

/** Кандидаты: активный адрес первым, затем остальные из списка, затем origin приложения. */
function candidateBases(): string[] {
	const list: string[] = [];
	const add = (base: string): void => {
		if (!list.includes(base)) list.push(base);
	};
	add(getActiveBase());
	for (const base of readBases()) add(base);
	add("");
	return list;
}

/**
 * Проверка живости адреса: любой HTTP-ответ (включая 401/404) = true,
 * сетевая ошибка или таймаут = false. /api/health отвечает без токена.
 */
export async function pingBase(base: string, timeoutMs = 3000): Promise<boolean> {
	try {
		await fetch(`${normalizeBase(base)}/api/health`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
		return true;
	} catch {
		return false;
	}
}

function authHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	if (getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
	return headers;
}

async function errorFromResponse(res: Response): Promise<GatewayError> {
	let message = `HTTP ${res.status}`;
	let code: string | undefined;
	try {
		const body: unknown = await res.json();
		if (body && typeof body === "object") {
			if ("error" in body && typeof body.error === "string") message = body.error;
			if ("code" in body && typeof body.code === "string") code = body.code;
		}
	} catch {
		// non-JSON body — keep the generic message
	}
	return new GatewayError(res.status, message, code);
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
	// таймаут 10с: недостижимый base (упавший LAN-адрес/мёртвый туннель)
	// не должен висеть до TCP-таймаута ОС, пока поллинг плодит запросы.
	// AbortSignal.any есть не во всех браузерах — фолбэк на одиночный таймаут.
	const timeout = AbortSignal.timeout(10_000);
	const signal = typeof AbortSignal.any === "function" && init?.signal
		? AbortSignal.any([init.signal, timeout])
		: (init?.signal ?? timeout);
	return fetch(url, { ...init, headers: authHeaders(init?.headers), signal });
}

/**
 * Идёт по кандидатам, пока не получит HTTP-ответ. Сетевая ошибка/таймаут (соединение
 * не установилось) → следующий адрес; любой ответ (даже ошибка сервера) фиксирует
 * победителя в ompPocket.gwActive и отдаётся вызывающему. Повтора того же адреса нет.
 * Отмена вызывающей стороной (init.signal) прерывает перебор.
 *
 * Небезопасные методы (POST/PUT/DELETE) перебора НЕ получают: запрос мог выполниться,
 * а ответ — потеряться (например, раздача задачи супер-агенту), и повтор на другом
 * адресе дал бы дубль. Переключение на живой адрес к тому моменту уже сделал поллинг
 * /api/hosts, поэтому одиночная попытка бьёт по правильному кандидату.
 */
async function fetchWithFailover(path: string, init?: RequestInit): Promise<Response> {
	const active = getActiveBase();
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return fetchWithTimeout(baseUrl(active, path), init);
	}
	let lastErr: GatewayError | null = null;
	for (const base of candidateBases()) {
		try {
			const res = await fetchWithTimeout(baseUrl(base, path), init);
			if (base !== active) setActiveBase(base);
			return res;
		} catch (err) {
			const failure = err instanceof GatewayError ? err : new GatewayError(0, err instanceof Error ? err.message : String(err));
			if (init?.signal?.aborted) throw failure;
			lastErr = failure;
		}
	}
	throw lastErr ?? new GatewayError(0, "нет доступных адресов шлюза");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetchWithFailover(path, init);
	if (res.status === 401) throw new GatewayError(401, "Требуется токен доступа");
	if (!res.ok) throw await errorFromResponse(res);
	return (await res.json()) as T;
}

/** Speech-to-text: raw webm/opus bytes → распознанный текст. 400 = >10 МБ; 502 = STT недоступен. */
export async function transcribeAudio(blob: Blob, signal?: AbortSignal): Promise<string> {
	const data = await request<{ ok?: boolean; text?: unknown; error?: unknown }>("/api/stt", {
		method: "POST",
		headers: { "Content-Type": blob.type || "audio/webm" },
		body: blob,
		signal,
	});
	if (typeof data.text === "string") return data.text;
	throw new GatewayError(
		502,
		typeof data.error === "string" ? data.error : "STT вернул пустой ответ",
	);
}

export async function fetchHosts(signal?: AbortSignal): Promise<HostInfo[]> {
	const data = await request<{ hosts: HostInfo[] }>("/api/hosts", { signal });
	return Array.isArray(data.hosts) ? data.hosts : [];
}

/** Переименовать агента (видно в списках приложения). */
export function renameAgent(instanceId: string, name: string): Promise<void> {
	return request<void>(`/api/agents/${encodeURIComponent(instanceId)}/rename`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
}

/* ---- локальные переопределения имён агентов (клиентский кэш) ---- */

const nameOverrides = new Map<string, string>();

export function nameOverride(instanceId: string): string | undefined {
	return nameOverrides.get(instanceId);
}

export function setNameOverride(instanceId: string, name: string): void {
	if (name.trim().length === 0) nameOverrides.delete(instanceId);
	else nameOverrides.set(instanceId, name);
}

/* ---- agent memory (mnemopi banks) ---- */

export type MemoryTable = "working_memory" | "facts" | "episodic_memory" | "gists" | "annotations";

export interface MemoryBank {
	name: string;
	total: number;
	tables: Partial<Record<MemoryTable, number>>;
	bytes: number;
	mtime: number;
}

/** Normalized memory row; the gateway maps every mnemopi table into this shape. */
export interface MemoryEntry {
	id: string;
	/** Раздел, из которого пришла запись (заполняется в режиме «всё»). */
	table?: MemoryTable;
	title: string | null;
	body: string;
	ts: string | null;
	source: string | null;
	kind: string | null;
	importance: number | null;
	confidence: number | null;
	recallCount: number | null;
	sessionId: string | null;
	memoryId: string | null;
	/** Провенанс Mnemopi: occurred_on, has_source и прочие метки памяти. */
	annotations?: { kind: string; value: string }[];
	/** Короткая выжимка памяти (таблица gists). */
	gist?: string | null;
	/** Для гиста/аннотации — текст родительской записи, чтобы строка не читалась обрубком. */
	episode?: string | null;
}

/** По чему сортировать раздел: свежесть, важность, число вспоминаний, уверенность. */
export type MemorySort = "ts" | "importance" | "recall" | "confidence";

/** Раздел памяти либо поиск сразу по всем разделам. */
export type MemoryScope = MemoryTable | "all";

export interface MemoryFacets {
	sources: { value: string; count: number }[];
	kinds: { value: string; count: number }[];
}

export async function fetchMemoryBanks(signal?: AbortSignal): Promise<MemoryBank[]> {
	const data = await request<{ banks: MemoryBank[] }>("/api/memory/banks", { signal });
	return Array.isArray(data.banks) ? data.banks : [];
}

export async function fetchMemoryFacets(bank: string, type: MemoryTable, signal?: AbortSignal): Promise<MemoryFacets> {
	const params = new URLSearchParams({ type });
	const data = await request<MemoryFacets>(`/api/memory/banks/${encodeURIComponent(bank)}/facets?${params}`, { signal });
	return { sources: data.sources ?? [], kinds: data.kinds ?? [] };
}

/* ---- persisted sessions (resurrect dead agents) ---- */

export type SessionStatus = "live" | "complete" | "aborted" | "error" | "interrupted" | "unknown";

export interface SessionSummary {
	id: string;
	path: string;
	projectSlug: string;
	cwd: string | null;
	title: string | null;
	titleSource: string | null;
	/** Родительская сессия — форк/сиблинг после сбоя указывает на корень. */
	parentId: string | null;
	/** Первый пользовательский текст — кириллический предпросмотр без title. */
	preview: string | null;
	/** Время создания из имени файла (mtime прыгает при каждом resume). */
	createdTs: number;
	status: SessionStatus;
	modified: number;
	size: number;
}

/** Переименовать сессию кириллицей: title-слот omp + постоянное имя. */
export async function renameSession(path: string, title: string): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
	try {
		const data = await request<{ ok?: boolean; title?: unknown; error?: unknown }>("/api/sessions/rename", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, title }),
		});
		if (data.ok === true && typeof data.title === "string") return { ok: true, title: data.title };
		return { ok: false, error: typeof data.error === "string" ? data.error : "Некорректный ответ шлюза" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Старый instanceId → живой после автоворестора (null = сессия ещё мертва). */
export async function remapSession(instanceId: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const data = await request<{ instanceId?: unknown }>(`/api/sessions/remap?instanceId=${encodeURIComponent(instanceId)}`, { signal });
		return typeof data.instanceId === "string" ? data.instanceId : null;
	} catch {
		return null;
	}
}

export async function fetchSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
	const data = await request<{ sessions: SessionSummary[] }>("/api/sessions", { signal });
	return Array.isArray(data.sessions) ? data.sessions : [];
}

/* ---- лента активности по сессиям ---- */

export interface ActivityRow {
	id: string;
	sessionId: string;
	sessionPath: string;
	sessionTitle: string | null;
	cwd: string | null;
	kind: "message" | "tool" | "error";
	role: string | null;
	text: string;
	ts: string;
}

export async function fetchActivity(limit = 60, signal?: AbortSignal): Promise<ActivityRow[]> {
	const data = await request<{ rows?: ActivityRow[] }>(`/api/activity?limit=${limit}`, { signal });
	return Array.isArray(data.rows) ? data.rows : [];
}

/* ---- полнотекстовый поиск по репликам сессий ---- */

/** role=user — только то, что писал человек; all — плюс ответы агента. */
export type SessionSearchRole = "user" | "all";

export interface SessionSearchSnippet {
	role: "user" | "assistant";
	ts: number;
	/** Отрывок вокруг совпадения. */
	text: string;
	/** Смещение и длина совпадения внутри text — для подсветки. */
	start: number;
	length: number;
}

export interface SessionSearchHit {
	sessionId: string;
	path: string;
	cwd: string | null;
	title: string | null;
	preview: string | null;
	createdTs: number;
	modified: number;
	lastMatchTs: number;
	matches: number;
	/** message — все слова в одной реплике; session — слова в разных репликах. */
	scope: "message" | "session";
	snippets: SessionSearchSnippet[];
}

export interface SessionSearchStatus {
	sessions: number;
	messages: number;
	/** Сколько файлов ещё не прочитано в индекс (клиент доопрашивает, пока > 0). */
	pendingFiles: number;
	indexing: boolean;
	indexedAt: number | null;
	lastScanMs: number | null;
}

export interface SessionSearchResponse {
	query: string;
	role: SessionSearchRole;
	status: SessionSearchStatus;
	results: SessionSearchHit[];
}

export async function searchSessions(query: string, role: SessionSearchRole, signal?: AbortSignal): Promise<SessionSearchResponse> {
	const params = new URLSearchParams({ q: query, role });
	const data = await request<SessionSearchResponse>(`/api/sessions/search?${params.toString()}`, { signal });
	return {
		query: data.query ?? query,
		role: data.role ?? role,
		status: data.status,
		results: Array.isArray(data.results) ? data.results : [],
	};
}

/** Результат запуска/возобновления. Поля необязательные сознательно: проект
 *  собирается без `strictNullChecks`, и там `ok: true` не сужает объединение —
 *  вызывающий обязан проверить значение, а не доверять литералу. */
export interface AgentResumeResult {
	ok: boolean;
	instanceId?: string;
	error?: string;
}

export type ResumeMode = "resume" | "restore";

export async function resumeSession(cwd: string, session: string, opts: { model?: string; label?: string; mode?: ResumeMode } = {}): Promise<AgentResumeResult> {
	try {
		const data = await request<{ ok?: boolean; instanceId?: unknown; error?: unknown }>("/api/agents/resume", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd, session, model: opts.model, label: opts.label, mode: opts.mode }),
		});
		if (typeof data.instanceId === "string") return { ok: true, instanceId: data.instanceId };
		return { ok: false, error: typeof data.error === "string" ? data.error : "Некорректный ответ шлюза" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Возобновить завершённую сессию из карточки Агентов: файл сессии уже известен. */
export function resumeAgentHost(cwd: string, sessionFile: string): Promise<AgentResumeResult> {
	return resumeSession(cwd, sessionFile, { mode: "resume" });
}

export async function fetchMemoryEntries(
	bank: string,
	type: MemoryScope,
	opts: { q?: string; sort?: MemorySort; source?: string; kind?: string; minImportance?: number; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<{ total: number; entries: MemoryEntry[] }> {
	const params = new URLSearchParams({ type });
	if (opts.q) params.set("q", opts.q);
	if (opts.sort) params.set("sort", opts.sort);
	if (opts.source) params.set("source", opts.source);
	if (opts.kind) params.set("kind", opts.kind);
	if (opts.minImportance != null) params.set("minImportance", String(opts.minImportance));
	if (opts.limit != null) params.set("limit", String(opts.limit));
	if (opts.offset != null) params.set("offset", String(opts.offset));
	return request(`/api/memory/banks/${encodeURIComponent(bank)}/entries?${params}`, { signal: opts.signal });
}

/* ---- граф фактов памяти (второй слой рядом с банками Mnemopi) ---- */

/** Вид связи в графе: решение, наблюдение, исправление, правило, ошибка, факт. */
export type GraphFactKind = "decision" | "insight" | "fix" | "rule" | "error" | "fact";

/** Факт графа «источник — утверждение — приёмник» вместе с цитатой-доказательством. */
export interface GraphFact {
	id: string;
	kind: GraphFactKind;
	fact: string;
	norm: string;
	src: string | null;
	dst: string | null;
	/** Проект (cwd), в котором факт был извлечён. */
	project: string;
	confidence: number;
	importance: number;
	validFrom: number;
	validTo: number | null;
	mentions: number;
	firstSeen: number;
	lastSeen: number;
	sessionId: string | null;
	/** Дословная цитата из сессии — доказательство под фактом. */
	quote: string | null;
	/** Релевантность запросу (только в результатах поиска). */
	score: number;
	/** Слова запроса, совпавшие в тексте (только в результатах поиска). */
	matched: string[];
}

export type GraphNodeKind = "project" | "host" | "service" | "path" | "tool" | "topic" | "person";

/** Узел графа: сущность, вокруг которой собираются факты. */
export interface GraphNode {
	id: string;
	kind: GraphNodeKind;
	name: string;
	firstSeen: number;
	lastSeen: number;
	mentions: number;
}

export interface GraphStats {
	facts: number;
	nodes: number;
	projects: number;
	byKind: Partial<Record<GraphFactKind, number>>;
	/** Момент последней индексации (epoch ms), null — граф ещё не собирался. */
	lastIndexedAt: number | null;
	dbBytes: number;
	nodes_top: GraphNode[];
}

export interface GraphRebuildResult {
	ok: boolean;
	scanned: number;
	changed: number;
	facts: number;
	projects: number;
	tookMs: number;
	lastIndexedAt: number | null;
}

/** Время в ответах графа числовое, но защищаемся и от ISO-строки: карточка без
 * даты читается лучше, чем карточка с «Invalid Date». */
function toMs(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** `?project=…` для запросов графа: без проекта — все проекты. */
function graphQuery(project?: string | null): string {
	const params = new URLSearchParams();
	if (project != null && project !== "") params.set("project", project);
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

function normalizeNode(raw: Partial<GraphNode>): GraphNode {
	return {
		id: String(raw.id ?? ""),
		kind: (raw.kind ?? "topic") as GraphNodeKind,
		name: String(raw.name ?? ""),
		firstSeen: toMs(raw.firstSeen) ?? 0,
		lastSeen: toMs(raw.lastSeen) ?? 0,
		mentions: Number(raw.mentions ?? 0),
	};
}

function normalizeFact(raw: Partial<GraphFact>): GraphFact {
	return {
		id: String(raw.id ?? ""),
		kind: (raw.kind ?? "fact") as GraphFactKind,
		fact: String(raw.fact ?? ""),
		norm: String(raw.norm ?? ""),
		src: raw.src ?? null,
		dst: raw.dst ?? null,
		project: String(raw.project ?? ""),
		confidence: Number(raw.confidence ?? 0),
		importance: Number(raw.importance ?? 0),
		validFrom: toMs(raw.validFrom) ?? 0,
		validTo: toMs(raw.validTo),
		mentions: Number(raw.mentions ?? 0),
		firstSeen: toMs(raw.firstSeen) ?? 0,
		lastSeen: toMs(raw.lastSeen) ?? 0,
		sessionId: raw.sessionId ?? null,
		quote: raw.quote ?? null,
		score: Number(raw.score ?? 0),
		matched: Array.isArray(raw.matched) ? raw.matched.filter(item => typeof item === "string") : [],
	};
}

export async function graphStats(project?: string | null, signal?: AbortSignal): Promise<GraphStats> {
	const data = await request<Partial<GraphStats>>(`/api/graph/stats${graphQuery(project)}`, { signal });
	return {
		facts: Number(data.facts ?? 0),
		nodes: Number(data.nodes ?? 0),
		projects: Number(data.projects ?? 0),
		byKind: data.byKind ?? {},
		lastIndexedAt: toMs(data.lastIndexedAt),
		dbBytes: Number(data.dbBytes ?? 0),
		nodes_top: Array.isArray(data.nodes_top) ? data.nodes_top.map(normalizeNode) : [],
	};
}

/** Узел карты: то же, что GraphNode, плюс степень для размера кружка. */
export interface GraphMapNodeView {
	id: string;
	kind: GraphNodeKind;
	name: string;
	mentions: number;
	degree: number;
}

export interface GraphMapEdgeView {
	src: string;
	dst: string;
	kind: GraphFactKind;
	weight: number;
	/** Синтетическое ребро «проект ↔ сущность»: рисуется и пружинит слабее. */
	hub?: boolean;
}

export interface GraphMapData {
	nodes: GraphMapNodeView[];
	edges: GraphMapEdgeView[];
	totalNodes: number;
	totalEdges: number;
	truncated: boolean;
}

/** Карта графа для визуализации: узлы и рёбра уже обрезаны шлюзом. */
export async function graphMap(project?: string | null, signal?: AbortSignal): Promise<GraphMapData> {
	const data = await request<Partial<GraphMapData>>(`/api/graph/map${graphQuery(project)}`, { signal });
	const nodes: GraphMapNodeView[] = Array.isArray(data.nodes)
		? data.nodes.map(node => ({
				id: String(node.id ?? ""),
				kind: (node.kind ?? "topic") as GraphNodeKind,
				name: typeof node.name === "string" && node.name !== "" ? node.name : String(node.id ?? ""),
				mentions: Number(node.mentions ?? 0),
				degree: Number(node.degree ?? 0),
			}))
		: [];
	const edges: GraphMapEdgeView[] = Array.isArray(data.edges)
		? data.edges
				.filter(edge => typeof edge.src === "string" && typeof edge.dst === "string")
				.map(edge => ({
					src: String(edge.src),
					dst: String(edge.dst),
					kind: (edge.kind ?? "fact") as GraphFactKind,
					weight: Number(edge.weight ?? 1),
					hub: edge.hub === true,
				}))
		: [];
	return {
		nodes,
		edges,
		totalNodes: Number(data.totalNodes ?? nodes.length),
		totalEdges: Number(data.totalEdges ?? edges.length),
		truncated: data.truncated === true,
	};
}

export async function graphSearch(
	q: string,
	opts: { project?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<GraphFact[]> {
	const params = new URLSearchParams({ q });
	if (opts.project != null && opts.project !== "") params.set("project", opts.project);
	if (opts.limit != null) params.set("limit", String(opts.limit));
	const data = await request<{ facts?: Partial<GraphFact>[] }>(`/api/graph/search?${params}`, { signal: opts.signal });
	return Array.isArray(data.facts) ? data.facts.map(normalizeFact) : [];
}

export async function graphNodes(project?: string | null, signal?: AbortSignal): Promise<GraphNode[]> {
	const data = await request<{ nodes?: Partial<GraphNode>[] }>(`/api/graph/nodes${graphQuery(project)}`, { signal });
	return Array.isArray(data.nodes) ? data.nodes.map(normalizeNode) : [];
}

/** Полная пересборка графа по файлам памяти: шлюз может думать секунды, поэтому
 * состояние «идёт пересборка» рисует вызывающий экран, а не таймаут запроса. */
export async function graphRebuild(): Promise<GraphRebuildResult> {
	const data = await request<Partial<GraphRebuildResult>>("/api/graph/rebuild", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	return {
		ok: data.ok === true,
		scanned: Number(data.scanned ?? 0),
		changed: Number(data.changed ?? 0),
		facts: Number(data.facts ?? 0),
		projects: Number(data.projects ?? 0),
		tookMs: Number(data.tookMs ?? 0),
		lastIndexedAt: toMs(data.lastIndexedAt),
	};
}

export async function mintLink(id: string, view: boolean): Promise<string> {
	const data = await request<{ url: string }>(`/api/hosts/${encodeURIComponent(id)}/link`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ view }),
	});
	return data.url;
}

export async function getVapidPublicKey(): Promise<string> {
	const data = await request<{ publicKey: string }>("/api/push/vapid");
	return data.publicKey;
}

export async function savePushSubscription(sub: Record<string, unknown> | PushSubscriptionJSON): Promise<void> {
	await request<{ ok: boolean }>("/api/push/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...sub, authOk: true }),
	});
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
	await request<{ ok: boolean }>("/api/push/subscribe", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint }),
	});
}

/* ---- agent lifecycle ---- */

export interface AgentStartResult {
	ok: boolean;
	instanceId?: string;
	cwd?: string;
	desk?: DeskRef | null;
	error?: string;
}

export async function startAgent(
	cwd: string,
	model: string | undefined,
	label: string | undefined,
	desk?: { role?: string; slug?: string; charter?: string; charterSource?: string },
): Promise<AgentStartResult> {
	try {
		const data = await request<{ ok?: boolean; instanceId?: unknown; error?: unknown; cwd?: unknown; desk?: DeskRef | null }>(
			"/api/agents/start",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					cwd,
					model,
					label,
					role: desk?.role,
					desk: desk?.slug,
					charter: desk?.charter,
					charterSource: desk?.charterSource,
				}),
			},
		);
		if (typeof data.instanceId === "string") {
			return {
				ok: true,
				instanceId: data.instanceId,
				cwd: typeof data.cwd === "string" ? data.cwd : cwd,
				desk: data.desk ?? null,
			};
		}
		return { ok: false, error: typeof data.error === "string" ? data.error : "Некорректный ответ шлюза" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/* ---- библиотека системных промптов AI-инструментов ---- */

export interface PromptDoc {
	id: string;
	tool: string;
	title: string;
	bytes: number;
	preview: string;
}

export interface PromptHit extends PromptDoc {
	/** Кусок текста вокруг совпадения — когда запрос нашёлся в содержимом. */
	snippet: string | null;
}

export interface PromptsResult {
	available: boolean;
	root: string;
	tools: { name: string; count: number }[];
	docs: PromptHit[];
	total: number;
}

export interface PromptDocBody {
	doc: PromptDoc;
	text: string;
	truncated: boolean;
}

export async function fetchPrompts(q = "", tool = "", signal?: AbortSignal): Promise<PromptsResult> {
	const params = new URLSearchParams();
	if (q.trim() !== "") params.set("q", q.trim());
	if (tool !== "") params.set("tool", tool);
	const suffix = params.toString() === "" ? "" : `?${params.toString()}`;
	return request<PromptsResult>(`/api/prompts${suffix}`, { signal });
}

/** Хвост транскрипта с шлюза: локальное чтение, миллисекунды вместо мегабайт через релей. */
export async function fetchSessionTail(
	target: { path?: string | null; id?: string | null },
	limit = 80,
	signal?: AbortSignal,
): Promise<SessionEntry[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (target.path !== null && target.path !== undefined && target.path !== "") params.set("path", target.path);
	else if (target.id !== null && target.id !== undefined && target.id !== "") params.set("id", target.id);
	else return [];
	const data = await request<{ entries?: unknown[] }>(`/api/sessions/tail?${params.toString()}`, { signal });
	return Array.isArray(data.entries) ? (data.entries as SessionEntry[]) : [];
}

export function fetchPromptDoc(id: string): Promise<PromptDocBody> {
	return request<PromptDocBody>(`/api/prompts/${encodeURIComponent(id)}`);
}

/* ---- штат: папки агентов и кто за что отвечает ---- */

export type OrganizerMode = "llm" | "deterministic" | "noop";

export interface OrganizerStatus {
	lastRunAt: number | null;
	lastTrigger: string | null;
	lastMode: OrganizerMode | null;
	lastSummary: string | null;
	lastError: string | null;
	lastCandidates: number;
	lastDesks: number;
	running: boolean;
	nextRunAt: number | null;
}

export interface CrewDesk extends DeskRef {
	brief: string;
	createdAt: number;
	updatedAt: number;
	assignedBy: "organizer" | "start" | "manual" | "adopted";
	sessions: string[];
}

export interface CrewResponse {
	root: string;
	/** Живые агенты в общих папках без стола: их ещё предстоит разложить. */
	loose: number;
	desks: CrewDesk[];
	bindings: Record<string, { slug: string; at: number; by: string }>;
	organizer: OrganizerStatus;
	/** Заголовки сессий участников: sessionId → имя. */
	titles: Record<string, string | null>;
}

export function fetchCrew(signal?: AbortSignal): Promise<CrewResponse> {
	return request<CrewResponse>("/api/crew", { signal });
}

/** Раскладка живёт минутами: шлюз отвечает 202, прогресс — в /api/crew (organizer.running). */
export async function organizeCrew(dryRun = false): Promise<void> {
	await request<{ ok: boolean }>("/api/crew/organize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ dryRun }),
	});
}

export type StopResult = "ok" | "missing" | "not_started_here";

/** 409 = агент запущен вне этого шлюза; повторить с force после подтверждения пользователем. */
export async function stopAgent(instanceId: string, force = false): Promise<StopResult> {
	try {
		await request<{ ok: boolean }>("/api/agents/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instanceId, force }),
		});
		return "ok";
	} catch (err) {
		if (err instanceof GatewayError && err.status === 404) return "missing";
		if (err instanceof GatewayError && err.status === 409) return "not_started_here";
		throw err;
	}
}

/* ---- update center ---- */

export type UpdateComponentId = "omp" | "gateway" | "frontend" | "relay" | "runtime";

export interface UpdateCompatibility {
	status: "ok" | "warn" | "unknown";
	detail: string;
}

export interface UpdateComponent {
	id: UpdateComponentId;
	title: string;
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	installMethod: string;
	compatibility: UpdateCompatibility;
	notes: string[];
}

export interface UpdateStatus {
	components: UpdateComponent[];
	job: UpdateJob | null;
	active: boolean;
	remoteConfigured: boolean;
}

export type UpdateJobPhase =
	| "IDLE"
	| "CHECKING"
	| "PREPARING"
	| "CHECKPOINTING"
	| "INSTALLING"
	| "RESTARTING"
	| "VERIFYING"
	| "RESTORING"
	| "RESUMING"
	| "COMPLETED"
	| "ROLLING_BACK"
	| "ROLLED_BACK"
	| "FAILED"
	| "BLOCKED";

export interface UpdateJobStep {
	id: string;
	label: string;
	status: "run" | "ok" | "fail" | "skipped";
	detail?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface UpdateJobResult {
	verifiedVersions: Record<string, string | null>;
	restored: number;
	resumed: number;
	blocked: string[];
}

export interface UpdateJob {
	schema: 2;
	jobId: string;
	component: UpdateComponentId;
	phase: UpdateJobPhase;
	createdAt: string;
	updatedAt: string;
	attempt: number;
	steps: UpdateJobStep[];
	error: { message: string; phase: UpdateJobPhase } | null;
	rollback: { available: boolean; reason: string } | null;
	versions: { from: string | null; to: string | null };
	checkpointFile: string | null;
	result: UpdateJobResult | null;
	finishedAt: string | null;
}

export const PHASE_LABELS: Record<UpdateJobPhase, string> = {
	IDLE: "Подготовка",
	CHECKING: "Проверка версий",
	PREPARING: "Подготовка и бэкап",
	CHECKPOINTING: "Снимок сессий",
	INSTALLING: "Установка",
	RESTARTING: "Перезапуск компонентов",
	VERIFYING: "Проверка работающих версий",
	RESTORING: "Восстановление сессий",
	RESUMING: "Продолжение задач",
	COMPLETED: "Готово",
	ROLLING_BACK: "Откат",
	ROLLED_BACK: "Откат завершён",
	FAILED: "Ошибка",
	BLOCKED: "Заблокировано",
};

const TERMINAL_PHASES: UpdateJobPhase[] = ["COMPLETED", "ROLLED_BACK", "FAILED", "BLOCKED"];

export function isJobActive(job: UpdateJob | null): boolean {
	return job !== null && !TERMINAL_PHASES.includes(job.phase);
}

export function isJobFailed(job: UpdateJob | null): boolean {
	return job !== null && (job.phase === "FAILED" || job.phase === "BLOCKED");
}

export interface BusyAgent {
	sessionName: string | null;
	cwd: string;
}

/** 409 from /api/update/apply — some collab agents are busy; carries their list. */
export class UpdateBusyError extends GatewayError {
	agents: BusyAgent[];

	constructor(message: string, agents: BusyAgent[]) {
		super(409, message);
		this.name = "UpdateBusyError";
		this.agents = agents;
	}
}

export function isComponentId(value: string | null): value is UpdateComponentId {
	return value === "omp" || value === "gateway" || value === "frontend" || value === "relay" || value === "runtime";
}

function busyAgentsOf(value: unknown): BusyAgent[] {
	if (!Array.isArray(value)) return [];
	const agents: BusyAgent[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && "cwd" in item && typeof item.cwd === "string") {
			const sessionName =
				"sessionName" in item && typeof item.sessionName === "string" ? item.sessionName : null;
			agents.push({ sessionName, cwd: item.cwd });
		}
	}
	return agents;
}

export async function fetchUpdateStatus(): Promise<UpdateStatus> {
	const data = await request<UpdateStatus>("/api/update/status");
	return { ...data, components: Array.isArray(data.components) ? data.components : [] };
}

/** Запуск задачи. Возвращает jobId: прогресс идёт через /api/update/events или опрос /api/update/job. */
export async function applyUpdate(id: UpdateComponentId, confirmBusy = false): Promise<string | null> {
	const res = await fetchWithFailover("/api/update/apply", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(confirmBusy ? { id, confirmBusy: true } : { id }),
	});
	if (res.status === 401) throw new GatewayError(401, "Требуется токен доступа");
	if (res.status === 409) {
		let message = "Есть работающие агенты";
		let agents: BusyAgent[] = [];
		try {
			const body: unknown = await res.json();
			if (body && typeof body === "object") {
				if ("error" in body && typeof body.error === "string") message = body.error;
				if ("agents" in body) agents = busyAgentsOf(body.agents);
			}
		} catch {
			// non-JSON body — keep defaults
		}
		throw new UpdateBusyError(message, agents);
	}
	if (!res.ok) throw await errorFromResponse(res);
	const data: unknown = await res.json();
	if (typeof data === "object" && data !== null && "jobId" in data && typeof data.jobId === "string") return data.jobId;
	return null;
}

export async function rollbackUpdate(id: UpdateComponentId): Promise<string | null> {
	const data = await request<{ ok: boolean; jobId?: string }>("/api/update/rollback", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
	return data.jobId ?? null;
}

export async function fetchUpdateJob(): Promise<UpdateJob | null> {
	return request<UpdateJob | null>("/api/update/job");
}

export interface UpdateEvent {
	seq: number;
	at: string;
	jobId: string;
	phase: UpdateJobPhase;
	kind: string;
	message: string | null;
	data: Record<string, unknown> | null;
}

/** Лента событий задачи: сначала всё, что уже записано, затем — если шлюз отдал
 * поток — реальные события SSE. Переподключение идёт с since=последний seq. */
export async function fetchUpdateEvents(jobId: string, since = 0): Promise<UpdateEvent[]> {
	const data = await request<{ events: UpdateEvent[] }>(`/api/update/events?job=${encodeURIComponent(jobId)}&since=${since}`);
	return Array.isArray(data.events) ? data.events : [];
}

/* ---- terminal (панели шлюза) ---- */

export type TerminalResult = { paneId: string; text: string; format?: "ansi" } | { error: "agent_not_managed" };

/* ---- каталог моделей и настройки чата (модель + усилие) ---- */

export interface ModelCost {
	/** USD за 1M входных токенов. */
	input: number;
	/** USD за 1M выходных токенов. */
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelOption {
	selector: string;
	name: string;
	thinking: string[];
	contextWindow: number;
	/** Цена из каталога шлюза; null — провайдер её не сообщает. */
	cost?: ModelCost | null;
	pricingStatus?: string;
}

export interface AgentChatSettings {
	model: { provider: string; id: string } | null;
	thinking: string | null;
	models: ModelOption[];
}

function toChatSettings(value: unknown): AgentChatSettings {
	const data = value as Partial<AgentChatSettings> & { models?: unknown };
	return {
		model: data.model ?? null,
		thinking: typeof data.thinking === "string" ? data.thinking : null,
		models: Array.isArray(data.models) ? (data.models as ModelOption[]) : [],
	};
}

/** Каталог моделей omp для пикеров (создание агента, смена модели в чате). */
export async function fetchModels(): Promise<ModelOption[]> {
	const data = await request<{ models?: unknown }>("/api/models");
	return Array.isArray(data.models) ? (data.models as ModelOption[]) : [];
}

export async function fetchAgentSettings(instanceId: string): Promise<AgentChatSettings> {
	return toChatSettings(await request<unknown>(`/api/agents/${encodeURIComponent(instanceId)}/settings`));
}

/** Смена модели и/или уровня усилия живого агента (клавишами в его TUI). */
export async function applyAgentSettings(
	instanceId: string,
	change: { model?: string; thinking?: string },
): Promise<AgentChatSettings> {
	return toChatSettings(
		await request<unknown>(`/api/agents/${encodeURIComponent(instanceId)}/settings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(change),
		}),
	);
}

/** Terminal pane snapshot. `null` = unknown host; `{error}` = agent is not managed by a gateway pane. */
export async function getTerminal(instanceId: string, format: "plain" | "ansi" = "plain"): Promise<TerminalResult | null> {
	try {
		const data = await request<{ paneId?: unknown; text?: unknown; format?: unknown }>(
			`/api/agents/${encodeURIComponent(instanceId)}/terminal${format === "ansi" ? "?format=ansi" : ""}`,
		);
		if (typeof data.paneId === "string" && typeof data.text === "string") {
			return { paneId: data.paneId, text: data.text, ...(data.format === "ansi" ? { format: "ansi" as const } : {}) };
		}
		return null;
	} catch (err) {
		if (err instanceof GatewayError && err.status === 404) {
			if (err.code === "agent_not_managed") return { error: "agent_not_managed" };
			return null; // host not found
		}
		throw err;
	}
}

export async function sendTerminalKeys(instanceId: string, keys: string[]): Promise<void> {
	await request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(instanceId)}/terminal/keys`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keys }),
	});
}

export async function sendTerminalText(instanceId: string, text: string): Promise<void> {
	await request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(instanceId)}/terminal/text`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
}

/* ---- super agent (orchestration board) ---- */

export type SuperAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** A subagent transcript living next to the host session. */
export interface SuperSubagent {
	name: string;
	sizeBytes: number;
	updatedAt: number;
	active: boolean;
	state: "working" | "done" | "unknown";
	activity: string;
}

export interface SuperHostInfo {
	instanceId: string;
	sessionId: string;
	sessionName: string | null;
	model: { provider: string; id: string };
	startedAt: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy: boolean;
}

export interface SuperAgent {
	/** id панели — dispatch target ("w1:p1"). */
	target: string;
	name: string;
	agentStatus: SuperAgentStatus;
	cwd: string;
	/** Stripped terminal title — what the agent is doing right now. */
	title: string;
	interactiveReady: boolean;
	host: SuperHostInfo | null;
	subagents: SuperSubagent[];
}

export interface SuperBoard {
	agents: SuperAgent[];
	orphans: { instanceId: string; cwd: string; sessionName: string | null; busy: boolean }[];
}

export interface SuperActivity {
	target: string;
	agentStatus: SuperAgentStatus;
	title: string;
	cwd: string;
	name: string;
	tail: string;
	subagents: SuperSubagent[];
}

export type DispatchResult = { target: string; ok: true } | { target: string; ok: false; error: string };

export async function fetchSuperBoard(signal?: AbortSignal): Promise<SuperBoard> {
	return request<SuperBoard>("/api/super/board", { signal });
}

export async function dispatchSuperTasks(items: { target: string; text: string }[]): Promise<DispatchResult[]> {
	const data = await request<{ results: DispatchResult[] }>("/api/super/dispatch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ items }),
	});
	return Array.isArray(data.results) ? data.results : [];
}

export async function fetchSuperActivity(target: string, signal?: AbortSignal): Promise<SuperActivity> {
	return request<SuperActivity>(`/api/super/agent/${encodeURIComponent(target)}/activity`, { signal });
}

/* ---- autonomous tasks (оказывается, задачи ставятся и без человека) ---- */

/** Статус задачи. Успех — только `done`: остальные терминальные — причины, почему нет. */
export type TaskStatus =
	| "queued"
	| "running"
	| "verifying"
	| "awaiting_approval"
	| "paused"
	| "blocked"
	| "budget_exhausted"
	| "no_progress"
	| "cancelled"
	| "failed"
	| "done";

export type TaskStopReasonKind = "done" | "budget" | "no_progress" | "blocked" | "cancelled" | "failed";

export interface TaskStopReason {
	kind: TaskStopReasonKind;
	detail: string;
}

export interface TaskCheckSpec {
	command: string;
	expectExit?: number;
	expectContains?: string;
	expectAbsent?: string;
	timeoutMs?: number;
}

export interface TaskCriterion {
	id: string;
	statement: string;
	check?: TaskCheckSpec;
	passed: boolean;
	lastResult?: string;
	checkedAt?: number;
}

export interface TaskAttempt {
	index: number;
	startedAt: number;
	finishedAt?: number;
	strategy: string;
	summary: string;
	progress: boolean;
	failures: string[];
}

export interface TaskEvidence {
	at: number;
	criterionId: string;
	command: string;
	ok: boolean;
	exitCode: number | null;
	output: string;
	durationMs: number;
}

export interface TaskSpend {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** null — цены модели не заданы: деньги не выдумываем. */
	costUsd: number | null;
	turns: number;
}

export interface TaskBudget {
	maxTokens: number;
	reserveTokens: number;
	maxCostUsd?: number;
}

export interface TaskApproval {
	requestId: string;
	title: string;
	detail: string;
	requestedAt: number;
	decision: "allow" | "deny" | null;
}

/** Сокращённый вид для списка: всё, что рисует карточка, без журналов. */
export interface TaskSummary {
	id: string;
	goal: string;
	cwd: string;
	model: string;
	status: TaskStatus;
	stage: string;
	turns: number;
	spend: TaskSpend;
	/** Сумма оплачиваемых токенов (вход+выход+кэш). */
	tokensUsed: number;
	budget: TaskBudget;
	stopReason: TaskStopReason | null;
	lastVerifiedResult: string | null;
	approval: TaskApproval | null;
	criteriaTotal: number;
	criteriaPassed: number;
	createdAt: number;
	updatedAt: number;
}

/** Полная задача: как её отдаёт GET /api/tasks/<id>. Вычисляемых полей списка
 *  (tokensUsed, criteriaTotal/Passed) в ответе нет — их считает только витрина. */
export interface TaskDetail extends Omit<TaskSummary, "tokensUsed" | "criteriaTotal" | "criteriaPassed"> {
	criteria: TaskCriterion[];
	attempts: TaskAttempt[];
	evidence: TaskEvidence[];
	strategiesTried: string[];
	noProgressStreak: number;
	autoApprove: string[];
	nextInstruction: string | null;
}

export interface NewTaskInput {
	goal: string;
	cwd: string;
	model?: string;
	criteria: { id: string; statement: string; check?: TaskCheckSpec }[];
	budget: TaskBudget;
	autoApprove?: string[];
}

export type TaskAction = "pause" | "resume" | "cancel" | "start";

export async function fetchTasks(signal?: AbortSignal): Promise<TaskSummary[]> {
	const data = await request<{ tasks?: unknown }>("/api/tasks", { signal });
	return Array.isArray(data.tasks) ? (data.tasks as TaskSummary[]) : [];
}

export async function fetchTask(id: string, signal?: AbortSignal): Promise<TaskDetail> {
	return request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, { signal });
}

export async function createTask(input: NewTaskInput): Promise<TaskSummary> {
	const data = await request<{ task?: unknown }>("/api/tasks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!data.task) throw new GatewayError(502, "шлюз не вернул задачу");
	return data.task as TaskSummary;
}

export async function taskAction(id: string, action: TaskAction): Promise<void> {
	await request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}

export async function answerTaskApproval(id: string, decision: "allow" | "deny"): Promise<void> {
	await request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/approval`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ decision }),
	});
}

/* ---- project files / git ---- */

export interface ProjectFileEntry {
	name: string;
	type: "dir" | "file";
	size: number | null;
}

export async function listProjectFiles(path: string): Promise<{ entries: ProjectFileEntry[]; hasGit: boolean }> {
	const data = await request<{ entries?: unknown; hasGit?: unknown }>(
		`/api/project/files?path=${encodeURIComponent(path)}`,
	);
	const entries: ProjectFileEntry[] = Array.isArray(data.entries)
		? data.entries.flatMap(item => {
				if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return [];
				const rec = item as { name: string; type?: unknown; size?: unknown };
				const type = rec.type === "dir" ? "dir" : "file";
				const size = typeof rec.size === "number" ? rec.size : null;
				return [{ name: rec.name, type, size }];
			})
		: [];
	return { entries, hasGit: data.hasGit === true };
}

export async function projectGit(path: string, mode: "status" | "diff"): Promise<string | null> {
	try {
		const data = await request<{ text?: unknown }>(
			`/api/project/git?path=${encodeURIComponent(path)}&mode=${mode}`,
		);
		return typeof data.text === "string" ? data.text : null;
	} catch (err) {
		if (err instanceof GatewayError && err.status === 404) return null; // no-git
		throw err;
	}
}

/** Прочитать текстовый файл из проекта (для прикрепления к сообщению). */
export async function readProjectFile(path: string, name: string): Promise<string> {
	const data = await request<{ content?: unknown }>(
		`/api/project/file?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
	);
	return typeof data.content === "string" ? data.content : "";
}

// ---- Файловое дерево процессов (Workflow → Task → Subtask) ----

export interface TreeTask {
	path: string;
	kind: "task" | "tool" | "template";
	hasPrompt: boolean;
	tools: string[];
	inputs: number;
	outputs: number;
	hasSchema: boolean;
	subtasks: TreeTask[];
}

export interface TreeWorkflow {
	name: string;
	path: string;
	hasWorkflowMd: boolean;
	goal: string;
	tasks: TreeTask[];
}

export interface TreeLint {
	ok: boolean;
	problems: string[];
	workflows: number;
	tasks: number;
}

export interface TreeRoot {
	path: string;
	workflows: TreeWorkflow[];
	lint: TreeLint;
}

function normalizeTreeTask(value: unknown): TreeTask | null {
	if (value === null || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw["path"] !== "string") return null;
	const kind = raw["kind"] === "tool" || raw["kind"] === "template" ? raw["kind"] : "task";
	const subtasks = Array.isArray(raw["subtasks"]) ? raw["subtasks"].map(normalizeTreeTask).filter((t): t is TreeTask => t !== null) : [];
	return {
		path: raw["path"],
		kind,
		hasPrompt: raw["hasPrompt"] === true,
		tools: Array.isArray(raw["tools"]) ? raw["tools"].filter((t): t is string => typeof t === "string") : [],
		inputs: Number(raw["inputs"] ?? 0) || 0,
		outputs: Number(raw["outputs"] ?? 0) || 0,
		hasSchema: raw["hasSchema"] === true,
		subtasks,
	};
}

/** Дерево процессов с шлюза; битые поля нормализуются, а не роняют экран. */
export async function fetchTree(root?: string | null, signal?: AbortSignal): Promise<TreeRoot[]> {
	const query = root !== undefined && root !== null && root !== "" ? `?root=${encodeURIComponent(root)}` : "";
	const data = await request<{ roots?: unknown }>(`/api/tree${query}`, { signal });
	const roots = Array.isArray(data.roots) ? data.roots : [];
	return roots
		.map((entry): TreeRoot | null => {
			if (entry === null || typeof entry !== "object") return null;
			const raw = entry as Record<string, unknown>;
			if (typeof raw["path"] !== "string") return null;
			const workflows = Array.isArray(raw["workflows"]) ? raw["workflows"] : [];
			const lintRaw = raw["lint"] !== null && typeof raw["lint"] === "object" ? (raw["lint"] as Record<string, unknown>) : {};
			return {
				path: raw["path"],
				workflows: workflows
					.map((wf): TreeWorkflow | null => {
						if (wf === null || typeof wf !== "object") return null;
						const w = wf as Record<string, unknown>;
						if (typeof w["name"] !== "string") return null;
						const tasks = Array.isArray(w["tasks"]) ? w["tasks"].map(normalizeTreeTask).filter((t): t is TreeTask => t !== null) : [];
						return {
							name: w["name"],
							path: typeof w["path"] === "string" ? w["path"] : "",
							hasWorkflowMd: w["hasWorkflowMd"] === true,
							goal: typeof w["goal"] === "string" ? w["goal"] : "",
							tasks,
						};
					})
					.filter((wf): wf is TreeWorkflow => wf !== null),
				lint: {
					ok: lintRaw["ok"] === true,
					problems: Array.isArray(lintRaw["problems"]) ? lintRaw["problems"].filter((p): p is string => typeof p === "string") : [],
					workflows: Number(lintRaw["workflows"] ?? 0) || 0,
					tasks: Number(lintRaw["tasks"] ?? 0) || 0,
				},
			};
		})
		.filter((root): root is TreeRoot => root !== null);
}

/** Автономные цели: контроллер ведёт их сам, UI только показывает состояние. */
export interface GoalStepView {
	name: string;
	status: "todo" | "doing" | "done" | "failed";
	attempts: number;
	evidence: string[];
}

export interface GoalView {
	slug: string;
	goal: string;
	phase: "PLAN" | "EXECUTE" | "RECOVER" | "VERIFY" | "RESULT" | "BLOCKED";
	current: number;
	steps: GoalStepView[];
	criteria: string[];
	residuals: { text: string; reason: string; impact: string; exitCondition: string }[];
	log: { at: string; phase: string; event: string; detail: string }[];
	result: { status: string; detail: string } | null;
	project?: string;
	updatedAt: string;
}

export const api = {
	async getGoals(signal?: AbortSignal): Promise<{ goals: GoalView[] }> {
		return request<{ goals: GoalView[] }>("/api/goals", { signal });
	},
	async createGoal(input: { goal: string; criteria?: string[]; steps?: string[]; project?: string }): Promise<{ ok: boolean; slug?: string; error?: string }> {
		return request<{ ok: boolean; slug?: string; error?: string }>("/api/goals", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
	},
	async driveGoal(slug: string): Promise<{ ok: boolean; detail: string }> {
		return request<{ ok: boolean; detail: string }>(`/api/goals/${encodeURIComponent(slug)}/drive`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
	},
	async goalReport(slug: string): Promise<{ ok: boolean; text: string }> {
		return request<{ ok: boolean; text: string }>(`/api/goals/${encodeURIComponent(slug)}/report`);
	},
};
