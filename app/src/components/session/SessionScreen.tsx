import type {
	AgentSnapshot,
	CollabUiRequest,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import {
	ArrowDown,
	ArrowUp,
	ChevronLeft,
	CircleAlert,
	FileText,
	Paperclip,
	FolderOpen,
	ImagePlus,
	Info,
	LoaderCircle,
	Pause,
	Pencil,
	Play,
	Plus,
	Square,
	Terminal,
	TriangleAlert,
	X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot, Notice } from "../../lib/client";
import type { HostInfo, ProjectFileEntry } from "../../lib/gateway";
import { fetchHosts, getTerminal, listProjectFiles, readProjectFile, renameAgent, stopAgent, uploadAttachment } from "../../lib/gateway";
import { basename, pluralRu, relTime } from "../../lib/format";
import { todoBoardFromEntries } from "../../lib/todo-board";
import { cancelSpeech, isTtsEnabled, speakAssistantText } from "../../lib/tts";
import { useGuestSnapshot } from "../../lib/use-guest";
import { ConfirmSheet } from "../shell/ConfirmSheet";
import { FilesScreen } from "../files/FilesScreen";
import { TodoBar } from "./TodoBar";
import { VoiceRecorder } from "../shell/VoiceRecorder";
import { TerminalScreen } from "../terminal/TerminalScreen";
import { Transcript } from "../transcript/Transcript";
import "./session-attach.css";
import "./session.css";

interface PendingImage {
	data: string;
	mimeType: string;
	url: string;
}

const MAX_IMAGES = 10;
const MAX_IMAGE_B64 = 4 * 1024 * 1024;
const MAX_IMAGE_DIM = 1568;

/** Text files ride in the prompt as fenced blocks; max 5 pending, 256 КБ each. */
const MAX_TEXT_FILES = 5;
const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_BINARIES = 5;
const ACCEPT_TEXT_FILES =
	"text/*,.txt,.md,.json,.csv,.log,.yaml,.yml,.ts,.tsx,.js,.py,.sh,.ini,.conf,.xml,.html,.css,.sql";

interface PendingImage {
	data: string;
	mimeType: string;
	url: string;
}

interface PendingTextFile {
	name: string;
	content: string;
}

interface PendingBinary {
	name: string;
	size: number;
	mimeType: string;
	file: File;
}

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

const TEXT_FILE_EXTENSIONS: Record<string, true> = {
	txt: true,
	md: true,
	json: true,
	csv: true,
	log: true,
	yaml: true,
	yml: true,
	ts: true,
	tsx: true,
	js: true,
	py: true,
	sh: true,
	ini: true,
	conf: true,
	xml: true,
	html: true,
	css: true,
	sql: true,
};
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|yaml|x-yaml|sql))/;

/** Text-like by extension or MIME; everything else counts as binary. */
function isTextLikeFile(file: File): boolean {
	if (TEXT_MIME_RE.test(file.type)) return true;
	const dot = file.name.lastIndexOf(".");
	if (dot < 0) return false;
	return TEXT_FILE_EXTENSIONS[file.name.slice(dot + 1).toLowerCase()] === true;
}

function readFileAsText(file: File): Promise<string> {
	const reader = new FileReader();
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	reader.onload = () => {
		if (typeof reader.result === "string") resolve(reader.result);
		else reject(new Error("Не удалось прочитать файл"));
	};
	reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
	reader.readAsText(file);
	return promise;
}

/** Fence language hint from the file extension (empty name → txt). */
function extForFileName(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "txt";
}

/** «Файл: имя» heading line + fenced block, appended to the prompt at send time. */
function textFileBlock(file: PendingTextFile): string {
	return `Файл: ${file.name}\n\`\`\`${extForFileName(file.name)}\n${file.content}\n\`\`\``;
}

type OptionTone = "success" | "error" | "neutral";

/** Хостовые служебные события приходят строками на английском — показываем по-русски. */
function noticeRu(message: string): string {
	return message
		.replace(/\bguest joined the collab session\b/i, "Участник подключился к сессии")
		.replace(/\bguest left the collab session\b/i, "Участник отключился от сессии")
		.replace(/\bhost joined the collab session\b/i, "Хост подключился к сессии")
		.replace(/\bhost left the collab session\b/i, "Хост отключился от сессии");
}

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

function AgentChip({ agent, label, onTap }: { agent: AgentSnapshot; label: string; onTap: () => void }): ReactNode {
	return (
		<button type="button" className="ss-agent-chip" onClick={onTap}>
			<span className={`ss-agent-dot ss-agent-dot--${agent.status}`} />
			<span className="ss-agent-name">{label}</span>
		</button>
	);
}

