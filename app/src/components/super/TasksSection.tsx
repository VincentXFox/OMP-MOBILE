import { ChevronDown, Pause, Play, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { basename, fmtCost, fmtTokens, relTime } from "../../lib/format";
import {
	answerTaskApproval,
	createTask,
	fetchTasks,
	taskAction,
	type TaskStatus,
	type TaskStopReason,
	type TaskSummary,
} from "../../lib/gateway";

/** «Автономные задачи»: очередь целей, которые штурм ведёт сам.
 *
 * Отличие от раздачи задач агентам выше: там задание уходит в терминал и
 * человек читает транскрипт, здесь цикл «промпт → проверки → следующий ход»
 * крутит шлюз, а карточка показывает только то, что ПОДТВЕРЖДЕНО проверкой,
 * и остаток бюджета. Поэтому опрос 3 с (как у «Штата»), а не поток.
 */

const TASKS_POLL_MS = 3000;
/** Бюджет и резерв по умолчанию: хватает на десяток ходов, резерв держится
 *  на финальную приёмку, чтобы цикл не кончился ровно перед проверками. */
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_RESERVE_TOKENS = 20_000;

const STATUS_META: Record<TaskStatus, { label: string; cls: string }> = {
	queued: { label: "В очереди", cls: "su-tst--idle" },
	running: { label: "Работает", cls: "su-tst--live" },
	verifying: { label: "Проверка", cls: "su-tst--live" },
	awaiting_approval: { label: "Ждёт разрешения", cls: "su-tst--warn" },
	paused: { label: "Пауза", cls: "su-tst--idle" },
	blocked: { label: "Заблокирована", cls: "su-tst--warn" },
	budget_exhausted: { label: "Бюджет исчерпан", cls: "su-tst--warn" },
	no_progress: { label: "Нет прогресса", cls: "su-tst--err" },
	cancelled: { label: "Отменена", cls: "su-tst--off" },
	failed: { label: "Сбой", cls: "su-tst--err" },
	done: { label: "Готово", cls: "su-tst--ok" },
};

const STOP_LABEL: Record<TaskStopReason["kind"], string> = {
	done: "готово",
	budget: "бюджет исчерпан",
	no_progress: "нет прогресса",
	blocked: "нужен внешний шаг",
	cancelled: "отменена",
	failed: "сбой",
};

/** Терминальные статусы: продолжать нечего, кнопки управления не нужны. */
const TERMINAL: Record<TaskStatus, boolean> = {
	queued: false,
	running: false,
	verifying: false,
	awaiting_approval: false,
	paused: false,
	blocked: true,
	budget_exhausted: true,
	no_progress: true,
	cancelled: true,
	failed: true,
	done: true,
};

function spendLine(task: TaskSummary): string {
	const parts = [`${fmtTokens(task.tokensUsed)} токенов`];
	parts.push(task.spend.costUsd === null ? "$ н/д" : fmtCost(task.spend.costUsd));
	const left = Math.max(0, task.budget.maxTokens - task.tokensUsed);
	parts.push(`остаток ${fmtTokens(left)}`);
	if (task.budget.reserveTokens > 0) parts.push(`резерв ${fmtTokens(task.budget.reserveTokens)}`);
	return parts.join(" · ");
}

function TaskCard(props: {
	task: TaskSummary;
	busy: boolean;
	onAction: (id: string, action: "pause" | "resume" | "cancel") => void;
	onApproval: (id: string, decision: "allow" | "deny") => void;
}): ReactNode {
	const t = props.task;
	const meta = STATUS_META[t.status] ?? STATUS_META.queued;
	const terminal = TERMINAL[t.status];
	const approval = t.status === "awaiting_approval" ? t.approval : null;
	return (
		<div className={`pk-card su-task${terminal ? " su-task--closed" : ""}`}>
			<div className="su-task-top">
				<span className={`su-tst ${meta.cls}`}>{meta.label}</span>
				<span className="su-task-when">{relTime(t.updatedAt)}</span>
			</div>
			<div className="su-task-goal">{t.goal}</div>
			<div className="su-meta">
				<span>{basename(t.cwd)}</span>
				<span>· этап: {t.stage !== "" ? t.stage : "—"}</span>
				<span>· ходов: {t.turns}</span>
				<span>· критериев {t.criteriaPassed}/{t.criteriaTotal}</span>
			</div>
			<div className="su-task-line su-task-verified">
				{t.lastVerifiedResult !== null ? `проверено: ${t.lastVerifiedResult}` : "проверено: пока ничего"}
			</div>
			<div className="su-task-line">{spendLine(t)}</div>
			{t.stopReason !== null && (
				<div className="su-task-line su-task-stop">
					Остановка ({STOP_LABEL[t.stopReason.kind] ?? t.stopReason.kind}): {t.stopReason.detail}
				</div>
			)}
			{approval !== null && (
				<div className="su-task-approval">
					<div className="su-task-approval-title">{approval.title}</div>
					{approval.detail !== "" && <div className="su-task-approval-detail">{approval.detail}</div>}
					<div className="su-task-actions">
						<button
							type="button"
							className="pk-btn su-task-btn"
							disabled={props.busy}
							onClick={() => props.onApproval(t.id, "allow")}
						>
							Разрешить
						</button>
						<button
							type="button"
							className="pk-btn pk-btn--ghost su-task-btn"
							disabled={props.busy}
							onClick={() => props.onApproval(t.id, "deny")}
						>
							Отклонить
						</button>
					</div>
				</div>
			)}
			{!terminal && (
				<div className="su-task-actions">
					{t.status === "paused" ? (
						<button type="button" className="pk-btn pk-btn--ghost su-task-btn" disabled={props.busy} onClick={() => props.onAction(t.id, "resume")}>
							<Play size={14} aria-hidden="true" />
							Продолжить
						</button>
					) : (
						<button type="button" className="pk-btn pk-btn--ghost su-task-btn" disabled={props.busy} onClick={() => props.onAction(t.id, "pause")}>
							<Pause size={14} aria-hidden="true" />
							Пауза
						</button>
					)}
					<button type="button" className="pk-btn pk-btn--ghost su-task-btn su-task-btn--cancel" disabled={props.busy} onClick={() => props.onAction(t.id, "cancel")}>
						Отмена
					</button>
				</div>
			)}
		</div>
	);
}

/** Разбор строк критериев «id | утверждение | команда проверки».
 * Команда необязательна: критерий без неё остаётся заявлением, которое
 * проверить машинно нечем — сервер его так и сохранит. */
function parseCriteria(raw: string): { criteria: { id: string; statement: string; check?: { command: string } }[]; error: string | null } {
	const out: { id: string; statement: string; check?: { command: string } }[] = [];
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		const parts = line.split("|").map(p => p.trim());
		if (parts.length < 2 || parts[0] === "" || parts[1] === "") {
			return { criteria: [], error: `Строка ${i + 1}: нужен вид «id | утверждение | команда»` };
		}
		// Команда может сама содержать «|» (пайпы в shell) — склеиваем хвост.
		const command = parts.slice(2).join(" | ").trim();
		out.push({ id: parts[0], statement: parts[1], ...(command !== "" ? { check: { command } } : {}) });
	}
	if (out.length === 0) return { criteria: [], error: "Нужен хотя бы один критерий приёмки" };
	if (new Set(out.map(c => c.id)).size !== out.length) return { criteria: [], error: "id критериев должны быть уникальны" };
	return { criteria: out, error: null };
}

