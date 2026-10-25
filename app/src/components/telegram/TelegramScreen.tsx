import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Send } from "lucide-react";
import type { SessionSummary } from "../../lib/gateway";
import { fetchSessions, fetchSessionTail } from "../../lib/gateway";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { Transcript } from "../transcript/Transcript";
import { relTime } from "../../lib/format";
import "./telegram.css";

/** Каталог моста Telegram в листинге шлюза: `external:sessions`. */
const BRIDGE_SLUG = "external:sessions";
const POLL_MS = 5000;
const TAIL = 60;

/** Самая свежая сессия моста — её и открываем без выбора. */
function latestBridgeSession(sessions: SessionSummary[]): SessionSummary | null {
	let best: SessionSummary | null = null;
	for (const session of sessions) {
		if (session.projectSlug !== BRIDGE_SLUG) continue;
		if (best === null || session.modified > best.modified) best = session;
	}
	return best;
}

function rowTitle(session: SessionSummary): string {
	if (session.title !== null && session.title.length > 0) return session.title;
	if (session.preview !== null && session.preview.length > 0) return session.preview;
	return session.id.slice(0, 8);
}

export function TelegramScreen(): ReactNode {
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const bottomRef = useRef<HTMLDivElement | null>(null);

	const bridgeSessions = useMemo(
		() => (sessions ?? []).filter(s => s.projectSlug === BRIDGE_SLUG).sort((a, b) => b.modified - a.modified),
		[sessions],
	);

	const loadSessions = useCallback(async (): Promise<void> => {
		try {
			const list = await fetchSessions();
			setSessions(list);
			setError(null);
			setSelected(prev => {
				if (prev !== null && list.some(s => s.path === prev)) return prev;
				return latestBridgeSession(list)?.path ?? null;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const loadTail = useCallback(async (path: string, silent = false): Promise<void> => {
		if (!silent) setLoading(true);
		try {
			const next = await fetchSessionTail({ path }, TAIL);
			if (next.length > 0) setEntries(next);
			setError(null);
		} catch (err) {
			if (!silent) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!silent) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadSessions();
		const timer = window.setInterval(() => void loadSessions(), POLL_MS * 2);
		return () => window.clearInterval(timer);
	}, [loadSessions]);

	const selectedSession = useMemo(
		() => (sessions ?? []).find(s => s.path === selected) ?? null,
		[sessions, selected],
	);

	// Переписка бота пополняется извне (Telegram), поэтому хвост перечитывается
	// по таймеру: mtime сессии — единственный сигнал «есть новое».
	const modified = selectedSession?.modified ?? 0;
	useEffect(() => {
		if (selected === null) return;
		void loadTail(selected);
		const timer = window.setInterval(() => void loadTail(selected, true), POLL_MS);
		return () => window.clearInterval(timer);
	}, [selected, modified, loadTail]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [entries]);

	if (sessions !== null && bridgeSessions.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Переписки с ботом пока нет</div>
				<div className="pk-empty-text">
					Напиши боту в Telegram — сессия появится здесь и её можно будет читать с любого устройства.
				</div>
			</div>
		);
	}

	return (
		<div className="tg-screen">
			<aside className="tg-rail" aria-label="Сессии бота">
				<div className="tg-rail-head">Телеграм</div>
				<div className="tg-rail-list">
					{bridgeSessions.map(session => {
						const on = session.path === selected;
						return (
							<button
								key={session.path}
								type="button"
								className={`tg-rail-item${on ? " tg-rail-item--on" : ""}`}
								onClick={() => setSelected(session.path)}
							>
								<span className="tg-rail-title">{rowTitle(session)}</span>
								<span className="tg-rail-meta">
									{relTime(session.modified)} · {session.status === "live" ? "в работе" : "завершён"}
								</span>
							</button>
						);
					})}
				</div>
				<div className="tg-rail-foot">
					<button type="button" className="pk-btn pk-btn--ghost" onClick={() => void loadSessions()}>
						<RefreshCw size={15} />
						Обновить
					</button>
					<a className="pk-btn pk-btn--ghost" href="https://web.telegram.org/" target="_blank" rel="noreferrer">
						<ExternalLink size={15} />
						Открыть Telegram
					</a>
				</div>
			</aside>

			<section className="tg-chat" aria-label="Переписка">
				<header className="tg-chat-head">
					<span className="tg-chat-title">{selectedSession ? rowTitle(selectedSession) : "Выбери сессию"}</span>
					{selectedSession !== null && (
						<span className="tg-chat-sub">
							{selectedSession.id.slice(0, 8)} · {relTime(selectedSession.modified)} · {entries.length} записей
						</span>
					)}
					<button
						type="button"
						className="pk-btn pk-btn--ghost tg-refresh"
						disabled={selected === null || loading}
						onClick={() => selected !== null && void loadTail(selected)}
					>
						<RefreshCw size={15} />
						{loading ? "Обновляю…" : "Обновить"}
					</button>
				</header>

				{error != null && <div className="pk-form-error tg-error">{error}</div>}

				<div className="tg-transcript">
					{entries.length === 0 ? (
						<div className="pk-empty">
							<div className="pk-empty-title">Пока пусто</div>
							<div className="pk-empty-text">Хвост переписки подгрузится, как только бот ответит.</div>
						</div>
					) : (
						<Transcript
							entries={entries}
							stream={null}
							streamDone
							activeTools={new Map()}
							working={selectedSession?.status === "live"}
						/>
					)}
					<div ref={bottomRef} />
				</div>

				<footer className="tg-note">
					<Send size={14} />
					Отправка из приложения — в Telegram: переписка ведётся ботом, здесь она только читается.
				</footer>
			</section>
		</div>
	);
}
