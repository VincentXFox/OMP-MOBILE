/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * commit, so React change detection is reference equality all the way.
 *
 * High-rate frames (streaming `message_update`, `tool_execution_update`,
 * subagent progress) are applied immediately but published at most once per
 * animation frame; every other frame publishes synchronously, flushing any
 * pending state with it, so the published end state is unchanged.
 */

import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { nextWorking } from "./stale-working";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
	/** Отправка: очередь переполнилась, часть кадров потеряна (накопительный счётчик). */
	droppedFrames: number;
	/**
	 * Хост не отдал пропущенный кусок истории: часть вывода недоступна.
	 * Показываем явно, а не выдаём устаревшее состояние за актуальное.
	 */
	historyGap: boolean;
}

const MAX_NOTICES = 50;

/** Идентификатор записи транскрипта: по нему ищем разрыв истории после реконнекта. */
function entryIdOf(entry: SessionEntry): string | null {
	const candidate = entry as unknown as { id?: unknown };
	return typeof candidate.id === "string" ? candidate.id : null;
}

function lastEntryId(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const id = entryIdOf(entries[i] as SessionEntry);
		if (id !== null) return id;
	}
	return null;
}
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;

/**
 * Сторож соединения. Сокет может оставаться «открытым», когда события уже не
 * идут (мёртвый TCP через NAT, уснувший телефон): без проверки интерфейс
 * показывает устаревшее состояние как актуальное.
 */
const WATCHDOG_TICK_MS = 5_000;
/** Тишина дольше этого — повод переспросить хост (повторный hello). */
const STALL_PROBE_MS = 20_000;
/** Тишина после пробы — соединение считаем мёртвым и переподключаемся. */
const STALL_RECONNECT_MS = 35_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
/**
 * Ожидание следующего куска снапшота. 30 с не хватало на больших сессиях
 * (22 МБ истории уходило больше), и чат закрывался с «timed out waiting for the
 * host's session snapshot» ещё до первого кадра. Ждём дольше, но не бесконечно:
 * таймаут по-прежнему срабатывает, если прогресса нет вовсе.
 */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 60_000;
/** Сколько раз подряд ждём снимок, прежде чем закрыть канал (60 с × 5 = 5 мин). */
const SNAPSHOT_MAX_STALLS = 5;
/** Commit delay when `requestAnimationFrame` is unavailable (tests, non-DOM hosts). */
const FRAME_FALLBACK_MS = 16;

/** Runs `callback` on the next animation frame; returns its cancel function. */
function scheduleFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const timer = setTimeout(callback, FRAME_FALLBACK_MS);
	return () => clearTimeout(timer);
}

