import type { AgentSnapshot, CollabUiRequest } from "@oh-my-pi/pi-wire";
import { ArrowDown, ArrowUp, ChevronLeft, Square, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { useGuestSnapshot } from "../../lib/use-guest";
import { Transcript } from "../transcript/Transcript";
import "./session.css";

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
	lines,
	onClose,
}: {
	agent: AgentSnapshot;
	lines: string[];
	onClose: () => void;
}): ReactNode {
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
				<div className="ss-agent-drawer-body">
					{lines.length === 0 ? (
						<div className="ss-agent-line ss-agent-line--empty">Пока нет данных.</div>
					) : (
						lines.map((line, i) => (
							<div key={i} className="ss-agent-line">
								{line}
							</div>
						))
					)}
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

export function SessionScreen(props: { client: GuestClient; onLeave: () => void }): ReactNode {
	const { client, onLeave } = props;
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
		if (text.length === 0 || readOnly || !isLive) return;
		client.sendPrompt(text);
		setDraft("");
		tailLock.current = true;
	}, [client, draft, isLive, readOnly]);

	const abort = useCallback(() => client.sendAbort(), [client]);

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

	const subagents = useMemo(() => snap.agents.filter(a => a.kind === "sub"), [snap.agents]);
	const [openAgentId, setOpenAgentId] = useState<string | null>(null);
	const openAgent = subagents.find(a => a.id === openAgentId) ?? null;
	const openAgentLines = useMemo(() => {
		if (!openAgent) return [];
		const lines: string[] = [];
		const progress = snap.progress.get(openAgent.id);
		if (progress) {
			lines.push(`Задача: ${progress.progress.task}`);
			if (progress.progress.currentTool) lines.push(`Инструмент: ${progress.progress.currentTool}`);
			if (progress.progress.lastIntent) lines.push(`Сейчас: ${progress.progress.lastIntent}`);
			lines.push(
				`Токены: ${progress.progress.tokens} · Вызовы: ${progress.progress.toolCount} · Шаг ${progress.progress.index}`,
			);
		}
		const life = snap.lifecycle.get(openAgent.id);
		if (life) lines.push(`Статус: ${life.status}`);
		return lines;
	}, [openAgent, snap.progress, snap.lifecycle]);

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
				<div className="ss-composer">
					{busy && (
						<button type="button" className="ss-icon-btn ss-interrupt" onClick={abort} aria-label="Прервать">
							<Square size={16} />
						</button>
					)}
					<textarea
						ref={taRef}
						className="ss-input"
						rows={1}
						value={draft}
						placeholder="Сообщение агенту…"
						disabled={readOnly || !isLive}
						onChange={e => setDraft(e.target.value)}
					/>
					<button
						type="button"
						className="ss-send"
						disabled={draft.trim().length === 0 || readOnly || !isLive}
						onClick={send}
						aria-label="Отправить"
					>
						<ArrowUp size={22} />
					</button>
				</div>
			</div>

			{activeRequest && <ApprovalSheet request={activeRequest} onAnswer={v => answerUi(activeRequest.reqId, v)} />}
			{openAgent && <AgentDrawer agent={openAgent} lines={openAgentLines} onClose={() => setOpenAgentId(null)} />}
		</div>
	);
}
