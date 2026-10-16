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
	 * у сессий без herdr-панели его нет вообще. */
	sessionTitle?: string | null;
	/** Первый запрос пользователя — имя для сессии без заголовка. */
	sessionPreview?: string | null;
}

const BASE_KEY = "ompPocket.gwBase";
const TOKEN_KEY = "ompPocket.token";

export function getGatewayBase(): string {
	try {
		return localStorage.getItem(BASE_KEY) ?? "";
	} catch {
		return "";
	}
}

export function setGatewayBase(v: string): void {
	try {
		if (v) localStorage.setItem(BASE_KEY, v);
		else localStorage.removeItem(BASE_KEY);
	} catch {
		// storage unavailable — non-fatal
	}
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
	const res = await fetch(`${getGatewayBase()}/api/attach`, {
		method: "POST",
		headers: { authorization: `Bearer ${getToken()}` },
		body: form,
	});
	const data = (await res.json()) as { url?: string; error?: string };
	if (!res.ok || !data.url) throw new Error(data.error ?? `шлюз вернул ${res.status}`);
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

	constructor(status: number, message: string) {
		super(message);
		this.name = "GatewayError";
		this.status = status;
	}
}

function gatewayUrl(path: string): string {
	return `${getGatewayBase().replace(/\/+$/, "")}${path}`;
}

function authHeaders(init?: HeadersInit): Headers {
	const headers = new Headers(init);
	if (getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
	return headers;
}

async function errorFromResponse(res: Response): Promise<GatewayError> {
	let message = `HTTP ${res.status}`;
	try {
		const body: unknown = await res.json();
		if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error;
	} catch {
		// non-JSON body — keep the generic message
	}
	return new GatewayError(res.status, message);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		// таймаут 10с: недостижимый base (упавший LAN-адрес/мёртвый туннель)
		// не должен висеть до TCP-таймаута ОС, пока поллинг плодит запросы.
		// AbortSignal.any есть не во всех браузерах — фолбэк на одиночный таймаут.
		const timeout = AbortSignal.timeout(10_000);
		const signal = typeof AbortSignal.any === "function" && init?.signal
			? AbortSignal.any([init.signal, timeout])
			: (init?.signal ?? timeout);
		res = await fetch(gatewayUrl(path), {
			...init,
			headers: authHeaders(init?.headers),
			signal,
		});
	} catch (err) {
		throw new GatewayError(0, err instanceof Error ? err.message : String(err));
	}
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

/** Переименовать herdr-агента (видно в списках приложения). */
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
}

export async function fetchMemoryBanks(signal?: AbortSignal): Promise<MemoryBank[]> {
	const data = await request<{ banks: MemoryBank[] }>("/api/memory/banks", { signal });
	return Array.isArray(data.banks) ? data.banks : [];
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

export type AgentResumeResult = { ok: true; instanceId: string } | { ok: false; error: string };

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
	type: MemoryTable,
	opts: { q?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<{ total: number; entries: MemoryEntry[] }> {
	const params = new URLSearchParams({ type });
	if (opts.q) params.set("q", opts.q);
	if (opts.limit != null) params.set("limit", String(opts.limit));
	if (opts.offset != null) params.set("offset", String(opts.offset));
	return request(`/api/memory/banks/${encodeURIComponent(bank)}/entries?${params}`, { signal: opts.signal });
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

export type AgentStartResult = { ok: true; instanceId: string } | { ok: false; error: string };

export async function startAgent(cwd: string, model: string | undefined, label: string | undefined): Promise<AgentStartResult> {
	try {
		const data = await request<{ ok?: boolean; instanceId?: unknown; error?: unknown }>("/api/agents/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd, model, label }),
		});
		if (typeof data.instanceId === "string") return { ok: true, instanceId: data.instanceId };
		return { ok: false, error: typeof data.error === "string" ? data.error : "Некорректный ответ шлюза" };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
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

export type UpdateComponentId = "omp" | "gateway" | "frontend";

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
	lastCheck: number | null;
	remoteConfigured: boolean;
}

export interface UpdateJobStep {
	label: string;
	status: "run" | "ok" | "fail";
	detail?: string;
}

export interface UpdateJob {
	running: boolean;
	id: string | null;
	steps: UpdateJobStep[];
	error: string | null;
	startedAt: number;
	finishedAt?: number;
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
	return value === "omp" || value === "gateway" || value === "frontend";
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

export async function createUpdateBackup(): Promise<string> {
	const data = await request<{ ok: boolean; dir: string }>("/api/update/backup", { method: "POST" });
	return data.dir;
}

export async function applyUpdate(id: UpdateComponentId, confirmBusy = false): Promise<boolean> {
	let res: Response;
	try {
		res = await fetch(gatewayUrl("/api/update/apply"), {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify(confirmBusy ? { id, confirmBusy: true } : { id }),
		});
	} catch (err) {
		throw new GatewayError(0, err instanceof Error ? err.message : String(err));
	}
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
	return typeof data === "object" && data !== null && "job" in data && data.job === true;
}

export async function rollbackUpdate(id: UpdateComponentId): Promise<boolean> {
	const data = await request<{ ok: boolean }>("/api/update/rollback", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
	return data.ok === true;
}

export async function fetchUpdateJob(): Promise<UpdateJob> {
	return request<UpdateJob>("/api/update/job");
}

/* ---- terminal (herdr agents) ---- */

export type TerminalResult = { paneId: string; text: string } | { error: "not-herdr-agent" };

/* ---- каталог моделей и настройки чата (модель + усилие) ---- */

export interface ModelOption {
	selector: string;
	name: string;
	thinking: string[];
	contextWindow: number;
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

/** Terminal pane snapshot. `null` = unknown host; `{error}` = agent is not herdr-managed. */
export async function getTerminal(instanceId: string): Promise<TerminalResult | null> {
	try {
		const data = await request<{ paneId?: unknown; text?: unknown }>(
			`/api/agents/${encodeURIComponent(instanceId)}/terminal`,
		);
		if (typeof data.paneId === "string" && typeof data.text === "string") {
			return { paneId: data.paneId, text: data.text };
		}
		return null;
	} catch (err) {
		if (err instanceof GatewayError && err.status === 404) {
			if (err.message === "not-herdr-agent") return { error: "not-herdr-agent" };
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
	/** herdr pane id — dispatch target ("w1:p1"). */
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
