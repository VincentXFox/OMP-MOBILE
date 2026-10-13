import { Mic, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./voice.css";

/** Hold time before a press counts as "record" rather than a tap. */
const HOLD_MS = 250;
/** Leftward slide (px) that arms cancel-on-release. */
const CANCEL_SLIDE_PX = 64;
/** Tooltip auto-hide delay. */
const TOOLTIP_MS = 2600;

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

interface SpeechRecognitionLike {
	lang: string;
	interimResults: boolean;
	continuous: boolean;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((event: Event) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	if (typeof window === "undefined") return null;
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

const BARS = 18;

export interface VoiceRecorderProps {
	/** Sends transcribed text through the composer's normal path. */
	onSend(text: string): void;
	/** Notifies the composer when recording starts/ends so it can swap the input for the panel. */
	onActiveChange(active: boolean): void;
	disabled?: boolean;
}

/**
 * Telegram-style hold-to-talk voice input. Hold ≥250ms starts capture (mic + AnalyserNode
 * level meter + SpeechRecognition); release sends the accumulated final transcript via
 * `onSend`, sliding left cancels, a short tap explains the gesture. Every exit path stops
 * all media tracks and tears down the AudioContext and recognition. The mic button stays
 * mounted across the whole gesture so pointer capture is never lost mid-press.
 */
export function VoiceRecorder({ onSend, onActiveChange, disabled = false }: VoiceRecorderProps): ReactNode {
	const supported = useRef(false);
	{
		const ctor = getRecognitionCtor();
		supported.current =
			ctor !== null && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
	}

	const [recording, setRecording] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [interim, setInterim] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const [tooltip, setTooltip] = useState<null | "hint" | "fallback">(null);

	const pressTimer = useRef<number | null>(null);
	const tooltipTimer = useRef<number | null>(null);
	const tickTimer = useRef<number | null>(null);
	const rafRef = useRef<number | null>(null);
	const startedAt = useRef(0);
	const startX = useRef(0);
	const cancelArmed = useRef(false);
	const holdBegun = useRef(false);
	const releasedEarly = useRef(false);
	const finalText = useRef("");
	const recognition = useRef<SpeechRecognitionLike | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const audioCtx = useRef<AudioContext | null>(null);
	const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

	const clearTooltip = useCallback((): void => {
		if (tooltipTimer.current !== null) {
			window.clearTimeout(tooltipTimer.current);
			tooltipTimer.current = null;
		}
	}, []);

	const showTooltip = useCallback(
		(kind: "hint" | "fallback"): void => {
			clearTooltip();
			setTooltip(kind);
			tooltipTimer.current = window.setTimeout(() => {
				setTooltip(null);
				tooltipTimer.current = null;
			}, TOOLTIP_MS);
		},
		[clearTooltip],
	);

	/** Stops recognition, all media tracks, the AudioContext and the rAF meter. */
	const teardown = useCallback((): void => {
		if (rafRef.current !== null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
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
		stream.current?.getTracks().forEach(track => track.stop());
		stream.current = null;
		void audioCtx.current?.close().catch(() => undefined);
		audioCtx.current = null;
	}, []);

	useEffect(
		() => () => {
			if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
			clearTooltip();
			teardown();
		},
		[clearTooltip, teardown],
	);

	const beginRecording = useCallback(async (): Promise<void> => {
		try {
			const media = await navigator.mediaDevices.getUserMedia({ audio: true });
			// User let go while the permission prompt was up — never start the session.
			if (releasedEarly.current) {
				media.getTracks().forEach(track => track.stop());
				return;
			}
			stream.current = media;
		} catch {
			// No mic permission / no device — degrade to the fallback hint.
			showTooltip("fallback");
			return;
		}

		holdBegun.current = true;
		finalText.current = "";
		startedAt.current = Date.now();
		setElapsed(0);
		setInterim("");
		setCancelling(false);
		cancelArmed.current = false;
		setRecording(true);
		onActiveChange(true);

		// Level meter: AnalyserNode RMS drives the wave bars without re-rendering React.
		const Ctx = window.AudioContext;
		if (Ctx) {
			const ctx = new Ctx();
			audioCtx.current = ctx;
			const source = ctx.createMediaStreamSource(stream.current);
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			const buf = new Uint8Array(analyser.frequencyBinCount);
			const bars = barRefs.current;
			const loop = (): void => {
				analyser.getByteTimeDomainData(buf);
				let sum = 0;
				for (let i = 0; i < buf.length; i++) {
					const v = (buf[i] - 128) / 128;
					sum += v * v;
				}
				const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
				for (let i = 0; i < BARS; i++) {
					const el = bars[i];
					if (el) {
						const falloff = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
						const h = 4 + level * 26 * (0.35 + 0.65 * falloff);
						el.style.height = `${Math.round(h)}px`;
					}
				}
				rafRef.current = requestAnimationFrame(loop);
			};
			rafRef.current = requestAnimationFrame(loop);
		}

		tickTimer.current = window.setInterval(() => {
			setElapsed(Date.now() - startedAt.current);
		}, 200);

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
				setInterim(live);
			};
			rec.onerror = () => undefined; // no-results / aborted are expected on release
			recognition.current = rec;
			try {
				rec.start();
			} catch {
				recognition.current = null;
			}
		}
	}, [onActiveChange, showTooltip]);

	const finish = useCallback(
		(send: boolean): void => {
			teardown();
			const text = finalText.current.replace(/\s+/g, " ").trim();
			const wasRecording = holdBegun.current;
			holdBegun.current = false;
			cancelArmed.current = false;
			setRecording(false);
			setInterim("");
			setCancelling(false);
			if (wasRecording) {
				if (send && text) onSend(text);
				onActiveChange(false);
			}
		},
		[onActiveChange, onSend, teardown],
	);

	const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
		if (disabled || e.button !== 0) return;
		if (!supported.current) {
			showTooltip("fallback");
			return;
		}
		e.currentTarget.setPointerCapture(e.pointerId);
		startX.current = e.clientX;
		holdBegun.current = false;
		cancelArmed.current = false;
		releasedEarly.current = false;
		pressTimer.current = window.setTimeout(() => {
			pressTimer.current = null;
			void beginRecording();
		}, HOLD_MS);
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
		if (!holdBegun.current) return;
		const armed = e.clientX - startX.current < -CANCEL_SLIDE_PX;
		if (armed !== cancelArmed.current) {
			cancelArmed.current = armed;
			setCancelling(armed);
		}
	};

	const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
		if (pressTimer.current !== null) {
			// Released before the hold threshold — explain the gesture.
			window.clearTimeout(pressTimer.current);
			pressTimer.current = null;
			releasedEarly.current = true;
			if (!disabled && supported.current) showTooltip("hint");
			return;
		}
		if (holdBegun.current) {
			try {
				e.currentTarget.releasePointerCapture(e.pointerId);
			} catch {
				// capture already gone
			}
			finish(!cancelArmed.current);
		}
	};

	const onPointerCancel = (): void => {
		if (pressTimer.current !== null) {
			window.clearTimeout(pressTimer.current);
			pressTimer.current = null;
		}
		if (holdBegun.current) finish(false);
	};

	return (
		<span className={`vc-root${recording ? " vc-root-active" : ""}`}>
			{recording && (
				<span className={`vc-recorder${cancelling ? " vc-recorder-cancel" : ""}`} role="status">
					<span className="vc-dot" aria-hidden="true" />
					<span className="vc-timer">{formatElapsed(elapsed)}</span>
					<span className="vc-wave" aria-hidden="true">
						{Array.from({ length: BARS }, (_, i) => (
							<span
								key={i}
								ref={el => {
									barRefs.current[i] = el;
								}}
								className="vc-bar"
							/>
						))}
					</span>
					{cancelling ? (
						<span className="vc-cancel-hint">
							<X size={14} /> отменить
						</span>
					) : (
						<span className="vc-interim">{interim || "слушаю…"}</span>
					)}
				</span>
			)}
			<span className="vc-anchor">
				<button
					type="button"
					className={`vc-mic${recording ? " vc-mic-live" : ""}`}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerCancel}
					disabled={disabled}
					aria-label="Голосовая запись — удерживайте"
					title="Голосовая запись — удерживайте"
				>
					<Mic size={16} className={recording ? "vc-mic-icon-live" : undefined} />
				</button>
				{tooltip && (
					<span className="vc-tooltip" role="tooltip">
						{tooltip === "hint" ? "Удерживай для записи" : "Голос доступен по https в Chrome"}
					</span>
				)}
			</span>
		</span>
	);
}
