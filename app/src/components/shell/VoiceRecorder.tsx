import { Mic, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	clearVoiceDelivery,
	formatElapsed,
	getVoiceState,
	setVoiceDelivery,
	startVoice,
	stopVoice,
	subscribeVoice,
} from "../../lib/voice-manager";
import type { VoiceState } from "../../lib/voice-manager";
import "./voice.css";

/** Interim text shown next to the timer is clipped to roughly this width. */
const INTERIM_MAX = 24;
/** Tooltip auto-hide delay for component-side notes (permission pre-checks). */
const TOOLTIP_MS = 2600;

export interface VoiceRecorderProps {
	/** Session this mic slot records for; the manager keys transcripts by it. */
	instanceId: string;
	/** Inserts the recognized text into the composer draft (never sends it). */
	onTranscript(text: string): void;
	/** Notifies the composer when this session's recording starts/ends. */
	onActiveChange(active: boolean): void;
	disabled?: boolean;
	/** Visual-check override: renders the given phase with a stub timer, no microphone. */
	debugState?: "recording" | "processing";
}

/**
 * Mic slot in the composer control row. idle: round mic; recording: the same round
 * mic turns into a stop button (error background, white square) with dot+timer+cancel
 * to its left; processing: 44px spinner instead of the button. All capture/STT state
 * lives in the voice-manager singleton and survives session switches.
 */
export function VoiceRecorder({ instanceId, onTranscript, onActiveChange, disabled = false, debugState }: VoiceRecorderProps): ReactNode {
	const canRecord = useRef(false);
	canRecord.current =
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia &&
		typeof MediaRecorder !== "undefined";

	const [voice, setVoice] = useState<VoiceState>(getVoiceState());
	const [micPerm, setMicPerm] = useState<"unknown" | "prompt" | "granted" | "denied">("unknown");
	const [micTouched, setMicTouched] = useState(false);
	const [localNote, setLocalNote] = useState<string | null>(null);
	const localNoteTimer = useRef<number | null>(null);

	useEffect(() => subscribeVoice(setVoice), []);

	// Transcript delivery target: while THIS screen is mounted, finished text lands
	// in its draft; after unmount the manager parks it in localStorage instead.
	const transcriptRef = useRef(onTranscript);
	transcriptRef.current = onTranscript;
	useEffect(() => {
		setVoiceDelivery(instanceId, text => transcriptRef.current(text));
		return () => clearVoiceDelivery(instanceId);
	}, [instanceId]);

	useEffect(() => {
		if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
		void navigator.permissions
			.query({ name: "microphone" as PermissionName })
			.then(status => {
				const norm = (): "prompt" | "granted" | "denied" =>
					status.state === "prompt" ? "prompt" : status.state === "granted" ? "granted" : "denied";
				setMicPerm(norm());
				status.onchange = () => setMicPerm(norm());
			})
			.catch(() => undefined);
	}, []);

	const showLocalNote = useCallback((message: string): void => {
		setLocalNote(message);
		if (localNoteTimer.current !== null) window.clearTimeout(localNoteTimer.current);
		localNoteTimer.current = window.setTimeout(() => {
			setLocalNote(null);
			localNoteTimer.current = null;
		}, TOOLTIP_MS);
	}, []);

	useEffect(
		() => () => {
			if (localNoteTimer.current !== null) window.clearTimeout(localNoteTimer.current);
		},
		[],
	);

	const mine = voice.instanceId === instanceId;
	const phase = debugState ?? (mine ? voice.phase : "idle");
	const recording = phase === "recording";
	const processing = phase === "processing";

	useEffect(() => {
		onActiveChange(recording);
	}, [recording, onActiveChange]);

	const elapsed = debugState ? 7000 : mine ? voice.elapsed : 0;
	const interim = mine ? voice.interim : "";
	const note = localNote ?? (mine ? voice.note : null);
	const clippedInterim = interim.length > INTERIM_MAX ? `…${interim.slice(-INTERIM_MAX)}` : interim;

	const onMicTap = (): void => {
		if (disabled || processing) return;
		setMicTouched(true);
		if (recording) {
			stopVoice(false);
			return;
		}
		if (micPerm === "denied") {
			showLocalNote("Микрофон запрещён — см. подсказку над клавиатурой");
			return;
		}
		if (!canRecord.current) {
			showLocalNote("Голос доступен по https в Chrome");
			return;
		}
		if (!startVoice(instanceId)) showLocalNote("Запись уже идёт в другой сессии");
	};

	const showPermBanner = !recording && !processing && micPerm === "denied";
	const showPermHint = !recording && !processing && micPerm === "prompt" && micTouched;

	return (
		<span className={`vc-root${recording ? " vc-root-rec" : processing ? " vc-root-proc" : ""}`}>
			{recording && (
				<span className="vc-slot" role="status">
					{interim.length > 0 && <span className="vc-interim">{clippedInterim}</span>}
					<span className="vc-dot" aria-hidden="true" />
					<span className="vc-timer">{formatElapsed(elapsed)}</span>
					<button
						type="button"
						className="vc-cancel"
						aria-label="Отменить запись"
						onClick={() => stopVoice(true)}
					>
						<X size={14} />
					</button>
				</span>
			)}
			{processing && (
				<span className="vc-slot vc-slot-proc" role="status">
					<span className="vc-processing-label">Обработка…</span>
				</span>
			)}
			{(showPermBanner || showPermHint) && (
				<span className={showPermBanner ? "vc-perm-banner" : "vc-perm-hint"} role={showPermBanner ? "alert" : "status"}>
					{showPermBanner
						? "🔒 Микрофон запрещён: ⋮ в адресной строке → Разрешения → Микрофон → Разрешить"
						: "Разрешите доступ к микрофону при первом запросе"}
				</span>
			)}
			<span className="vc-anchor">
				{processing ? (
					<span className="vc-spinner" role="progressbar" aria-label="Обработка записи" />
				) : (
					<button
						type="button"
						className={`vc-mic${recording ? " vc-mic-live" : ""}`}
						onClick={onMicTap}
						disabled={disabled}
						aria-label={recording ? "Закончить запись и распознать" : "Голосовое сообщение — нажмите, чтобы записать"}
						title={recording ? "Закончить запись" : "Голосовое сообщение — нажмите"}
					>
						{recording ? <Square size={14} className="vc-stop-icon" /> : <Mic size={16} />}
					</button>
				)}
				{note && (
					<span className="vc-tooltip" role="tooltip">
						{note}
					</span>
				)}
			</span>
		</span>
	);
}
