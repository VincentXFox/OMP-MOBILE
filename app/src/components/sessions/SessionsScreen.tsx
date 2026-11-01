import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { SessionStatus, SessionSummary } from "../../lib/gateway";
import { fetchSessions, renameSession, resumeSession } from "../../lib/gateway";
import { basename, relTime } from "../../lib/format";
import { staleMark } from "../../lib/offline";
import "./sessions.css";

const STATUS_LABEL: Record<SessionStatus, string> = {
	live: "живой",
	complete: "завершён",
	aborted: "прерван",
	error: "ошибка",
	interrupted: "оборван",
	unknown: "новая",
};

const DEAD: ReadonlySet<SessionStatus> = new Set(["interrupted", "aborted", "error"]);
/** Сколько карточек рисуем за раз; остальное — по мере прокрутки. */
const STEP_ROWS = 40;

interface SessionGroup {
	key: string;
	label: string;
	sessions: SessionSummary[];
}

function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
	const map = new Map<string, SessionGroup>();
	for (const session of sessions) {
		const key = session.cwd ?? session.projectSlug;
		const group = map.get(key);
		if (group) group.sessions.push(session);
		else map.set(key, { key, label: basename(key), sessions: [session] });
	}
	return [...map.values()];
}

/** Человекочитаемое имя: title omp → первый запрос кириллицей → короткий id. */
function rowTitle(session: SessionSummary): string {
	if (session.title !== null && session.title.length > 0) return session.title;
	if (session.preview !== null && session.preview.length > 0) return session.preview;
	return session.id.slice(0, 8);
}

/** «Оборван/прерван» = жертва сбоя — поднимаем с --restore (доделать ход и субагентов). */
function isCrashVictim(session: SessionSummary): boolean {
	return session.status === "interrupted" || session.status === "aborted";
}

function createdLabel(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return sameDay ? `сегодня ${time}` : `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${time}`;
}

