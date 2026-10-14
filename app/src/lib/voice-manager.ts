import { GatewayError, transcribeAudio } from "./gateway";

/**
 * Session-independent voice engine (singleton): mic capture + SpeechRecognition +
 * server STT fallback. Lives outside React so recording survives switching sessions.
 * The composer renders state via `subscribeVoice`; the finished transcript is either
 * delivered straight into the mounted session's draft (`setVoiceDelivery`) or parked
 * in `localStorage["ompPocket.voiceDraft.<instanceId>"]` until that session reopens.
 */

export type VoicePhase = "idle" | "recording" | "processing";

export interface VoiceState {
	phase: VoicePhase;
	/** Session the current recording belongs to (null when idle). */
	instanceId: string | null;
	/** Milliseconds since recording start (ticks ~1/s while recording). */
	elapsed: number;
	/** Live (non-final) recognition text. */
	interim: string;
	/** Transient RU note for the mic tooltip (errors, hints). */
	note: string | null;
}

/** Hold time before the tooltip auto-hides. */
const NOTE_MS = 2600;

interface SpeechRecognitionAlternativeLike {
	readonly transcript: string;
}

interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternativeLike;
	[index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
	readonly length: number;
	item(index: number): SpeechRecognitionResultLike;
	[index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
	readonly error: string;
}

interface SpeechRecognitionLike extends EventTarget {
	lang: string;
	interimResults: boolean;
	continuous: boolean;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Shared m:ss display form for the recording timer (manager tick + mic slot). */
export function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

let state: VoiceState = { phase: "idle", instanceId: null, elapsed: 0, interim: "", note: null };
const subscribers = new Set<(s: VoiceState) => void>();

/** Where the next transcript goes: the mounted session screen for `instanceId`. */
let delivery: { instanceId: string; onTranscript: (text: string) => void } | null = null;

const noteTimer: { current: number | null } = { current: null };
const tickTimer: { current: number | null } = { current: null };
const startedAt = { current: 0 };
const finalText = { current: "" };
const speechNote = { current: "" };
const recognition = { current: null as SpeechRecognitionLike | null };
const mediaRecorder = { current: null as MediaRecorder | null };
const chunks = { current: [] as Blob[] };
const stream = { current: null as MediaStream | null };

function emit(patch: Partial<VoiceState>): void {
	state = { ...state, ...patch };
	for (const sub of subscribers) sub(state);
}

function showNote(message: string): void {
	if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
	emit({ note: message });
	noteTimer.current = window.setTimeout(() => {
		noteTimer.current = null;
		if (state.phase === "idle") emit({ note: null });
	}, NOTE_MS);
}

/** Stops recognition and all media tracks / recorder plumbing. */
function teardown(): void {
	if (tickTimer.current !== null) {
		window.clearInterval(tickTimer.current);
		tickTimer.current = null;
	}
	const rec = recognition.current;
	recognition.current = null;
	if (rec) {
		rec.onresult = null;
		rec.onerror = null;
		rec.onend = null;
		try {
			rec.abort();
		} catch {
			// already stopped
		}
	}
	mediaRecorder.current = null;
	chunks.current = [];
	stream.current?.getTracks().forEach(track => track.stop());
	stream.current = null;
}

/** Hands the transcript to the mounted session screen or parks it in localStorage. */
function deliver(text: string): void {
	const target = state.instanceId;
	if (!target) return;
	if (delivery && delivery.instanceId === target) {
		delivery.onTranscript(text);
		return;
	}
	try {
		localStorage.setItem(`ompPocket.voiceDraft.${target}`, text);
	} catch {
		// storage full/blocked — transcript is lost, nothing better to do
	}
}

export function getVoiceState(): VoiceState {
	return state;
}

export function subscribeVoice(sub: (s: VoiceState) => void): () => void {
	subscribers.add(sub);
	return () => {
		subscribers.delete(sub);
	};
}

/** Registers (or on unmount, revokes) the draft-insertion callback for a session. */
export function setVoiceDelivery(instanceId: string, onTranscript: (text: string) => void): void {
	delivery = { instanceId, onTranscript };
}

export function clearVoiceDelivery(instanceId: string): void {
	if (delivery?.instanceId === instanceId) delivery = null;
}

/** Starts a recording for `instanceId`. No-op (false) when busy elsewhere. */
export function startVoice(instanceId: string): boolean {
	if (state.phase !== "idle") return false;
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
		showNote("Голос доступен по https в Chrome");
		return true;
	}
	void beginRecording(instanceId);
	return true;
}

async function beginRecording(instanceId: string): Promise<void> {
	let media: MediaStream;
	try {
		media = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		// No mic permission / no device — say why, never silently.
		showNote("Нет доступа к микрофону — разреши запись в настройках сайта");
		return;
	}
	stream.current = media;

	finalText.current = "";
	speechNote.current = "";
	startedAt.current = Date.now();
	emit({ phase: "recording", instanceId, elapsed: 0, interim: "", note: null });

	// Server fallback path: capture the same stream to a single webm/opus blob.
	try {
		const mr = new MediaRecorder(media, { mimeType: "audio/webm;codecs=opus" });
		mr.ondataavailable = (event: BlobEvent) => {
			if (event.data.size > 0) chunks.current.push(event.data);
		};
		mr.start(); // no timeslice — one blob on stop
		mediaRecorder.current = mr;
	} catch {
		mediaRecorder.current = null; // Web Speech may still carry the release
	}

	tickTimer.current = window.setInterval(() => {
		emit({ elapsed: Date.now() - startedAt.current });
	}, 1000);

	const ctor = getRecognitionCtor();
	if (ctor) {
		const rec = new ctor();
		rec.lang = navigator.language || "ru";
		rec.interimResults = true;
		rec.continuous = true;
		rec.onresult = (event: SpeechRecognitionEventLike) => {
			let live = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result[0]?.transcript ?? "";
				if (result.isFinal) finalText.current += `${text} `;
				else live += text;
			}
			emit({ interim: live });
		};
		// Surface every recognition failure as an RU note on release instead of swallowing it.
		rec.onerror = (event: SpeechRecognitionErrorEventLike) => {
			switch (event.error) {
				case "no-speech":
				case "aborted":
					return; // expected on quick release
				case "not-allowed":
				case "service-not-allowed":
					speechNote.current = "Нет доступа к микрофону — разреши запись в настройках сайта";
					return;
				case "network":
					speechNote.current = "Распознавание речи: нет сети";
					return;
				default:
					speechNote.current = "Распознавание речи недоступно";
			}
		};
		recognition.current = rec;
		try {
			rec.start();
		} catch {
			recognition.current = null;
		}
	}
}