const MAX_ACTIVE_CHIPS = 3;

/** Last word of a phrase, stripped of punctuation — a compact chip differentiator. */
function lastWord(text: string | undefined): string | null {
	const word = text?.trim().split(/\s+/).filter(Boolean).at(-1)?.replace(/[.,;:!?)\]»"']+$/u, "");
	if (!word) return null;
	return word.length > 14 ? `${word.slice(0, 13)}…` : word.toLowerCase();
}

/**
 * «task» chips are indistinguishable, so we add a differentiator: the last
 * word of the agent's current intent / task (from tool progress events).
 * Nothing to differentiate by → numbered «task 1..N».
 */
function chipLabel(agent: AgentSnapshot, progress: SubagentProgressPayload | undefined, position: number): string {
	const word = lastWord(progress?.progress.lastIntent) ?? lastWord(progress?.progress.task);
	if (word) return `${agent.displayName} · ${word}`;
	return `${agent.displayName} ${position + 1}`;
}

/** Chips row: active subagents only (max 3 + «+N»), or one muted summary chip. */
function AgentChipsRow({
	subagents,
	progress,
	onOpen,
}: {
	subagents: AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	onOpen: (id: string) => void;
}): ReactNode {
	const active = subagents.filter(a => a.status === "running");
	if (active.length === 0) {
		const latest = subagents.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a));
		return (
			<div className="ss-agent-row ss-agent-row--quiet">
				<button
					type="button"
					className="ss-agent-chip ss-agent-chip--summary"
					onClick={() => onOpen(latest.id)}
				>
					{subagents.length} сабагентов
				</button>
			</div>
		);
	}
	const shown = active.slice(0, MAX_ACTIVE_CHIPS);
	const hidden = active.length - shown.length;
	return (
		<div className="ss-agent-row">
			{shown.map(agent => (
				<AgentChip
					key={agent.id}
					agent={agent}
					label={chipLabel(agent, progress.get(agent.id), subagents.indexOf(agent))}
					onTap={() => onOpen(agent.id)}
				/>
			))}
			{hidden > 0 && (
				<button
					type="button"
					className="ss-agent-chip ss-agent-chip--more"
					onClick={() => onOpen(shown[shown.length - 1].id)}
				>
					+{hidden}
				</button>
			)}
		</div>
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
			<div className="ss-sheet-backdrop ss-agent-backdrop" onClick={onClose} />
			<div className="ss-agent-drawer" role="dialog" aria-label={agent.displayName}>
				<div className="ss-agent-drawer-handle" />
				<div className="ss-agent-drawer-head">
					<strong>{agent.displayName}</strong>
					<span className={`ss-agent-pill ss-agent-pill--${agent.status}`}>{agent.status}</span>
					<button type="button" className="ss-icon-btn" onClick={onClose} aria-label="Закрыть">
						<X size={16} />
					</button>
				</div>
				<div className="ss-agent-drawer-body">
					{liveLine !== null && (
						<div className="ss-agent-progress-card">
							<span className="ss-agent-progress-label">Сейчас:</span> {liveLine}
						</div>
					)}
					<div className="ss-agent-actions">
						<button type="button" className="ss-agent-btn" disabled={loadingTranscript} onClick={() => void loadTranscript()}>
							{loadingTranscript ? "Загрузка…" : "Транскрипт"}
						</button>
						<button type="button" className="ss-agent-btn ss-agent-btn--danger" onClick={() => setConfirmingKill(true)}>
							Убить
						</button>
						<button type="button" className="ss-agent-btn ss-agent-btn--success" onClick={revive}>
							Возродить
						</button>
					</div>
					<ConfirmSheet
						open={confirmingKill}
						title="Убить сабагента"
						body={`Сабагент «${agent.displayName}» будет принудительно остановлен. Завершённую работу он не сохранит.`}
						confirmLabel="Убить"
						danger
						onConfirm={kill}
						onCancel={() => setConfirmingKill(false)}
					/>
					{transcript !== null && (
						<pre ref={preRef} className="ss-agent-transcript">
							{transcript}
						</pre>
					)}
					{transcriptError != null && <div className="ss-agent-line ss-agent-transcript-error">{transcriptError}</div>}
				</div>
				<div className="ss-agent-chat">
					<input
						className="ss-agent-chat-input"
						type="text"
						placeholder="Сообщение сабагенту…"
						value={chatDraft}
						onChange={e => setChatDraft(e.currentTarget.value)}
						onKeyDown={e => {
							if (e.key === "Enter") sendChat();
						}}
					/>
					<button
						type="button"
						className="ss-agent-send"
						aria-label="Отправить"
						disabled={chatDraft.trim().length === 0}
						onClick={sendChat}
					>
						<ArrowUp size={18} />
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
				{request.kind === "select" && request.helpText ? (
					<div className="ss-sheet-help">
						<Info size={14} className="ss-sheet-help-icon" />
						<span>{request.helpText}</span>
					</div>
				) : null}
				{request.kind === "select" ? (
					<div className="ss-sheet-options">
						{request.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const description = typeof option === "string" ? undefined : option.description;
							const tone = optionTone(label);
							const suggested = request.initialIndex === index;
							return (
								<button
									key={label}
									type="button"
									className={`ss-opt ss-opt--${tone}${suggested ? " ss-opt--suggested" : ""}`}
									onClick={() => onAnswer(label)}
								>
									<span className="ss-opt-label">{label}</span>
									{description ? <span className="ss-opt-description">{description}</span> : null}
									{suggested ? <span className="ss-opt-suggested-mark">предложено</span> : null}
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
	const [confirmMode, setConfirmMode] = useState<null | "stop" | "force">(null);
	const [stopping, setStopping] = useState(false);
	const [stopError, setStopError] = useState<string | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	const [renamingBusy, setRenamingBusy] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	const instanceId = host?.instanceId ?? "";
	const currentName = host
		? host.displayName || host.sessionName || instanceId
		: instanceId;

	const saveRename = useCallback(async () => {
		if (!host || renamingBusy) return;
		const name = renameDraft.replace(/\s+/g, " ").trim();
		if (name.length === 0) return;
		setRenamingBusy(true);
		setRenameError(null);
		try {
			// Шлюз сохраняет кириллическое имя по sessionId (живёт рестарты) и
			// пишет его в title-слот сессии; herdr-слаг остаётся служебным.
			await renameAgent(host.instanceId, name);
			setRenaming(false);
		} catch (err) {
			setRenameError(err instanceof Error ? err.message : String(err));
		} finally {
			setRenamingBusy(false);
		}
	}, [host, renamingBusy, renameDraft]);

	// force=true is the «agent runs outside Pocket» hard kill; it requires an
	// explicit ConfirmSheet step, which closeAgent itself requests when needed.
	const closeAgent = useCallback(
		async (force: boolean) => {
			if (!host || stopping) return;
			setStopping(true);
			setStopError(null);
			try {
				const outcome = await stopAgent(host.instanceId, force);
				if (outcome === "missing") {
					onLeave();
					return;
				}
				if (outcome === "not_started_here") {
					if (!force) {
						setStopping(false);
						setConfirmMode("force");
						return;
					}
					throw new Error("Не удалось остановить агент");
				}
				onLeave();
			} catch (err) {
				setStopError(err instanceof Error ? err.message : String(err));
				setStopping(false);
			}
		},
		[host, onLeave, stopping],
	);

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
						value={`${usage.tokens ?? "?"} / ${usage.contextWindow ?? "?"} токенов (${Math.round(usage.percent)}%)`}
					/>
				)}
				<InfoRow label="Фаза" value={`${PHASE_TEXT[snap.phase]}${state?.isStreaming ? " · отвечает" : ""}`} />
				{host && <InfoRow label="Запущен" value={`${relTime(host.startedAt)} · ${new Date(host.startedAt).toLocaleString()}`} />}
				{renaming ? (
					<div className="ss-rename">
						<input
							type="text"
							className="ss-rename-input"
							value={renameDraft}
							maxLength={48}
							autoFocus
							aria-label="Новое имя чата"
							onChange={e => setRenameDraft(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter") void saveRename();
								if (e.key === "Escape") setRenaming(false);
							}}
						/>
						{renameError != null && <div className="ss-rename-error" role="alert">{renameError}</div>}
						<div className="ss-rename-actions">
							<button type="button" className="ss-opt ss-opt--dismiss" onClick={() => setRenaming(false)}>
								Отмена
							</button>
							<button
								type="button"
								className="ss-opt ss-opt--success"
								disabled={renamingBusy || renameDraft.replace(/\s+/g, " ").trim().length === 0}
								onClick={() => void saveRename()}
							>
								{renamingBusy ? "Сохраняю…" : "Сохранить"}
							</button>
						</div>
					</div>
				) : (
					<div className="ss-info-group">
						<button type="button" className="ss-opt ss-opt--accent ss-rename-open" onClick={() => { setRenameDraft(currentName); setRenaming(true); }}>
							<Pencil size={16} /> Переименовать чат
						</button>
					</div>
				)}
				<InfoRow label="Память агента" value="~/.omp/agent" mono />
				{host && (
					<div className="ss-info-group">
						<button type="button" className="ss-opt ss-opt--accent" onClick={onOpenTerminal}>
							<Terminal size={16} /> Терминал
						</button>
						<button type="button" className="ss-opt ss-opt--accent" onClick={onOpenFiles}>
							Файлы проекта
						</button>
						<button type="button" className="ss-opt ss-opt--danger" onClick={() => setConfirmMode("stop")}>
							Закрыть агента
						</button>
						{stopError != null && <div className="ss-confirm-error">{stopError}</div>}
					</div>
				)}
				<button type="button" className="ss-opt ss-opt--dismiss" onClick={onClose}>
					Закрыть
				</button>
			</div>
			<ConfirmSheet
				open={confirmMode !== null}
				title={confirmMode === "force" ? "Принудительно остановить агента?" : "Закрыть агента?"}
				body={
					confirmMode === "force"
						? "Агент запущен вне Pocket. Он будет завершён принудительно, незавершённая работа будет потеряна."
						: "Сессия агента будет остановлена. Продолжить?"
				}
				confirmLabel={confirmMode === "force" ? "Остановить" : stopping ? "Останавливаю…" : "Остановить"}
				danger
				onConfirm={() => {
					const mode = confirmMode;
					setConfirmMode(null);
					if (mode !== null) void closeAgent(mode === "force");
				}}
				onCancel={() => {
					setConfirmMode(null);
					setStopError(null);
				}}
			/>
		</>
	);
}

export function SessionScreen(props: { client: GuestClient; onLeave: () => void; host?: HostInfo; onReopen?: (instanceId: string) => void }): ReactNode {
	const { client, onLeave, host, onReopen } = props;
	const snap = useGuestSnapshot(client);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const scrollElRef = useRef<HTMLElement | null>(null);
	const tailLock = useRef(true);
	const [showJump, setShowJump] = useState(false);

	const busy = snap.state?.isStreaming ?? false;
	const isLive = snap.phase === "live";
	const readOnly = snap.readOnly;
	const queuedCount = snap.state?.queuedMessageCount ?? 0;
	const todoBoard = useMemo(() => todoBoardFromEntries(snap.entries), [snap.entries]);

	// Автопереподключение: агент умер/перезапустился (сбой питания, апдейт) —
	// ищем живой хост с той же сессией и молча открываем его, чат сам вернётся.
	const sessionId = snap.header?.id ?? null;
	const instanceId = host?.instanceId ?? "";
	const [rejoinWaiting, setRejoinWaiting] = useState(false);
	const onReopenRef = useRef(onReopen);
	onReopenRef.current = onReopen;
	useEffect(() => {
		if (snap.phase !== "ended" || sessionId === null || onReopenRef.current === undefined) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const attempt = async (): Promise<void> => {
			try {
				const hosts = await fetchHosts();
				const hit = hosts.find((h) => h.sessionId === sessionId && h.instanceId !== instanceId);
				if (cancelled) return;
				if (hit !== undefined) {
					setRejoinWaiting(false);
					onReopenRef.current?.(hit.instanceId);
					return;
				}
				setRejoinWaiting(true);
			} catch {
				if (!cancelled) setRejoinWaiting(true);
			}
			if (!cancelled) timer = setTimeout(() => void attempt(), 5000);
		};
		timer = setTimeout(() => void attempt(), 2000);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			setRejoinWaiting(false);
		};
	}, [snap.phase, sessionId, instanceId]);

	const onScroll = useCallback(() => {
		const el = scrollElRef.current;
		if (!el) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		tailLock.current = fromBottom <= 120;
		setShowJump(fromBottom > 120);
	}, []);

	// The real transcript scroller is `.tr-root` inside <Transcript>, not the
	// wrapper div; bind (once) to it and keep refs in sync across re-renders.
	useLayoutEffect(() => {
		const wrap = scrollRef.current;
		if (!wrap) return;
		const el = wrap.querySelector<HTMLElement>(".tr-root");
		if (!el || el === scrollElRef.current) return;
		scrollElRef.current = el;
		el.addEventListener("scroll", onScroll, { passive: true });
	}, [onScroll, snap.phase]);

	useEffect(
		() => () => {
			scrollElRef.current?.removeEventListener("scroll", onScroll);
		},
		[onScroll],
	);

	// Tail-follow: stick to bottom on new entries unless the user scrolled up >120px.
	useLayoutEffect(() => {
		const el = scrollElRef.current;
		if (!el || !tailLock.current) return;
		el.scrollTop = el.scrollHeight;
	}, [snap.entries.length, snap.stream, snap.phase]);

	const jumpToTail = useCallback(() => {
		const el = scrollElRef.current;
		if (!el) return;
		tailLock.current = true;
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
		setShowJump(false);
	}, []);

	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	const [textFiles, setTextFiles] = useState<PendingTextFile[]>([]);
	// бинарные вложения (pdf/zip/…): грузятся на шлюз при отправке, в промпт — md-ссылка
	const [binaries, setBinaries] = useState<PendingBinary[]>([]);
	const [attachMenuOpen, setAttachMenuOpen] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const anyFileRef = useRef<HTMLInputElement | null>(null);
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

	// Composer is writable while live AND while reconnecting: sends land in the
	// client-side socket queue (≤256 frames) and flush on reconnect.
	const composerActive = isLive || snap.phase === "reconnecting";

	const send = useCallback(async (): Promise<void> => {
		const text = draft.trim();
		if (text.length === 0 && images.length === 0 && textFiles.length === 0 && binaries.length === 0) return;
		if (readOnly || !composerActive) return;
		// Картинки грузим на шлюз и вшиваем markdown-ссылки в текст: снапшот
		// collab отдаёт гостевые промпты без image-блоков, а md-картинку лента
		// рендерит и без них (модель дополнительно получает сами блоки).
		const links: string[] = [];
		for (const img of images) {
			try {
				const b64 = img.data.includes(",") ? img.data.split(",")[1] ?? img.data : img.data;
				const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
				const url = await uploadAttachment(bytes, img.mimeType);
				links.push(`![вложение](${url})`);
			} catch (err) {
				links.push(`_(вложение не загрузилось: ${err instanceof Error ? err.message : String(err)})_`);
			}
		}
		// Бинарные файлы (pdf/zip/…): файл на шлюз, в промпте ссылка — агент скачает и разберёт.
		for (const bin of binaries) {
			try {
				const bytes = new Uint8Array(await bin.file.arrayBuffer());
				const url = await uploadAttachment(bytes, bin.mimeType, bin.name);
				links.push(`📎 [${bin.name}](${url})`);
			} catch (err) {
				links.push(`_(${bin.name} не загрузился: ${err instanceof Error ? err.message : String(err)})_`);
			}
		}
		// User text first, then attachments, then attached files as «Файл: имя» + fenced blocks.
		const fullText = [text, ...links, ...textFiles.map(textFileBlock)]
			.filter(part => part.length > 0)
			.join("\n\n");
		if (images.length > 0) client.sendPromptWithImages(fullText, images);
		else client.sendPrompt(fullText);
		setDraft("");
		setImages([]);
		setTextFiles([]);
		setBinaries([]);
		tailLock.current = true;
	}, [client, draft, images, textFiles, binaries, composerActive, readOnly]);

	const pickFiles = useCallback(async (files: FileList | File[] | null) => {
		if (!files || files.length === 0) return;
		setAttachError(null);
		const slots = MAX_IMAGES - images.length;
		const picked = Array.from(files).slice(0, slots);
		if (files.length > slots) setAttachError(`Больше ${MAX_IMAGES - images.length} не влезет — лимит ${MAX_IMAGES}`);
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

	// Android keyboard: visualViewport shrink = keyboard inset → lift the composer.
	const [kbInset, setKbInset] = useState(0);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const update = () => {
			setKbInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
		};
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		update();
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, []);

	const [voiceActive, setVoiceActive] = useState(false);
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

	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const [projectDir, setProjectDir] = useState<string | null>(null);
	const [projectEntries, setProjectEntries] = useState<ProjectFileEntry[] | null>(null);
	const [projectBusy, setProjectBusy] = useState(false);
	const [projectError, setProjectError] = useState<string | null>(null);

	const loadProjectDir = useCallback(
		async (dir: string) => {
			setProjectBusy(true);
			setProjectError(null);
			try {
				const res = await listProjectFiles(dir);
				setProjectEntries(res.entries.filter(e => e.type === "file"));
				setProjectDir(dir);
			} catch (err) {
				setProjectError(err instanceof Error ? err.message : String(err));
			} finally {
				setProjectBusy(false);
			}
		},
		[],
	);

	const attachProjectFile = useCallback(
		async (name: string) => {
			if (!host || projectBusy) return;
			if (textFiles.length >= MAX_TEXT_FILES) {
				showToast(`Не больше ${MAX_TEXT_FILES} файлов`);
				return;
			}
			if (textFiles.some(t => t.name === name)) {
				showToast("Уже прикреплён");
				setProjectPickerOpen(false);
				return;
			}
			setProjectBusy(true);
			setProjectError(null);
			try {
				const content = await readProjectFile(host.cwd, name);
				setTextFiles(prev => (prev.some(t => t.name === name) ? prev : [...prev, { name, content }]));
				showToast(`Прикреплён: ${name}`);
				setProjectPickerOpen(false);
			} catch (err) {
				setProjectError(err instanceof Error ? err.message : String(err));
			} finally {
				setProjectBusy(false);
			}
		},
		[host, projectBusy, textFiles, showToast],
	);
	// Voice transcript lands in the draft for editing — never auto-sends.
	// Вставка должна быть ЗАМЕТНОЙ: фокус в поле, вспышка рамки и тост.
	const insertVoiceTranscript = useCallback(
		(text: string) => {
			const t = text.trim();
			if (t.length === 0) {
				showToast("Не удалось распознать речь — попробуй ещё раз");
				return;
			}
			setDraft(prev => {
				const base = prev.trimEnd();
				return base.length === 0 ? t : `${base} ${t}`;
			});
			showToast("✓ Голос распознан — проверь и отправь");
			requestAnimationFrame(() => {
				const el = taRef.current;
				if (!el) return;
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
				el.classList.remove("ss-input--flash");
				void el.offsetWidth;
				el.classList.add("ss-input--flash");
			});
		},
		[showToast],
	);

	const [infoOpen, setInfoOpen] = useState(false);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);

	const removeTextFile = useCallback((index: number) => {
		setTextFiles(prev => prev.filter((_, i) => i !== index));
	}, []);

	// «Файл» menu path: text files become pending chips (inlined at send time);
	// photos picked here fall through to the photo pipeline; the rest is binary.
	const pickAnyFiles = useCallback(
		async (files: FileList | null) => {
			if (!files || files.length === 0) return;
			const all = Array.from(files);
			const photos = all.filter(file => file.type.startsWith("image/"));
			if (photos.length > 0) void pickFiles(photos);
			const docs = all.filter(file => !file.type.startsWith("image/"));
			let slots = MAX_TEXT_FILES - textFiles.length;
			let binSlots = MAX_BINARIES - binaries.length;
			for (const file of docs) {
				if (!isTextLikeFile(file)) {
					// бинарные (pdf/zip/docx/…) — на шлюз при отправке, в промпт ссылкой
					if (binSlots <= 0) {
						showToast(`Не больше ${MAX_BINARIES} бинарных файлов`);
						continue;
					}
					if (file.size > 10 * 1024 * 1024) {
						showToast(`${file.name}: больше 10 МБ`);
						continue;
					}
					setBinaries(prev =>
						prev.length >= MAX_BINARIES ? prev : [...prev, { name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", file }],
					);
					binSlots -= 1;
					continue;
				}
				if (slots <= 0) {
					showToast(`Не больше ${MAX_TEXT_FILES} текстовых файлов`);
					break;
				}
				if (file.size > MAX_TEXT_FILE_BYTES) {
					showToast("Файл больше 256 КБ — вставь фрагмент");
					continue;
				}
				try {
					const content = await readFileAsText(file);
					setTextFiles(prev =>
						prev.length >= MAX_TEXT_FILES ? prev : [...prev, { name: file.name, content }],
					);
					slots -= 1;
				} catch {
					showToast("Не удалось прочитать файл");
				}
			}
		},
		[pickFiles, textFiles.length, binaries.length, showToast],
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
	// An incoming approval must never hide under the subagent drawer.
	useEffect(() => {
		if (activeRequest !== null) setOpenAgentId(null);
	}, [activeRequest]);

	// Host notices → dismissible banners above the transcript.
	const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<number>>(() => new Set());
	const droppedNotice: Notice | null =
		snap.droppedFrames > 0
			? {
					id: -1,
					level: "warning",
					message: `Очередь переполнилась: ${snap.droppedFrames} кадров потеряно — сообщения могли не дойти. Отправь заново.`,
					at: 0,
				}
			: null;
	const visibleNotices = [
		...(droppedNotice ? [droppedNotice] : []),
		...snap.notices
			.filter(notice => !dismissedNotices.has(notice.id))
			// Одинаковые события подряд (вход/выход гостя циклами) — мусор в ленте.
			.filter((notice, i, arr) => i === 0 || notice.message !== arr[i - 1].message)
			.slice(-3),
	];
	const dismissNotice = useCallback((id: number) => {
		setDismissedNotices(prev => new Set(prev).add(id));
	}, []);

	// Персистентный голосовой черновик: менеджер кладёт распознанный текст в
	// localStorage, если сессия была закрыта; при монтировании забираем его в draft.
	const [voiceNotice, setVoiceNotice] = useState(false);
	useEffect(() => {
		if (instanceId.length === 0) return;
		const key = `ompPocket.voiceDraft.${instanceId}`;
		let parked: string | null = null;
		try {
			parked = localStorage.getItem(key);
			if (parked !== null) localStorage.removeItem(key);
		} catch {
			return;
		}
		const t = parked?.trim() ?? "";
		if (t.length === 0) return;
		setDraft(prev => {
			const base = prev.trimEnd();
			return base.length === 0 ? t : `${base} ${t}`;
		});
		setVoiceNotice(true);
	}, [instanceId]);
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
					{rejoinWaiting && (
						<div className="ss-ended-reason">
							Ищу поднятого агента с этой сессией — чат откроется сам, когда агент вернётся.
						</div>
					)}
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

			{subagents.length > 0 && <AgentChipsRow subagents={subagents} progress={snap.progress} onOpen={setOpenAgentId} />}

			<div className="ss-transcript-wrap">
				{(visibleNotices.length > 0 || voiceNotice) && (
					<div className="ss-notices">
						{voiceNotice && (
							<div className="ss-notice ss-notice--info" role="status">
								<Info size={16} />
								<span className="ss-notice-text">Голосовое сообщение распознано — отправь когда готов</span>
								<button
									type="button"
									className="ss-notice-x"
									aria-label="Скрыть"
									onClick={() => setVoiceNotice(false)}
								>
									<X size={16} />
								</button>
							</div>
						)}
						{visibleNotices.map(notice => (
							<div
								key={notice.id}
								className={`ss-notice ss-notice--${notice.level}`}
								role="alert"
							>
								{notice.level === "error" ? (
									<CircleAlert size={16} />
								) : (
									<Info size={16} />
								)}
								<span className="ss-notice-text">{noticeRu(notice.message)}</span>
								<button
									type="button"
									className="ss-notice-x"
									aria-label="Скрыть"
									onClick={() => dismissNotice(notice.id)}
								>
									<X size={16} />
								</button>
							</div>
						))}
					</div>
				)}
				<div ref={scrollRef} className="ss-transcript">
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
				{snap.phase === "reconnecting" && (
					<div className="ss-phase-banner">Нет сети — переподключение…</div>
				)}
				{snap.phase === "connecting" && <div className="ss-phase-banner">Подключение…</div>}
				{snap.phase === "waiting" && (
					<div className="ss-phase-banner">
						{snap.loading !== null
							? `Загрузка сессии: ${snap.loading.received} / ${snap.loading.total}`
							: "Ожидание снимка сессии…"}
					</div>
				)}
			</div>

			<div
				className="ss-composer-zone"
				style={{ "--ss-kb": `${kbInset}px` } as CSSProperties}
			>
				{todoBoard !== null && <TodoBar board={todoBoard} />}
				{!composerActive && (
					<div className="ss-offline-note">Не в сети — отправим при подключении</div>
				)}
				{queuedCount > 0 && (
					<div className="ss-queued-row">
						{/* Removing queued messages is host-RPC-only; chip is display-only. */}
						<span className="ss-queued-chip">В очереди: {queuedCount} {pluralRu(queuedCount, "сообщение", "сообщения", "сообщений")}</span>
					</div>
				)}
				{binaries.length > 0 && (
					<div className="sa-chip-row">
						{binaries.map((bin, i) => (
							<span key={`${i}:${bin.name}`} className="sa-chip">
								<Paperclip size={12} className="sa-chip-icon" />
								<span className="sa-chip-name">{bin.name}</span>
								<button
									type="button"
									className="sa-chip-x"
									aria-label="Убрать файл"
									onClick={() => setBinaries(prev => prev.filter((_, j) => j !== i))}
								>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				{textFiles.length > 0 && (
					<div className="sa-chip-row">
						{textFiles.map((file, i) => (
							<span key={`${i}:${file.name}`} className="sa-chip">
								<FileText size={12} className="sa-chip-icon" />
								<span className="sa-chip-name">{file.name}</span>
								<button
									type="button"
									className="sa-chip-x"
									aria-label="Убрать файл"
									onClick={() => removeTextFile(i)}
								>
									<X size={12} />
								</button>
							</span>
						))}
					</div>
				)}
				{attachError != null && <div className="ss-attach-error">{attachError}</div>}
				<div className="ss-composer">
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
					<input
						ref={anyFileRef}
						type="file"
						multiple
						hidden
						onChange={e => {
							void pickAnyFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					{/* textarea всегда смонтирована — запись не должна перестраивать низ. */}
					<textarea
						ref={taRef}
						className={`ss-input${voiceActive ? " ss-input--muted" : ""}`}
						rows={1}
						value={draft}
						placeholder={voiceActive ? "Запись голоса…" : "Спроси OMP…"}
						disabled={readOnly}
						onChange={e => setDraft(e.target.value)}
						onKeyDown={e => {
							if (e.key !== "Enter" || e.shiftKey) return;
							// IME composition (CJK and friends): Enter confirms the
							// candidate, it must not send.
							if (e.nativeEvent.isComposing) return;
							e.preventDefault();
							void send();
						}}
					/>
					<div className="ss-composer-controls">
						<button
							type="button"
							className="ss-icon-btn ss-attach"
							aria-label="Прикрепить"
							aria-expanded={attachMenuOpen}
							disabled={readOnly || !composerActive}
							onClick={() => setAttachMenuOpen(true)}
						>
							<Plus size={22} />
						</button>
						{host && (
							<button
								type="button"
								className="ss-model-chip"
								onClick={() => setInfoOpen(true)}
								aria-label="Модель и агент — подробнее"
								title="Модель и агент"
							>
								{host.model.id}
							</button>
						)}
						{/* mic/send switch: draft + attachments present → send, otherwise mic.
						    textarea всегда смонтирована — запись не перестраивает низ. */}
						{draft.trim().length > 0 || images.length > 0 || textFiles.length > 0 || binaries.length > 0 ? (
							<button
								type="button"
								className="ss-send"
								disabled={readOnly || !composerActive}
								onClick={() => void send()}
								aria-label="Отправить"
							>
								<ArrowUp size={22} />
							</button>
						) : (
							<VoiceRecorder
								instanceId={instanceId}
								onTranscript={insertVoiceTranscript}
								onActiveChange={setVoiceActive}
								disabled={readOnly || !composerActive}
							/>
						)}
					</div>
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
			{attachMenuOpen && (
				<>
					<div className="sa-backdrop" onClick={() => setAttachMenuOpen(false)} />
					<div className="sa-sheet" role="dialog" aria-modal="true" aria-label="Прикрепить">
						<div className="sa-handle" />
						<button
							type="button"
							className="sa-item"
							onClick={() => {
								setAttachMenuOpen(false);
								fileRef.current?.click();
							}}
						>
							<ImagePlus size={18} />
							Фото или видео
						</button>
						<button
							type="button"
							className="sa-item"
							onClick={() => {
								setAttachMenuOpen(false);
								anyFileRef.current?.click();
							}}
						>
							<FileText size={18} />
							Файл
						</button>
						<button
							type="button"
							className="sa-item"
							onClick={() => {
								setAttachMenuOpen(false);
								setProjectPickerOpen(true);
								if (host) void loadProjectDir(host.cwd);
							}}
						>
							<FolderOpen size={18} />
							Файл из проекта
						</button>
						<button type="button" className="sa-item sa-item--cancel" onClick={() => setAttachMenuOpen(false)}>
							Отмена
						</button>
					</div>
				</>
			)}
			{projectPickerOpen && host && (
				<>
					<div className="sa-backdrop" onClick={() => setProjectPickerOpen(false)} />
					<div className="sa-sheet" role="dialog" aria-modal="true" aria-label="Файлы проекта">
						<div className="sa-handle" />
						<div className="sa-proj-title">Файлы проекта · {basename(host.cwd)}</div>
						{projectError != null && (
							<div className="ss-rename-error ss-proj-error" role="alert">
								{projectError}
							</div>
						)}
						{projectBusy && <div className="sa-item ss-proj-busy">Загрузка…</div>}
						{!projectBusy &&
							projectDir != null &&
							projectDir !== host.cwd && (
								<button
									type="button"
									className="sa-item"
									onClick={() => void loadProjectDir(projectDir.slice(0, projectDir.lastIndexOf("/")) || host.cwd)}
								>
									<FolderOpen size={16} /> Наверх
								</button>
							)}
						{!projectBusy &&
							(projectEntries ?? []).map(entry =>
								entry.type === "dir" ? (
									<button
										key={entry.name}
										type="button"
										className="sa-item"
										onClick={() => void loadProjectDir(`${projectDir}/${entry.name}`)}
									>
										<FolderOpen size={16} /> {entry.name}
									</button>
								) : (
									<button
										key={entry.name}
										type="button"
										className="sa-item"
										onClick={() => void attachProjectFile(entry.name)}
									>
										<FileText size={16} /> {entry.name}
									</button>
								),
							)}
						{!projectBusy && projectEntries != null && projectEntries.length === 0 && (
							<div className="sa-item ss-proj-busy">В папке нет файлов</div>
						)}
						<button type="button" className="sa-item sa-item--cancel" onClick={() => setProjectPickerOpen(false)}>
							Готово
						</button>
					</div>
				</>
			)}
			{toast !== null && <div className="ss-toast">{toast}</div>}
		</div>
	);
}