export function SessionsScreen(props: { onOpenInstance: (instanceId: string) => void }): ReactNode {
	const { onOpenInstance } = props;
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [resumingPath, setResumingPath] = useState<string | null>(null);
	const [resumeError, setResumeError] = useState<string | null>(null);
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renamingBusy, setRenamingBusy] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	// Список показан из кэша: сеть упала, но последняя удачная копия осталась.
	const [staleAt, setStaleAt] = useState<number | null>(null);
	// 370 карточек разом — это заметная работа на телефоне. Рисуем первые
	// STEP, остальные добавляем по прокрутке: список открывается сразу.
	const [shown, setShown] = useState(STEP_ROWS);
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			// Показ из копии мгновенный; свежий список придёт подписчиком и
			// молча заменит копию — ждать канал не нужно.
			const list = await fetchSessions(undefined, fresh => {
				setSessions(fresh);
				setStaleAt(staleMark("sessions"));
			});
			setSessions(list);
			setError(null);
			setStaleAt(staleMark("sessions"));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const resume = useCallback(
		async (session: SessionSummary): Promise<void> => {
			if (!session.cwd || resumingPath != null) return;
			setResumingPath(session.path);
			setResumeError(null);
			const mode = isCrashVictim(session) ? "restore" : "resume";
			const result = await resumeSession(session.cwd, session.path, { mode });
			if (result.ok && result.instanceId !== undefined) {
				await reload();
				onOpenInstance(result.instanceId);
			} else {
				setResumeError(`${rowTitle(session)}: ${result.error ?? "не удалось возобновить"}`);
			}
			setResumingPath(null);
		},
		[onOpenInstance, resumingPath, reload],
	);

	const saveRename = useCallback(
		async (session: SessionSummary): Promise<void> => {
			if (renamingBusy) return;
			const title = renameDraft.replace(/\s+/g, " ").trim();
			if (title.length === 0) return;
			setRenamingBusy(true);
			setRenameError(null);
			const result = await renameSession(session.path, title);
			if (result.ok === true) {
				setRenamingPath(null);
				setRenameDraft("");
				await reload();
			} else {
				setRenameError(result.error);
			}
			setRenamingBusy(false);
		},
		[renamingBusy, renameDraft, reload],
	);

	const visible = useMemo(
		() => (sessions === null ? null : sessions.slice(0, shown)),
		[sessions, shown],
	);
	const groups = useMemo<SessionGroup[]>(() => (visible === null ? [] : groupSessions(visible)), [visible]);
	const hasMore = sessions !== null && visible !== null && visible.length < sessions.length;

	// Догрузка по появлению хвостового маркера: без кнопок и без лишних перерисовок.
	useEffect(() => {
		const el = sentinelRef.current;
		if (el === null || !hasMore) return;
		const observer = new IntersectionObserver(entries => {
			if (entries.some(entry => entry.isIntersecting)) setShown(prev => prev + STEP_ROWS);
		}, { rootMargin: "600px 0px" });
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, shown]);

	// Ошибка не должна стирать уже загруженный список: показываем её баннером
	// с повтором, а данные остаются на экране.
	if (error != null && sessions == null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить сессии</div>
				<div className="pk-empty-text">{error}</div>
				<button type="button" className="pk-btn pk-btn--ghost" onClick={() => void reload()}>
					Повторить
				</button>
			</div>
		);
	}
	if (sessions == null) {
		return (
			<div className="sess-groups" aria-hidden="true">
				{[0, 1, 2, 3].map(i => (
					<div key={i} className="pk-card sess-row">
						<span className="pk-skeleton sess-sk sess-sk--title" />
						<span className="pk-skeleton sess-sk sess-sk--meta" />
					</div>
				))}
			</div>
		);
	}
	if (groups.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Сессий нет</div>
				<div className="pk-empty-text">Запусти агента — история сохранится здесь и переживёт падение.</div>
			</div>
		);
	}

	return (
		<div className="sess-groups">
			{staleAt !== null && (
				<div className="sess-stale-note" role="status">
					Нет связи — показана копия от{" "}
					{new Date(staleAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
					{" · "}
					<button type="button" className="pk-btn pk-btn--ghost" onClick={() => void reload()}>
						Обновить
					</button>
				</div>
			)}
			{error != null && (
				<div className="pk-form-error sess-resume-error" role="alert">
					{error}{" "}
					<button type="button" className="pk-btn pk-btn--ghost" onClick={() => void reload()}>
						Повторить
					</button>
				</div>
			)}
			{resumeError != null && <div className="pk-form-error sess-resume-error">{resumeError}</div>}
			{groups.map(group => (
				<section key={group.key} className="sess-group">
					<div className="sess-group-label">{group.label}</div>
					<div className="sess-rows">
						{group.sessions.map(session => {
							const dead = DEAD.has(session.status);
							const victim = isCrashVictim(session);
							const renaming = renamingPath === session.path;
							return (
								<div key={session.path} className="pk-card sess-row">
									<div className="sess-row-main">
										<span className="sess-title">{rowTitle(session)}</span>
										<span
											className={`pk-chip${session.status === "live" ? " pk-chip--on" : ""}${dead ? " sess-chip--dead" : ""}`}
										>
											{STATUS_LABEL[session.status]}
										</span>
										{session.parentId !== null && (
											<span className="pk-chip sess-chip--child" title={`Продолжение сессии ${session.parentId.slice(0, 8)}`}>
												продолжение
											</span>
										)}
									</div>
									<div className="sess-meta">
										{createdLabel(session.createdTs)} · {relTime(session.modified)} · {Math.max(1, Math.round(session.size / 1024))} КБ
									</div>
									{victim && (
										<div className="sess-victim-note">Погиб при сбое — при подъёме агент доделает прерванный ход и субагентов</div>
									)}
									{renaming ? (
										<div className="sess-rename">
											<input
												className="pk-field-input"
												value={renameDraft}
												autoFocus
												placeholder="Название кириллицей"
												onChange={e => setRenameDraft(e.target.value)}
												onKeyDown={e => {
													if (e.key === "Enter") void saveRename(session);
													if (e.key === "Escape") setRenamingPath(null);
												}}
											/>
											<button
												type="button"
												className="pk-btn sess-rename-btn"
												aria-label="Сохранить название"
												disabled={renamingBusy || renameDraft.trim().length === 0}
												onClick={() => void saveRename(session)}
											>
												<Check size={16} />
											</button>
											<button
												type="button"
												className="pk-btn sess-rename-btn"
												aria-label="Отмена"
												onClick={() => setRenamingPath(null)}
											>
												<X size={16} />
											</button>
										</div>
									) : (
										<div className="sess-actions">
											{dead && session.cwd != null && (
												<button
													className="pk-btn sess-resume"
													disabled={resumingPath != null || renamingBusy}
													onClick={() => void resume(session)}
												>
													{resumingPath === session.path ? "Поднимаю…" : victim ? "Поднять с доделкой" : "Поднять сессию"}
												</button>
											)}
											<button
												type="button"
												className="pk-icon-btn sess-rename-toggle"
												aria-label="Переименовать"
												onClick={() => {
													setRenameDraft(session.title ?? "");
													setRenamingPath(session.path);
													setRenameError(null);
												}}
											>
												<Pencil size={15} />
											</button>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</section>
			))}
			{hasMore && (
				<div ref={sentinelRef} className="sess-more">
					Показано {visible?.length ?? 0} из {sessions?.length ?? 0}
				</div>
			)}
			{renameError != null && <div className="pk-form-error sess-resume-error">{renameError}</div>}
		</div>
	);
}
