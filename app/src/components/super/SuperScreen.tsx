import { ChevronDown, SendHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { basename, relTime } from "../../lib/format";
import type { DispatchResult, SuperActivity, SuperAgent, SuperAgentStatus, SuperBoard } from "../../lib/gateway";
import { dispatchSuperTasks, fetchSuperActivity, fetchSuperBoard } from "../../lib/gateway";
import "./super.css";

const BOARD_POLL_MS = 3000;
const ACTIVITY_POLL_MS = 4000;
const RESULTS_TTL_MS = 20_000;

type DispatchMode = "common" | "plan";

const STATUS_META: Record<SuperAgentStatus, { label: string; dot: string }> = {
	idle: { label: "Ожидает", dot: "su-dot--idle" },
	working: { label: "Работает", dot: "su-dot--working" },
	blocked: { label: "Ждёт ввода", dot: "su-dot--blocked" },
	done: { label: "Завершено", dot: "su-dot--done" },
	unknown: { label: "Статус неизвестен", dot: "su-dot--unknown" },
};

function statusOf(agent: SuperAgent): { label: string; dot: string } {
	if (agent.host && !agent.host.relayConnected) return { label: "Нет связи", dot: "su-dot--unknown" };
	return STATUS_META[agent.agentStatus];
}

function AgentName(props: { board: SuperBoard | null; target: string }): ReactNode {
	const name = props.board?.agents.find(a => a.target === props.target)?.name;
	return <>{name ?? props.target}</>;
}

function SubagentChip(props: { name: string; active: boolean; activity: string }): ReactNode {
	return (
		<span className="pk-chip su-sub" title={props.activity || undefined}>
			<span className={`pk-dot su-dot${props.active ? " su-dot--working" : " su-dot--idle"}`} />
			{props.name}
		</span>
	);
}

function AgentCard(props: {
	agent: SuperAgent;
	board: SuperBoard | null;
	expanded: boolean;
	onToggle: () => void;
	activity: SuperActivity | null;
	onOpenSession: (instanceId: string) => void;
}): ReactNode {
	const { agent, expanded } = props;
	const status = statusOf(agent);
	const runningSubs = agent.subagents.filter(s => s.active).length;
	return (
		<div className={`pk-card su-card${expanded ? " su-card--open" : ""}`}>
			<button type="button" className="su-head" onClick={props.onToggle}>
				<span className={`pk-dot su-dot ${status.dot}`} />
				<span className="su-name">{agent.name}</span>
				<span className="su-status">{status.label}</span>
				<span className="su-toggle">
					<ChevronDown size={16} className={expanded ? "su-chevron--up" : undefined} />
				</span>
			</button>
			{agent.title && <div className="su-title">{agent.title}</div>}
			<div className="su-meta">
				<span>{basename(agent.cwd)}</span>
				{agent.host?.sessionName && <span>· {agent.host.sessionName}</span>}
				{agent.host?.inputRequired && <span className="su-flag">· требует ввода</span>}
				{runningSubs > 0 && <span className="su-flag su-flag--live">· субагентов: {runningSubs}</span>}
			</div>
			{agent.subagents.length > 0 && (
				<div className="pk-chips su-subs">
					{agent.subagents.map(s => (
						<SubagentChip key={s.name} name={s.name} active={s.active} activity={s.activity} />
					))}
				</div>
			)}
			{expanded && (
				<div className="su-detail">
					{agent.subagents.length > 0 && (
						<div className="su-sublist">
							{agent.subagents.map(s => (
								<div key={s.name} className="su-subrow">
									<span className={`pk-dot su-dot${s.active ? " su-dot--working" : " su-dot--idle"}`} />
									<span className="su-subrow-name">{s.name}</span>
									<span className="su-subrow-act">{s.activity || "—"}</span>
									<span className="su-subrow-when">{relTime(s.updatedAt)}</span>
								</div>
							))}
						</div>
					)}
					{props.activity ? (
						<pre className="su-tail">{props.activity.tail.trimEnd() || "терминал пуст"}</pre>
					) : (
						<div className="su-tail su-tail--loading">Загрузка активности…</div>
					)}
					{agent.host && (
						<button type="button" className="pk-btn pk-btn--ghost su-open" onClick={() => props.onOpenSession(agent.host!.instanceId)}>
							Открыть сессию
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export function SuperScreen(props: {
	onOpenSession: (instanceId: string) => void;
}): ReactNode {
	const [board, setBoard] = useState<SuperBoard | null>(null);
	const [boardError, setBoardError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<DispatchMode>("common");
	const [perTask, setPerTask] = useState<Record<string, string>>({});
	const [text, setText] = useState("");
	const [dispatching, setDispatching] = useState(false);
	const [results, setResults] = useState<DispatchResult[] | null>(null);
	const [dispatchError, setDispatchError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [activity, setActivity] = useState<SuperActivity | null>(null);
	const boardRef = useRef<SuperBoard | null>(null);
	boardRef.current = board;

	// board polling
	useEffect(() => {
		let alive = true;
		const poll = async (): Promise<void> => {
			try {
				const next = await fetchSuperBoard();
				if (!alive) return;
				setBoard(next);
				setBoardError(null);
				// drop vanished targets from selection
				setSelected(prev => {
					const live = new Set(next.agents.map(a => a.target));
					const kept = [...prev].filter(t => live.has(t));
					return kept.length === prev.size ? prev : new Set(kept);
				});
			} catch (err) {
				if (!alive) return;
				setBoardError(err instanceof Error ? err.message : String(err));
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), BOARD_POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	// expanded card activity polling
	useEffect(() => {
		if (expanded === null) {
			setActivity(null);
			return;
		}
		let alive = true;
		const load = async (): Promise<void> => {
			try {
				const next = await fetchSuperActivity(expanded);
				if (alive) setActivity(next);
			} catch {
				// keep previous tail; board polling surfaces agent disappearance
			}
		};
		void load();
		const timer = setInterval(() => void load(), ACTIVITY_POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [expanded]);

	// dispatch results fade out
	useEffect(() => {
		if (results === null && dispatchError === null) return;
		const timer = setTimeout(() => {
			setResults(null);
			setDispatchError(null);
		}, RESULTS_TTL_MS);
		return () => clearTimeout(timer);
	}, [results, dispatchError]);

	// Правка компоуза — начало нового цикла раздачи: старые результаты не должны
	// висеть и глушить подсказки валидации.
	const beginCompose = useCallback((): void => {
		setResults(null);
		setDispatchError(null);
	}, []);

	const toggle = useCallback((target: string): void => {
		beginCompose();
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(target)) next.delete(target);
			else next.add(target);
			return next;
		});
	}, [beginCompose]);

	const selectAll = useCallback((): void => {
		beginCompose();
		const agents = boardRef.current?.agents ?? [];
		setSelected(prev => (prev.size === agents.length ? new Set() : new Set(agents.map(a => a.target))));
	}, [beginCompose]);

	const dispatch = useCallback(async (): Promise<void> => {
		if (dispatching || selected.size === 0) return;
		// Снапшот текстов на момент клика — защита от гонки с редактированием в полёте.
		const snapshot = new Map<string, string>();
		for (const target of selected) snapshot.set(target, mode === "plan" ? perTask[target] ?? "" : text);
		if (selected.size > 12) {
			setDispatchError("Максимум 12 агентов за раз.");
			return;
		}
		for (const [target, taskText] of snapshot) {
			if (new TextEncoder().encode(taskText).length > 65536) {
				const name = boardRef.current?.agents.find(a => a.target === target)?.name ?? target;
				setDispatchError(`Текст для ${name} больше 64 КиБ — сократите.`);
				return;
			}
		}
		const items = [...snapshot].map(([target, taskText]) => ({ target, text: taskText }));
		setDispatching(true);
		setResults(null);
		setDispatchError(null);
		try {
			const outcomes = await dispatchSuperTasks(items);
			setResults(outcomes);
			if (mode === "plan") {
				setPerTask(prev => {
					const next = { ...prev };
					for (const r of outcomes) {
						if ("error" in r) continue;
						// чистим только если текст не изменили, пока шла отправка
						if (next[r.target] === snapshot.get(r.target)) delete next[r.target];
					}
					return next;
				});
			} else {
				setText("");
			}
		} catch (err) {
			setDispatchError(err instanceof Error ? err.message : String(err));
		} finally {
			setDispatching(false);
		}
	}, [dispatching, mode, perTask, selected, text]);

	const agents = board?.agents ?? [];
	const allSelected = agents.length > 0 && selected.size === agents.length;
	const planAgents = mode === "plan" ? agents.filter(a => selected.has(a.target)) : [];
	const missingPlan = planAgents.filter(a => (perTask[a.target] ?? "").trim() === "").map(a => a.name);
	const oversizePlan = planAgents.find(a => new TextEncoder().encode(perTask[a.target] ?? "").length > 65536);
	const canSend = selected.size > 0
		&& (mode === "common" ? text.trim() !== "" : missingPlan.length === 0)
		&& !dispatching;

	return (
		<div className="su-screen">
			<div className="pk-card su-composer">
				<div className="pk-chips su-modes">
					<button
						type="button"
						className={`pk-chip su-mode${mode === "common" ? " pk-chip--on" : ""}`}
						onClick={() => { beginCompose(); setMode("common"); }}
					>
						Всем одинаково
					</button>
					<button
						type="button"
						className={`pk-chip su-mode${mode === "plan" ? " pk-chip--on" : ""}`}
						onClick={() => { beginCompose(); setMode("plan"); }}
					>
						По плану
					</button>
				</div>
				{mode === "common" ? (
					<textarea
						className="pk-input su-task"
						placeholder="Задача для агентов… одно и то же задание уйдёт всем выбранным"
						rows={3}
						value={text}
						onChange={e => { beginCompose(); setText(e.target.value); }}
					/>
				) : (
					<div className="su-plan">
						{planAgents.map(a => {
							const status = statusOf(a);
							return (
								<div key={a.target} className="su-plan-item">
									<div className="su-plan-head">
										<span className={`pk-dot su-dot ${status.dot}`} />
										<span className="su-plan-name">{a.name}</span>
										<span className="su-status">{status.label}</span>
									</div>
									<textarea
										key={a.target}
										className="pk-input su-task"
										placeholder={`Задача для ${a.name}…`}
										rows={3}
										value={perTask[a.target] ?? ""}
										onChange={e => { beginCompose(); setPerTask(prev => ({ ...prev, [a.target]: e.target.value })); }}
									/>
								</div>
							);
						})}
						{planAgents.length === 0 && <div className="su-none">Выберите агентов — под каждого появится своя карточка.</div>}
					</div>
				)}
				<div className="su-pick">
					<div className="pk-chips">
						{agents.map(a => {
							const status = statusOf(a);
							const on = selected.has(a.target);
							return (
								<button
									key={a.target}
									type="button"
									className={`pk-chip su-pick-chip${on ? " pk-chip--on" : ""}`}
									onClick={() => toggle(a.target)}
								>
									<span className={`pk-dot su-dot ${status.dot}`} />
									{a.name}
								</button>
							);
						})}
						{agents.length === 0 && <span className="su-none">Нет агентов в herdr</span>}
					</div>
					{agents.length > 0 && (
						<button type="button" className="su-all" onClick={selectAll}>
							{allSelected ? "Снять все" : "Выбрать всех"}
						</button>
					)}
				</div>
				<button
					type="button"
					className="pk-btn su-send"
					disabled={!canSend}
					onClick={() => void dispatch()}
				>
					{dispatching ? <span className="pk-spinner" /> : <SendHorizontal size={16} />}
					Раздать{selected.size > 0 ? ` (${selected.size})` : ""}
				</button>
				{mode === "plan" && results === null && missingPlan.length > 0 && selected.size > 0 && (
					<div className="su-hint">Нет текста: {missingPlan.join(", ")}</div>
				)}
				{selected.size > 12 && <div className="su-hint">Максимум 12 агентов за раз</div>}
				{oversizePlan && <div className="su-hint">Текст для {oversizePlan.name} больше 64 КиБ — сократите</div>}
				{dispatchError && <div className="su-result su-result--err">{dispatchError}</div>}
				{results && (
					<div className="su-results">
						{results.map(r => (
							<div key={r.target} className={`su-result${"error" in r ? " su-result--err" : ""}`}>
								{"error" in r ? "✗" : "✓"} <AgentName board={board} target={r.target} />
								{"error" in r ? `: ${r.error}` : null}
							</div>
						))}
					</div>
				)}
			</div>

			{boardError && <div className="su-error">Доска недоступна: {boardError}</div>}
			{board === null && !boardError && <div className="su-loading">Загрузка доски…</div>}
			{board !== null && agents.length === 0 && (
				<div className="pk-empty">
					<div className="pk-empty-title">Агентов нет</div>
					<div className="pk-empty-text">Запусти агентов на вкладке «Агенты» — они появятся на доске.</div>
				</div>
			)}

			{agents.map(a => (
				<AgentCard
					key={a.target}
					agent={a}
					board={board}
					expanded={expanded === a.target}
					onToggle={() => setExpanded(prev => (prev === a.target ? null : a.target))}
					activity={expanded === a.target ? activity : null}
					onOpenSession={props.onOpenSession}
				/>
			))}

			{board !== null && board.orphans.length > 0 && (
				<div className="su-orphans">
					Вне herdr: {board.orphans.map(o => o.sessionName ?? basename(o.cwd)).join(", ")}
				</div>
			)}
		</div>
	);
}