export function TasksSection(): ReactNode {
	const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [goal, setGoal] = useState("");
	const [cwd, setCwd] = useState("");
	const [criteriaText, setCriteriaText] = useState("");
	const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
	const [reserveTokens, setReserveTokens] = useState(String(DEFAULT_RESERVE_TOKENS));
	const [formError, setFormError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	// Опрос живёт вместе с экраном: задача идёт на сервере, карточка — только
	// витрина подтверждённого. Первый тик сразу, дальше раз в 3 с.
	useEffect(() => {
		let alive = true;
		const tick = async (): Promise<void> => {
			try {
				const next = await fetchTasks();
				if (!alive) return;
				setTasks(next);
				setError(null);
			} catch (err) {
				if (alive) setError(err instanceof Error ? err.message : String(err));
			}
		};
		void tick();
		const timer = window.setInterval(() => void tick(), TASKS_POLL_MS);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, []);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await fetchTasks();
			setTasks(next);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	const onAction = useCallback(
		async (id: string, action: "pause" | "resume" | "cancel"): Promise<void> => {
			if (busyId !== null) return;
			setBusyId(id);
			try {
				await taskAction(id, action);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusyId(null);
			}
		},
		[busyId, refresh],
	);

	const onApproval = useCallback(
		async (id: string, decision: "allow" | "deny"): Promise<void> => {
			if (busyId !== null) return;
			setBusyId(id);
			try {
				await answerTaskApproval(id, decision);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusyId(null);
			}
		},
		[busyId, refresh],
	);

	const submit = useCallback(async (): Promise<void> => {
		if (creating) return;
		const cleanGoal = goal.trim();
		if (cleanGoal === "") {
			setFormError("Цель пустая: опишите, что должно стать истинным");
			return;
		}
		const parsed = parseCriteria(criteriaText);
		if (parsed.error !== null) {
			setFormError(parsed.error);
			return;
		}
		const max = Number(maxTokens);
		const reserve = Number(reserveTokens);
		if (!Number.isInteger(max) || max <= 0) {
			setFormError("Бюджет токенов: положительное целое");
			return;
		}
		if (!Number.isInteger(reserve) || reserve < 0 || reserve >= max) {
			setFormError("Резерв: целое от 0 и меньше бюджета");
			return;
		}
		setCreating(true);
		setFormError(null);
		try {
			await createTask({
				goal: cleanGoal,
				cwd: cwd.trim(),
				criteria: parsed.criteria,
				budget: { maxTokens: max, reserveTokens: reserve },
			});
			setGoal("");
			setCriteriaText("");
			setFormOpen(false);
			await refresh();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}, [creating, goal, cwd, criteriaText, maxTokens, reserveTokens, refresh]);

	const list = tasks ?? [];
	const active = list.filter(t => !TERMINAL[t.status]).length;

	return (
		<div className="su-tasks">
			<div className="su-tasks-head">
				<span className="su-tasks-title">Автономные задачи</span>
				{tasks !== null && <span className="su-tasks-count">{active > 0 ? `в работе ${active}` : `всего ${list.length}`}</span>}
				<button
					type="button"
					className="su-tasks-new"
					onClick={() => setFormOpen(prev => !prev)}
					aria-expanded={formOpen}
				>
					<Plus size={14} aria-hidden="true" />
					Новая
					<ChevronDown size={14} className={formOpen ? "su-chevron--up" : undefined} aria-hidden="true" />
				</button>
			</div>

			{formOpen && (
				<div className="pk-card su-task-form">
					<textarea
						className="pk-input su-task-goal-input"
						placeholder="Цель: что должно стать истинным в проекте"
						rows={2}
						value={goal}
						onChange={e => setGoal(e.target.value)}
					/>
					<input
						className="pk-input"
						placeholder="Рабочий каталог, например /home/user/omp-mobile"
						value={cwd}
						onChange={e => setCwd(e.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
					<textarea
						className="pk-input su-task-criteria"
						placeholder={"Критерии, по строке:\nc1 | сборка зелёная | cd app && bun run build\nc2 | тесты проходят | bun test"}
						rows={3}
						value={criteriaText}
						onChange={e => setCriteriaText(e.target.value)}
					/>
					<div className="su-task-budget-row">
						<label className="su-task-budget">
							<span>Бюджет, токенов</span>
							<input
								className="pk-input"
								inputMode="numeric"
								value={maxTokens}
								onChange={e => setMaxTokens(e.target.value)}
							/>
						</label>
						<label className="su-task-budget">
							<span>Резерв</span>
							<input
								className="pk-input"
								inputMode="numeric"
								value={reserveTokens}
								onChange={e => setReserveTokens(e.target.value)}
							/>
						</label>
					</div>
					{formError !== null && <div className="su-hint su-hint--err">{formError}</div>}
					<button type="button" className="pk-btn su-task-btn" disabled={creating} onClick={() => void submit()}>
						{creating ? "Ставлю…" : "Поставить задачу"}
					</button>
				</div>
			)}

			{error !== null && <div className="su-error">Задачи недоступны: {error}</div>}
			{tasks === null && error === null && <div className="su-loading">Загрузка задач…</div>}
			{tasks !== null && list.length === 0 && (
				<div className="su-none su-tasks-empty">Задач нет — поставьте цель, и штурм доведёт её до проверки.</div>
			)}
			{list.map(t => (
				<TaskCard
					key={t.id}
					task={t}
					busy={busyId === t.id}
					onAction={(id, action) => void onAction(id, action)}
					onApproval={(id, decision) => void onApproval(id, decision)}
				/>
			))}
		</div>
	);
}