/** Stops the recording: `cancel` discards, otherwise recognize and deliver. */
export function stopVoice(cancel = false): void {
	if (state.phase !== "recording") return;

	const rec = recognition.current;
	recognition.current = null;
	if (rec) {
		rec.onresult = null;
		rec.onerror = null;
		rec.onend = null;
		try {
			rec.abort();
		} catch {
			// already stopped
		}
	}
	if (tickTimer.current !== null) {
		window.clearInterval(tickTimer.current);
		tickTimer.current = null;
	}

	if (cancel) {
		teardown();
		emit({ phase: "idle", instanceId: null, elapsed: 0, interim: "" });
		return;
	}

	const speech = finalText.current.replace(/\s+/g, " ").trim();
	const mr = mediaRecorder.current;
	if (speech) {
		teardown();
		emit({ phase: "idle", instanceId: null, interim: "" });
		deliver(speech);
		return;
	}
	if (!mr || mr.state === "inactive") {
		teardown();
		emit({ phase: "idle", instanceId: null, interim: "" });
		showNote(speechNote.current || "Не удалось распознать — попробуй ещё раз");
		return;
	}

	// Server STT fallback: keep the stream alive until the recorder flushes the blob.
	emit({ phase: "processing" });
	let resolveBlob: (blob: Blob | null) => void = () => undefined;
	const blobReady = new Promise<Blob | null>(resolve => {
		resolveBlob = resolve;
	});
	mr.onstop = () => {
		resolveBlob(chunks.current.length > 0 ? new Blob(chunks.current, { type: mr.mimeType || "audio/webm" }) : null);
	};
	try {
		mr.stop();
	} catch {
		resolveBlob(null);
	}
	void (async () => {
		const blob = await blobReady;
		teardown();
		if (!blob) {
			emit({ phase: "idle", instanceId: null, interim: "" });
			showNote(speechNote.current || "Не удалось распознать — попробуй ещё раз");
			return;
		}
		try {
			const text = await transcribeAudio(blob);
			emit({ phase: "idle", instanceId: null, interim: "" });
			const t = text.replace(/\s+/g, " ").trim();
			if (t) deliver(t);
			else showNote("Не удалось распознать — попробуй ещё раз");
		} catch (err) {
			emit({ phase: "idle", instanceId: null, interim: "" });
			showNote(
				err instanceof GatewayError && err.status === 400
					? "Запись слишком длинная — попробуй короче"
					: "Не удалось распознать — попробуй ещё раз",
			);
		}
	})();
}

