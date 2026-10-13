import type {
	AgentSnapshot,
	CollabUiRequest,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { ArrowDown, ArrowUp, ChevronLeft, ImagePlus, Info, Square, Terminal, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { HostInfo } from "../../lib/gateway";
import { getTerminal, stopAgent } from "../../lib/gateway";
import { cancelSpeech, isTtsEnabled, speakAssistantText } from "../../lib/tts";
import { useGuestSnapshot } from "../../lib/use-guest";
import { FilesScreen } from "../files/FilesScreen";
import { TerminalScreen } from "../terminal/TerminalScreen";
import { Transcript } from "../transcript/Transcript";
import "./session.css";

interface PendingImage {
	data: string;
	mimeType: string;
	url: string;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 4 * 1024 * 1024;
const MAX_IMAGE_DIM = 1568;

async function readAsDataUrl(file: Blob): Promise<string> {
	const reader = new FileReader();
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	reader.onload = () => {
		if (typeof reader.result === "string") resolve(reader.result);
		else reject(new Error("Не удалось прочитать файл"));
	};
	reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
	reader.readAsDataURL(file);
	return promise;
}

/** data URL → base64 payload (no `data:` prefix). */
function b64FromDataUrl(dataUrl: string): string {
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

async function fileToPendingImage(file: File): Promise<PendingImage | null> {
	const mimeType = file.type.startsWith("image/") ? file.type : "image/png";
	let dataUrl = await readAsDataUrl(file);
	for (let attempt = 0; attempt < 6; attempt++) {
		if (b64FromDataUrl(dataUrl).length <= MAX_IMAGE_B64) {
			return { data: b64FromDataUrl(dataUrl), mimeType, url: dataUrl };
		}
		// Too big after encoding — downscale through canvas to the long-side cap.
		const bitmap = await createImageBitmap(file);
		try {
			const scale = Math.min(
				MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height),
				0.8 ** (attempt + 1),
			);
			const w = Math.max(1, Math.round(bitmap.width * scale));
			const h = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(bitmap, 0, 0, w, h);
			dataUrl = canvas.toDataURL(mimeType === "image/png" ? "image/png" : "image/jpeg", 0.85);
		} finally {
			bitmap.close();
		}
	}
	return null;
}

type OptionTone = "success" | "error" | "neutral";

function optionTone(label: string): OptionTone {
	if (/approv|allow|разреш|^да$|^yes$|^ok$/i.test(label)) return "success";
	if (/deny|отклон|запрет|^нет$|^no$/i.test(label)) return "error";
	return "neutral";
}

const PHASE_TEXT: Record<GuestSnapshot["phase"], string> = {
	connecting: "Подключение…",
	waiting: "Подключение…",
	live: "Работает…",
	reconnecting: "Переподключение…",
	ended: "Завершено",
};

function AgentChip({ agent, onTap }: { agent: AgentSnapshot; onTap: () => void }): ReactNode {
	return (
		<button type="button" className="ss-agent-chip" onClick={onTap}>
			<span className={`ss-agent-dot ss-agent-dot--${agent.status}`} />
			<span className="ss-agent-name">{agent.displayName}</span>
		</button>
	);
}

function AgentDrawer({
	agent,
	client,
	progress,
	onClose,
}: {
	agent: AgentSnapshot;
	client: GuestClient;
	progress: SubagentProgressPayload | undefined;
	onClose: () => void;
}): ReactNode {
	const [transcript, setTranscript] = useState<string | null>(null);
	const [loadingTranscript, setLoadingTranscript] = useState(false);
	const [transcriptError, setTranscriptError] = useState<string | null>(null);
	const [chatDraft, setChatDraft] = useState("");
	const [confirmingKill, setConfirmingKill] = useState(false);
	const preRef = useRef<HTMLPreElement | null>(null);

	const loadTranscript = useCallback(async () => {
		setLoadingTranscript(true);
		setTranscriptError(null);
		const result = await client.fetchTranscript(agent.id, 0);
		if (result === null) setTranscriptError("Не удалось загрузить транскрипт");
		else if (result.kind === "error") setTranscriptError(result.message);
		else setTranscript(result.text);
		setLoadingTranscript(false);
	}, [client, agent.id]);

	useEffect(() => {
		const el = preRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [transcript]);

	const sendChat = useCallback(() => {
		const text = chatDraft.trim();
		if (text.length === 0) return;
		client.sendAgentCmd("chat", agent.id, text);
		setChatDraft("");
	}, [chatDraft, client, agent.id]);

	const kill = useCallback(() => {
		setConfirmingKill(false);
		client.sendAgentCmd("kill", agent.id);
	}, [client, agent.id]);

	const revive = useCallback(() => {
		client.sendAgentCmd("revive", agent.id);
	}, [client, agent.id]);

	const liveLine = progress
		? progress.progress.lastIntent ?? progress.progress.currentTool ?? progress.progress.task
		: null;

	return (
		<>
			<div className="ss-sheet-backdrop" onClick={onClose} />
			<div className="ss-agent-drawer" role="dialog" aria-label={agent.displayName}>
				<div className="ss-agent-drawer-head">
					<span className={`ss-agent-dot ss-agent-dot--${agent.status}`} />
					<strong>{agent.displayName}</strong>
					<span className="ss-agent-status-text">{agent.status}</span>
					<button type="button" className="ss-icon-btn" onClick={onClose} aria-label="Закрыть">
						<X size={16} />
					</button>
				</div>
				{liveLine !== null && <div className="ss-agent-live">Сейчас: {liveLine}</div>}
				{transcript === null ? (
					<button type="button" className="ss-opt ss-opt--editor-send" disabled={loadingTranscript} onClick={() => void loadTranscript()}>
						{loadingTranscript ? "Загружаю…" : "Загрузить транскрипт"}
					</button>
				) : (
					<pre ref={preRef} className="ss-agent-transcript">
						{transcript}
					</pre>
				)}
				{transcriptError != null && <div className="ss-agent-line ss-agent-transcript-error">{transcriptError}</div>}
				<div className="ss-agent-actions">
					{confirmingKill ? (
						<>
							<span className="ss-agent-line ss-agent-line--empty">Убить агента?</span>
							<button type="button" className="ss-opt ss-opt--danger" onClick={kill}>
								Да, убить
							</button>
							<button type="button" className="ss-opt ss-opt--editor-cancel" onClick={() => setConfirmingKill(false)}>
								Отмена
							</button>
						</>
					) : (
						<>
							<button type="button" className="ss-opt ss-opt--danger" onClick={() => setConfirmingKill(true)}>
								Убить
							</button>
							<button type="button" className="ss-opt ss-opt--success" onClick={revive}>
								Возродить
							</button>
						</>
					)}
				</div>
				<div className="ss-agent-chat">
					<input
						className="ss-agent-chat-input"
						type="text"
						placeholder="Сообщение сабагенту…"
						value={chatDraft}
						onChange={e => setChatDraft(e.currentTarget.value)}
					/>
					<button
						type="button"
						className="ss-opt ss-opt--editor-send"
						disabled={chatDraft.trim().length === 0}
						onClick={sendChat}
					>
						Чат
					</button>
				</div>
			</div>
		</>
	);
}

function ApprovalSheet({
	request,
	onAnswer,
}: {
	request: CollabUiRequest;
	onAnswer: (value: string | undefined) => void;
}): ReactNode {
	const [draft, setDraft] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");

	return (
		<>
			<div className="ss-sheet-backdrop" />
			<div className="ss-sheet" role="dialog" aria-modal="true">
				<div className="ss-sheet-handle" />
				<div className="ss-sheet-head">
					<TriangleAlert size={20} className="ss-sheet-warn" />
					<span>Требуется решение</span>
				</div>
				<div className="ss-sheet-title">{request.title}</div>
				{request.kind === "select" ? (
					<div className="ss-sheet-options">
						{request.options.map(option => {
							const label = typeof option === "string" ? option : option.label;
							const tone = optionTone(label);
							return (
								<button
									key={label}
									type="button"
									className={`ss-opt ss-opt--${tone}`}
									onClick={() => onAnswer(label)}
								>
									{label}
								</button>
							);
						})}
						<button type="button" className="ss-opt ss-opt--dismiss" onClick={() => onAnswer(undefined)}>
							Отклонить запрос
						</button>
					</div>
				) : (
					<div className="ss-sheet-editor">
						<textarea
							className="ss-editor-input"
							value={draft}
							rows={4}
							onChange={e => setDraft(e.target.value)}
						/>
						<div className="ss-sheet-editor-actions">
							<button type="button" className="ss-opt ss-opt--editor-cancel" onClick={() => onAnswer(undefined)}>
								Отмена
							</button>
							<button type="button" className="ss-opt ss-opt--editor-send" onClick={() => onAnswer(draft)}>
								Отправить
							</button>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

function InfoRow(props: { label: string; value: ReactNode; mono?: boolean }): ReactNode {
	return (
		<div className="ss-info-row">
			<span className="ss-info-label">{props.label}</span>
			<span className={`ss-info-value${props.mono ? " ss-info-value--mono" : ""}`}>{props.value}</span>
		</div>
	);
}

function InfoSheet(props: {
	snap: GuestSnapshot;
	host: HostInfo | undefined;
	onLeave: () => void;
	onOpenTerminal: () => void;
	onOpenFiles: () => void;
	onClose: () => void;
}): ReactNode {
	const { snap, host, onLeave, onOpenTerminal, onOpenFiles, onClose } = props;
	const [confirming, setConfirming] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [stopError, setStopError] = useState<string | null>(null);

	const closeAgent = useCallback(async () => {
		if (!host || stopping) return;
		setStopping(true);
		setStopError(null);
		try {
			await stopAgent(host.instanceId);
			onLeave();
		} catch (err) {
			setStopError(err instanceof Error ? err.message : String(err));
			setStopping(false);
		}
	}, [host, onLeave, stopping]);

	const state = snap.state;
	const usage = state?.contextUsage;
	const model = state?.model;
	const title = state?.sessionName ?? snap.header?.title ?? null;
	const cwd = snap.header?.cwd ?? state?.cwd ?? null;

	return (
		<>
			<div className="ss-sheet-backdrop" onClick={onClose} />
			<div className="ss-sheet ss-info-sheet" role="dialog" aria-modal="true">
				<div className="ss-sheet-handle" />
				<div className="ss-info-title">Об агенте</div>
				<InfoRow label="Сессия" value={title ?? "—"} />
				<InfoRow label="sessionId" value={snap.header?.id ?? "—"} mono />
				<InfoRow label="Папка" value={cwd ?? "—"} mono />
				{model && <InfoRow label="Модель" value={`${model.provider}/${model.id}`} mono />}
				{usage && usage.percent != null && (
					<InfoRow
						label="Контекст"
						value={`${usage.tokens ?? "?"} / ${usage.contextWindow ?? "?"} токенов (${usage.percent}%)`}
					/>
				)}
				<InfoRow label="Фаза" value={`${PHASE_TEXT[snap.phase]}${state?.isStreaming ? " · отвечает" : ""}`} />
				{host && <InfoRow label="Запущен" value={`${new Intl.RelativeTimeFormat("ru", { numeric: "auto" }).format(Math.round((host.startedAt - Date.now()) / 60000), "minute")} · ${new Date(host.startedAt).toLocaleString()}`} />}
				<InfoRow label="Память агента" value="~/.omp/agent" mono />
				{host && (
					<button type="button" className="ss-opt ss-opt--accent" onClick={onOpenTerminal}>
						<Terminal size={16} /> Терминал
					</button>
				)}
				{host && (
					<button type="button" className="ss-opt ss-opt--accent" onClick={onOpenFiles}>
						Файлы проекта
					</button>
				)}
				{host && !confirming && (
					<button type="button" className="ss-opt ss-opt--danger" onClick={() => setConfirming(true)}>
						Закрыть агента
					</button>
				)}
				{host && confirming && (
					<div className="ss-confirm">
						<div className="ss-confirm-text">Агент будет остановлен. Продолжить?</div>
						<div className="ss-confirm-actions">
							<button type="button" className="ss-opt ss-opt--editor-cancel" disabled={stopping} onClick={() => setConfirming(false)}>
								Отмена
							</button>
							<button type="button" className="ss-opt ss-opt--danger" disabled={stopping} onClick={() => void closeAgent()}>
								{stopping ? "Останавливаю…" : "Остановить"}
							</button>
						</div>
						{stopError != null && <div className="ss-confirm-error">{stopError}</div>}
					</div>
				)}
				<button type="button" className="ss-opt ss-opt--dismiss" onClick={onClose}>
					Закрыть
				</button>
			</div>
		</>
	);
}

export function SessionScreen(props: { client: GuestClient; onLeave: () => void; host?: HostInfo }): ReactNode {
	const { client, onLeave, host } = props;
	const snap = useGuestSnapshot(client);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const tailLock = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const busy = snap.state?.isStreaming ?? false;
	const isLive = snap.phase === "live";
	const readOnly = snap.readOnly;
	const queuedCount = snap.state?.queuedMessageCount ?? 0;

	// Tail-follow: stick to bottom on new entries unless the user scrolled up >80px.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || !tailLock.current) return;
		el.scrollTop = el.scrollHeight;
	}, [snap.entries.length, snap.stream, snap.phase]);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		tailLock.current = fromBottom <= 80;
		setShowJump(fromBottom > 80);
	}, []);

	const jumpToTail = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		tailLock.current = true;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		setShowJump(false);
	}, []);

	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [sending, setSending] = useState(false);
	const [attachError, setAttachError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	// Auto-grow 1..6 rows (20px line-height + 16px padding).
	useLayoutEffect(() => {
		const el = taRef.current;
		if (!el) return;
		el.style.height = "auto";
		const max = 6 * 20 + 16;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [draft]);

	const send = useCallback(() => {
		const text = draft.trim();
		if (text.length === 0 && images.length === 0) return;
		if (readOnly || !isLive || sending) return;
		if (images.length > 0) client.sendPromptWithImages(text, images);
		else client.sendPrompt(text);
		setDraft("");
		setImages([]);
		tailLock.current = true;
		// Brief composer lock so the (potentially large) frame lands cleanly.
		setSending(true);
		window.setTimeout(() => setSending(false), 600);
	}, [client, draft, images, isLive, readOnly, sending]);

	const pickFiles = useCallback(async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setAttachError(null);
		const slots = MAX_IMAGES - images.length;
		const picked = Array.from(files).slice(0, slots);
		if (files.length > slots) setAttachError(`Не больше ${MAX_IMAGES} фото за раз`);
		const encoded: PendingImage[] = [];
		for (const file of picked) {
			const img = await fileToPendingImage(file);
			if (img) encoded.push(img);
		}
		setImages(prev => [...prev, ...encoded].slice(0, MAX_IMAGES));
	}, [images.length]);

	const removeImage = useCallback((index: number) => {
		setImages(prev => prev.filter((_, i) => i !== index));
	}, []);

	const abort = useCallback(() => {
		cancelSpeech();
		client.sendAbort();
	}, [client]);

	const [infoOpen, setInfoOpen] = useState(false);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);
	const [toast, setToast] = useState<string | null>(null);
	const toastTimer = useRef<number | null>(null);
	const showToast = useCallback((message: string): void => {
		setToast(message);
		if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), 5000);
	}, []);
	useEffect(
		() => () => {
			if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
		},
		[],
	);

	// Terminal is herdr-only: probe before opening, keep the sheet closed on refusal.
	const openTerminal = useCallback(async () => {
		if (!host) return;
		setInfoOpen(false);
		try {
			const result = await getTerminal(host.instanceId);
			if (result !== null && !("error" in result)) {
				setTerminalOpen(true);
				return;
			}
			showToast("Терминал доступен только для Herdr-агентов");
		} catch (err) {
			showToast(err instanceof Error ? err.message : String(err));
		}
	}, [host, showToast]);

	// Locally dismissed uiRequest: the host clears it only after the response
	// frame round-trips, so hide optimistically to keep the tap feeling instant.
	const [dismissedReq, setDismissedReq] = useState<number | null>(null);
	const answerUi = useCallback(
		(reqId: number, value: string | undefined) => {
			client.sendUiResponse(reqId, value);
			setDismissedReq(reqId);
		},
		[client],
	);
	useEffect(() => {
		// A NEW reqId replaces the sheet content.
		setDismissedReq(prev => (prev !== null && snap.uiRequest?.reqId !== prev ? null : prev));
	}, [snap.uiRequest]);
	const activeRequest = snap.uiRequest !== null && snap.uiRequest.reqId !== dismissedReq ? snap.uiRequest : null;

	const subagents = snap.agents.filter(a => a.kind === "sub");
	const [openAgentId, setOpenAgentId] = useState<string | null>(null);
	const openAgent = subagents.find(a => a.id === openAgentId) ?? null;
	const openAgentProgress = openAgent ? snap.progress.get(openAgent.id) : undefined;

	// TTS: remember the last final assistant text; speak it once when a NEW one lands.
	const lastSpokenRef = useRef<string | null>(null);
	const lastAssistantText = (() => {
		for (let i = snap.entries.length - 1; i >= 0; i--) {
			const entry = snap.entries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const texts: string[] = [];
			for (const block of entry.message.content) {
				if (block.type === "text") texts.push(block.text);
			}
			return texts.join("\n\n").trim();
		}
		return null;
	})();
	useEffect(() => {
		if (lastAssistantText === null || busy || snap.stream !== null) return;
		const spoken = lastSpokenRef.current;
		lastSpokenRef.current = lastAssistantText;
		if (spoken === null || spoken === lastAssistantText || !isTtsEnabled()) return;
		speakAssistantText(lastAssistantText);
	}, [busy, snap.stream, lastAssistantText]);
	// Stop speech when leaving the session screen.
	useEffect(() => cancelSpeech, []);

	const title =
		snap.state?.sessionName ??
		snap.header?.title ??
		(snap.header?.cwd ? snap.header.cwd.slice(snap.header.cwd.lastIndexOf("/") + 1) : "Сессия");
	const statusActive = isLive && busy;

	if (snap.phase === "ended") {
		return (
			<div className="ss-root ss-root--ended">
				<div className="ss-ended-card">
					<div className="ss-ended-title">Сессия закрыта</div>
					{snap.endedReason && <div className="ss-ended-reason">{snap.endedReason}</div>}
					<button type="button" className="ss-opt ss-opt--success" onClick={onLeave}>
						Назад
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="ss-root">
			<header className={`ss-header${activeRequest ? " ss-header--attention" : ""}`}>
				<button type="button" className="ss-icon-btn" onClick={onLeave} aria-label="Назад">
					<ChevronLeft size={20} />
				</button>
				<div className="ss-header-titles">
					<div className="ss-header-title">{title}</div>
					<div className="ss-header-status">
						<span className={`ss-pulse-dot${statusActive ? " ss-pulse-dot--on" : ""}`} />
						{PHASE_TEXT[snap.phase]}
					</div>
				</div>
				<button type="button" className="ss-icon-btn" aria-label="Об агенте" onClick={() => setInfoOpen(true)}>
					<Info size={20} />
				</button>
				{busy && (
					<button type="button" className="ss-icon-btn ss-stop" onClick={abort} aria-label="Прервать">
						<Square size={16} />
					</button>
				)}
			</header>

			{subagents.length > 0 && (
				<div className="ss-agent-row">
					{subagents.map(agent => (
						<AgentChip key={agent.id} agent={agent} onTap={() => setOpenAgentId(agent.id)} />
					))}
				</div>
			)}

			<div className="ss-transcript-wrap">
				<div ref={scrollRef} className="ss-transcript" onScroll={onScroll}>
					<Transcript
						entries={snap.entries}
						stream={snap.stream}
						streamDone={snap.streamDone}
						activeTools={snap.activeTools}
						working={snap.working}
						phase={snap.phase}
					/>
				</div>
				{showJump && (
					<button type="button" className="ss-jump" onClick={jumpToTail} aria-label="Вниз">
						<ArrowDown size={18} />
					</button>
				)}
				{snap.phase === "reconnecting" && <div className="ss-phase-banner">Переподключение…</div>}
				{snap.phase === "connecting" && <div className="ss-phase-banner">Подключение…</div>}
				{snap.phase === "waiting" && <div className="ss-phase-banner">Ожидание снимка сессии…</div>}
			</div>

			<div className="ss-composer-zone">
				{queuedCount > 0 && (
					<div className="ss-queued-row">
						{/* Removing queued messages is host-RPC-only; chip is display-only. */}
						<span className="ss-queued-chip">В очереди: {queuedCount}</span>
					</div>
				)}
				{images.length > 0 && (
					<div className="ss-attach-row">
						{images.map((img, i) => (
							<span key={`${i}:${img.data.slice(0, 16)}`} className="ss-attach-thumb">
								<img src={img.url} alt="" />
								<button
									type="button"
									className="ss-attach-x"
									aria-label="Убрать фото"
									onClick={() => removeImage(i)}
								>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				{attachError != null && <div className="ss-attach-error">{attachError}</div>}
				<div className="ss-composer">
					{busy && (
						<button type="button" className="ss-icon-btn ss-interrupt" onClick={abort} aria-label="Прервать">
							<Square size={16} />
						</button>
					)}
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={e => {
							void pickFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<button
						type="button"
						className="ss-icon-btn ss-attach"
						aria-label="Прикрепить фото"
						disabled={readOnly || !isLive || images.length >= MAX_IMAGES}
						onClick={() => fileRef.current?.click()}
					>
						<ImagePlus size={20} />
					</button>
					<textarea
						ref={taRef}
						className="ss-input"
						rows={1}
						value={draft}
						placeholder="Сообщение агенту…"
						disabled={readOnly || !isLive || sending}
						onChange={e => setDraft(e.target.value)}
					/>
					{images.length > 0 && <span className="ss-attach-hint">{images.length} фото</span>}
					<button
						type="button"
						className="ss-send"
						disabled={(draft.trim().length === 0 && images.length === 0) || readOnly || !isLive || sending}
						onClick={send}
						aria-label="Отправить"
					>
						<ArrowUp size={22} />
					</button>
				</div>
			</div>

			{activeRequest && <ApprovalSheet request={activeRequest} onAnswer={v => answerUi(activeRequest.reqId, v)} />}
			{openAgent && (
				<AgentDrawer
					agent={openAgent}
					client={client}
					progress={openAgentProgress}
					onClose={() => setOpenAgentId(null)}
				/>
			)}
			{infoOpen && (
				<InfoSheet
					snap={snap}
					host={host}
					onLeave={onLeave}
					onOpenTerminal={() => void openTerminal()}
					onOpenFiles={() => {
						setInfoOpen(false);
						setFilesOpen(true);
					}}
					onClose={() => setInfoOpen(false)}
				/>
			)}
			{terminalOpen && host && (
				<TerminalScreen
					instanceId={host.instanceId}
					label={host.sessionName ?? snap.header?.title ?? "агент"}
					onBack={() => setTerminalOpen(false)}
				/>
			)}
			{filesOpen && host && <FilesScreen root={host.cwd} onBack={() => setFilesOpen(false)} />}
			{toast !== null && <div className="ss-toast">{toast}</div>}
		</div>
	);
}
