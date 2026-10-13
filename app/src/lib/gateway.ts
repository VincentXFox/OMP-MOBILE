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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(init?.headers);
	if (getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
	let res: Response;
	try {
		res = await fetch(`${getGatewayBase().replace(/\/+$/, "")}${path}`, { ...init, headers });
	} catch (err) {
		throw new GatewayError(0, err instanceof Error ? err.message : String(err));
	}
	if (res.status === 401) throw new GatewayError(401, "Требуется токен доступа");
	if (!res.ok) {
		let message = `HTTP ${res.status}`;
		try {
			const body: unknown = await res.json();
			if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error;
		} catch {
			// non-JSON body — keep the generic message
		}
		throw new GatewayError(res.status, message);
	}
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
