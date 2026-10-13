export interface HostInfo {
	instanceId: string;
	generation: number;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string };
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy: boolean;
	access: "view" | "control";
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
		res = await fetch(gatewayUrl(path), { ...init, headers: authHeaders(init?.headers) });
	} catch (err) {
		throw new GatewayError(0, err instanceof Error ? err.message : String(err));
	}
	if (res.status === 401) throw new GatewayError(401, "Требуется токен доступа");
	if (!res.ok) throw await errorFromResponse(res);
	return (await res.json()) as T;
}

export async function fetchHosts(signal?: AbortSignal): Promise<HostInfo[]> {
	const data = await request<{ hosts: HostInfo[] }>("/api/hosts", { signal });
	return Array.isArray(data.hosts) ? data.hosts : [];
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

export async function savePushSubscription(sub: unknown): Promise<void> {
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

export async function stopAgent(instanceId: string): Promise<boolean> {
	try {
		await request<{ ok: boolean }>("/api/agents/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instanceId }),
		});
		return true;
	} catch (err) {
		if (err instanceof GatewayError && err.status === 404) return false;
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
