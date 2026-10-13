import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionStatus, SessionSummary } from "../../lib/gateway";
import { fetchSessions, resumeSession } from "../../lib/gateway";
import { basename, relTime } from "../../lib/format";
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

export function SessionsScreen(props: { onOpenInstance: (instanceId: string) => void }): ReactNode {
	const { onOpenInstance } = props;
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [resumingPath, setResumingPath] = useState<string | null>(null);
	const [resumeError, setResumeError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await fetchSessions();
			setSessions(list);
			setError(null);
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
			const result = await resumeSession(session.cwd, session.path);
			if (result.ok) {
				await reload();
				onOpenInstance(result.instanceId);
			} else {
				setResumeError(`${basename(session.path)}: ${result.error}`);
			}
			setResumingPath(null);
		},
		[onOpenInstance, resumingPath, reload],
	);

	const groups = useMemo(() => (sessions ? groupSessions(sessions) : []), [sessions]);

	if (error != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить сессии</div>
				<div className="pk-empty-text">{error}</div>
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
			{resumeError != null && <div className="pk-form-error sess-resume-error">{resumeError}</div>}
			{groups.map(group => (
				<section key={group.key} className="sess-group">
					<div className="sess-group-label">{group.label}</div>
					<div className="sess-rows">
						{group.sessions.map(session => {
							const dead = DEAD.has(session.status);
							return (
								<div key={session.path} className="pk-card sess-row">
									<div className="sess-row-main">
										<span className="sess-title">{session.title ?? session.id}</span>
										<span
											className={`pk-chip${session.status === "live" ? " pk-chip--on" : ""}${dead ? " sess-chip--dead" : ""}`}
										>
											{STATUS_LABEL[session.status]}
										</span>
									</div>
									<div className="sess-meta">
										{relTime(session.modified)} · {Math.max(1, Math.round(session.size / 1024))} КБ
									</div>
									{dead && session.cwd != null && (
										<button
											className="pk-btn sess-resume"
											disabled={resumingPath != null}
											onClick={() => void resume(session)}
										>
											{resumingPath === session.path ? "Поднимаю…" : "Поднять сессию"}
										</button>
									)}
								</div>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}
