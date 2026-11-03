import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CollabSocket } from "./socket";
import type { GuestFrame } from "@oh-my-pi/pi-wire";

/**
 * Самовосстановление соединения: параллельные попытки, пауза без сети,
 * потолок backoff и явный отказ отправки вместо молчаливой очереди.
 */

interface FakeSocket {
	url: string;
	readyState: number;
	sent: unknown[];
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: (() => void) | null;
	close: (code?: number, reason?: string) => void;
	send: (data: unknown) => void;
	/** Тестовые помощники: открыть сокет и уронить его без реальной сети. */
	open: () => void;
	drop: (code?: number) => void;
}

const OPEN = 1;
const CLOSED = 3;
const CONNECTING = 0;

let created: FakeSocket[] = [];

function installFakeWebSocket(): void {
	created = [];
	class FakeWebSocket implements FakeSocket {
		url: string;
		readyState = CONNECTING;
		sent: unknown[] = [];
		onopen: (() => void) | null = null;
		onmessage: ((event: { data: unknown }) => void) | null = null;
		onclose: ((event: { code: number; reason: string }) => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(url: string) {
			this.url = url;
			created.push(this as unknown as FakeSocket);
		}
		close(code = 1000, reason = ""): void {
			if (this.readyState === CLOSED) return;
			this.readyState = CLOSED;
			this.onclose?.({ code, reason });
		}
		send(data: unknown): void {
			this.sent.push(data);
		}
		open(): void {
			this.readyState = OPEN;
			this.onopen?.();
		}
		drop(code = 1006): void {
			this.readyState = CLOSED;
			this.onclose?.({ code, reason: "" });
		}
	}
	(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	(globalThis as unknown as { WebSocket: { OPEN: number; CLOSED: number; CONNECTING: number } }).WebSocket.OPEN = OPEN;
	(globalThis as unknown as { WebSocket: { OPEN: number; CLOSED: number; CONNECTING: number } }).WebSocket.CLOSED = CLOSED;
	(globalThis as unknown as { WebSocket: { OPEN: number; CLOSED: number; CONNECTING: number } }).WebSocket.CONNECTING = CONNECTING;
}

const KEY = {} as CryptoKey;

function socket(): CollabSocket {
	return new CollabSocket({ wsUrl: "wss://relay.test/r/room000000000001", role: "guest", key: KEY });
}

/** Минимальный window: сокет подписывается на событие online. */
function installWindow(): { listeners: Map<string, Set<() => void>>; dispatch: (type: string) => void } {
	const listeners = new Map<string, Set<() => void>>();
	const api = {
		addEventListener: (type: string, handler: () => void) => {
			const set = listeners.get(type) ?? new Set();
			set.add(handler);
			listeners.set(type, set);
		},
		removeEventListener: (type: string, handler: () => void) => {
			listeners.get(type)?.delete(handler);
		},
		dispatch: (type: string) => {
			for (const handler of [...(listeners.get(type) ?? [])]) handler();
		},
	};
	(globalThis as unknown as { window: unknown }).window = api;
	return { listeners, dispatch: api.dispatch };
}

beforeEach(() => {
	installFakeWebSocket();
	installWindow();
});

afterEach(() => {
	// таймеры ретраев не должны течь между тестами
	for (const instance of created) instance.readyState = CLOSED;
});

describe("сокет: один сокет и пауза без сети", () => {
	test("reconnectNow закрывает предыдущий сокет: параллельных попыток нет", () => {
		const client = socket();
		client.connect();
		expect(created).toHaveLength(1);
		created[0]?.open();
		client.reconnectNow();
		expect(created).toHaveLength(2);
		expect(created[0]?.readyState).toBe(CLOSED);
		expect(created[1]?.readyState).toBe(CONNECTING);
		client.close();
	});

	test("при navigator.onLine=false ретрай ждёт событие online, а не долбит таймером", () => {
		const client = socket();
		const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
		client.connect();
		created[0]?.drop(1006);
		const before = created.length;
		// Ждём дольше, чем старый короткий backoff: новых сокетов быть не должно.
		const waited = Date.now() + 1200;
		while (Date.now() < waited) {
			// busy wait: событий нет, попыток быть не должно
		}
		expect(created.length).toBe(before);
		Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
		(globalThis as unknown as { window: { dispatch: (type: string) => void } }).window.dispatch("online");
		expect(created.length).toBe(before + 1);
		client.close();
		if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
	});

	test("sendCritical не копит кадры: без открытого сокета — явный отказ", () => {
		const client = socket();
		client.connect();
		const frame: GuestFrame = { t: "abort" };
		expect(client.sendCritical(frame)).toBe(false);
		created[0]?.open();
		expect(client.sendCritical(frame)).toBe(true);
		client.close();
	});
});

describe("сокет: потолок backoff", () => {
	test("задержки растут, но не превышают потолок с разбросом", async () => {
		const client = socket();
		const delays: number[] = [];
		const pending: Array<() => void> = [];
		const originalSetTimeout = globalThis.setTimeout;
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((handler: () => void, delay?: number) => {
			if (typeof delay === "number" && delay > 0) delays.push(delay);
			if (typeof handler === "function") pending.push(handler);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			client.connect();
			// Каждый обрыв планирует ретрай: прогоняем его и роняем новый сокет,
			// чтобы увидеть всю лестницу задержек.
			for (let i = 0; i < 12; i += 1) {
				(created[created.length - 1] as unknown as { drop: (code?: number) => void } | undefined)?.drop(1006);
				const next = pending.shift();
				next?.();
			}
		} finally {
			(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
		}
		client.close();
		expect(delays.length).toBeGreaterThan(8);
		// Разброс 0.8–1.3 от базы: первая пауза короткая, дальше рост до потолка 20 с.
		expect(Math.min(...delays)).toBeLessThan(1_000);
		expect(Math.max(...delays)).toBeLessThanOrEqual(20_000 * 1.3);
	});
});