/** High-rate frames whose publish is deferred to the next animation frame. */
function isCoalescable(frame: HostFrame): boolean {
	if (frame.t === "event")
		return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
	return frame.t === "bus" && frame.channel === "task:subagent:progress";
}

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	/** Сторож: последний полученный кадр и момент отправки пробы. */
	#lastFrameAt = 0;
	#probeSentAt = 0;
	#watchdogTimer: Timer | null = null;
	/** История заменилась не целиком: хост не хранит пропущенное — покажем пробел. */
	#historyGap = false;
	/** Последний известный id записи до переподключения — по нему ищем разрыв. */
	#lastKnownEntryId: string | null = null;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	#pendingSnapshot: { entries: SessionEntry[]; live: SessionEntry[]; total: number } | null = null;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	/**
	 * Bus-map keys absent from the latest `agents` frame. Progress can arrive
	 * before its agent is listed, so such keys survive one `agents` frame and
	 * are pruned only if the next one still omits them.
	 */
	#unlistedBusIds = new Set<string>();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	/** Сколько подряд опросов реестра сказали «хост не работает» (само-починка индикатора). */
	#idleHostHits = 0;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#droppedFrames = 0;
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];
	/** Cancels the scheduled deferred commit; null when none is pending. */
	#cancelFrameCommit: (() => void) | null = null;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#socket.onDroppedFrames = count => this.#handleDroppedFrames(count);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	/**
	 * Немедленное переподключение к комнате: возврат из фона телефона, смена
	 * сети, «залипший» сокет без события close. Сбрасывает backoff сокета и
	 * заново шлёт hello; хост отвечает свежим welcome со снапшотом.
	 * Терминально завершённую сессию не оживляем — там свой флоу (rejoin).
	 */
	reconnectNow(): void {
		if (this.#phase === "ended") return;
		this.#socket.reconnectNow();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
		this.#phase = this.#everConnected ? "reconnecting" : "connecting";
		this.#commit();
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#stopWatchdog();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced per commit (at most once per animation frame for streaming frames). */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/**
	 * Сверка с реестром шлюза (`/api/hosts`): если два опроса подряд говорят «хост не
	 * работает», а локально индикатор ещё горит — гасим. Это лечит пропущенный
	 * `agent_end` после сна телефона/обрыва релея: иначе «thinking…» висит вечно.
	 */
	syncHostBusy(hostBusy: boolean | null): void {
		const verdict = nextWorking(this.#working, hostBusy, this.#idleHostHits);
		this.#idleHostHits = verdict.idleHits;
		if (!verdict.healed) return;
		this.#working = false;
		// Хост простаивает — значит ни один инструмент не может быть активен:
		// заодно снимаем карточки, залипшие без `tool_execution_end`.
		this.#activeTools = new Map();
		this.#streamDone = true;
		this.#pushNotice("info", "Агент не работает — индикатор снят (пропущено событие окончания хода)");
		this.#commit();
	}

	/** @returns false — связи нет, промпт НЕ отправлен (текст остаётся у пользователя). */
	sendPrompt(text: string): boolean {
		if (this.#socket.sendCritical({ t: "prompt", text })) return true;
		this.#pushNotice("warning", "Связи нет — промпт не отправлен");
		this.#commit();
		return false;
	}

	sendPromptWithImages(text: string, images: ReadonlyArray<{ data: string; mimeType: string }>): boolean {
		const ok = this.#socket.sendCritical({
			t: "prompt",
			text,
			images: images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })),
		});
		if (!ok) {
			this.#pushNotice("warning", "Связи нет — промпт с картинками не отправлен");
			this.#commit();
		}
		return ok;
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): boolean {
		// Подтверждение без связи молча не копим: неизвестно, принял ли хост ответ.
		if (!this.#socket.sendCritical({ t: "ui-response", reqId, value })) {
			this.#pushNotice("warning", "Связи нет — подтверждение не отправлено, ответь ещё раз после восстановления");
			this.#commit();
			return false;
		}
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
		return true;
	}

	sendAbort(): boolean {
		if (!this.#socket.sendCritical({ t: "abort" })) {
			this.#pushNotice("warning", "Связи нет — прерывание не отправлено");
			this.#commit();
			return false;
		}
		return true;
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/**
	 * Test seam: apply a synthetic host frame through the real apply path. With
	 * `flush` (default), a commit deferred to the next animation frame is
	 * published now, so the snapshot reflects the frame on return.
	 */
	applyFrameForTest(frame: HostFrame, options: { flush?: boolean } = {}): void {
		this.#applyFrameSafe(frame);
		if ((options.flush ?? true) && this.#cancelFrameCommit !== null) this.#commit();
	}

	#handleOpen(): void {
		this.#socket.send({ t: "hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken });
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#lastFrameAt = Date.now();
		this.#probeSentAt = 0;
		this.#startWatchdog();
		this.#commit();
	}

	/**
	 * Сторож: раз в 5 секунд сверяет тишину. Сначала переспрашивает хост
	 * (повторный hello — он отвечает свежим welcome), потом, если тишина
	 * продолжается, переподключается. Параллельных попыток нет: пока идёт
	 * проба, новых не шлём.
	 */
	#startWatchdog(): void {
		this.#stopWatchdog();
		if (typeof window === "undefined") return;
		this.#watchdogTimer = setInterval(() => {
			if (this.#phase === "ended") {
				this.#stopWatchdog();
				return;
			}
			if (!this.#socket.isOpen) return; // закрытый сокет ведёт обычный retry
			const now = Date.now();
			const silence = now - Math.max(this.#lastFrameAt, this.#socket.lastActivityAt);
			if (silence >= STALL_PROBE_MS && this.#probeSentAt === 0) {
				this.#probeSentAt = now;
				this.#socket.send({ t: "hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken });
				this.#pushNotice("info", "Связь молчит — проверяю соединение");
				this.#commit();
				return;
			}
			if (this.#probeSentAt !== 0 && silence >= STALL_RECONNECT_MS) {
				this.#probeSentAt = 0;
				this.#pushNotice("info", "Соединение не отвечает — переподключаюсь");
				this.reconnectNow();
			}
		}, WATCHDOG_TICK_MS);
	}

	#stopWatchdog(): void {
		if (this.#watchdogTimer !== null) {
			clearInterval(this.#watchdogTimer);
			this.#watchdogTimer = null;
		}
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	/** Очередь отправки переполнилась — часть кадров потеряна. Показываем счётчик в снапшоте. */
	#handleDroppedFrames(count: number): void {
		this.#droppedFrames = count;
		this.#commit();
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#snapshotStalls = 0;

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			// Сокет не рвём: при занятом агенте снапшот приходит позже, и раньше мы
			// хоронили живую сессию. Показываем состояние и ждём дальше — с потолком,
			// чтобы не висеть вечно на мёртвом хосте.
			this.#snapshotStalls += 1;
			if (this.#snapshotStalls > SNAPSHOT_MAX_STALLS) {
				this.#end("timed out waiting for the host's session snapshot");
				return;
			}
			this.#pushNotice(
				"info",
				this.#snapshotStalls === 1
					? "Агент занят — ждём снимок сессии"
					: `Ждём снимок сессии (попытка ${this.#snapshotStalls}/${SNAPSHOT_MAX_STALLS})`,
			);
			this.#commit();
			this.#armSnapshotProgressTimer();
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		this.#lastFrameAt = Date.now();
		this.#probeSentAt = 0;
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// Разрыв истории: запоминаем последний показанный id, чтобы после
				// снапшота понять, догнал ли хост наш хвост или кусок потерян.
				this.#lastKnownEntryId = this.#everConnected && this.#entries.length > 0 ? lastEntryId(this.#entries) : null;
				this.#historyGap = false;
				// A fresh welcome (first join or reconnect) restarts the snapshot.
				// Entries already on screen stay until the new snapshot replaces
				// them once complete, so a resync never blanks the transcript.
				this.#header = frame.header;
				if (frame.entryCount === 0) {
					this.#entries = [];
					this.#publishedEntries = [];
					this.#pendingSnapshot = null;
				} else {
					this.#pendingSnapshot = { entries: [], live: [], total: frame.entryCount };
				}
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#unlistedBusIds.clear();
				this.#working = frame.state.isStreaming;
				this.#idleHostHits = 0;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.#pendingSnapshot;
				if (pending === null) return;
				pending.entries.push(...frame.entries);
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#entries = pending.entries;
				this.#entries.push(...pending.live);
				// Хвост, который был на экране до переподключения, обязан найтись в новой
				// истории; если его нет — хост её не хранит, показываем пробел.
				if (this.#lastKnownEntryId !== null && !this.#entries.some((entry) => entryIdOf(entry) === this.#lastKnownEntryId)) {
					this.#historyGap = true;
					this.#pushNotice("warning", "Часть истории недоступна: хост отдал снапшот без пропущенного фрагмента");
				}
				this.#lastKnownEntryId = null;
				this.#publishedEntries = [...this.#entries];
				this.#pendingSnapshot = null;
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				break;
			}
			case "entry":
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				if (this.#pendingSnapshot !== null) {
					this.#pendingSnapshot.live.push(frame.entry);
					break;
				}
				this.#entries.push(frame.entry);
				this.#publishedEntries = [...this.#entries];
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				this.#idleHostHits = 0;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				this.#pruneBusMaps();
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		if (isCoalescable(frame)) this.#scheduleCommit();
		else this.#commit();
	}

	/**
	 * Drops progress/lifecycle payloads of agents the host no longer lists.
	 * A key missing from this `agents` frame is pruned when it was already
	 * missing from the previous one; the one-frame grace covers progress that
	 * outran its agent's registration.
	 */
	#pruneBusMaps(): void {
		if (this.#progress.size === 0 && this.#lifecycle.size === 0) {
			this.#unlistedBusIds.clear();
			return;
		}
		const listed = new Set<string>();
		for (const agent of this.#agents) listed.add(agent.id);
		const previouslyUnlisted = this.#unlistedBusIds;
		const unlisted = new Set<string>();
		const prune = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
			let kept: Map<string, V> | null = null;
			for (const [id, value] of map) {
				const drop = !listed.has(id) && previouslyUnlisted.has(id);
				if (!listed.has(id) && !drop) unlisted.add(id);
				if (drop && kept === null) {
					kept = new Map();
					for (const [keptId, keptValue] of map) {
						if (keptId === id) break;
						kept.set(keptId, keptValue);
					}
				} else if (!drop && kept !== null) {
					kept.set(id, value);
				}
			}
			return kept ?? map;
		};
		this.#progress = prune(this.#progress);
		this.#lifecycle = prune(this.#lifecycle);
		this.#unlistedBusIds = unlisted;
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			droppedFrames: this.#droppedFrames,
			historyGap: this.#historyGap,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			notices: this.#notices,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.entries.length,
				total: this.#pendingSnapshot.total,
			},
		};
	}

	/** Publishes on the next animation frame; a synchronous commit before then supersedes it. */
	#scheduleCommit(): void {
		if (this.#cancelFrameCommit !== null) return;
		this.#cancelFrameCommit = scheduleFrame(() => {
			this.#cancelFrameCommit = null;
			this.#commit();
		});
	}

	#commit(): void {
		if (this.#cancelFrameCommit !== null) {
			this.#cancelFrameCommit();
			this.#cancelFrameCommit = null;
		}
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}
