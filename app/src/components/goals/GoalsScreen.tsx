import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Play, Plus, RefreshCw, Target, X } from "lucide-react";
import { api, type GoalView } from "../../lib/gateway";
import "../shell/pocket.css";
import "./goals.css";

type GoalState = GoalView;

const PHASE_LABEL: Record<GoalState["phase"], string> = {
	PLAN: "план",
	EXECUTE: "работает",
	RECOVER: "меняет стратегию",
	VERIFY: "проверка",
	RESULT: "готово",
	BLOCKED: "блокер",
};

function phaseClass(phase: GoalState["phase"]): string {
	if (phase === "RESULT") return "go-badge go-badge--ok";
	if (phase === "BLOCKED") return "go-badge go-badge--bad";
	if (phase === "RECOVER") return "go-badge go-badge--warn";
	return "go-badge";
}

function progress(goal: GoalState): number {
	const done = goal.steps.filter(step => step.status === "done").length;
	return goal.steps.length === 0 ? 0 : Math.round((done / goal.steps.length) * 100);
}

function ago(iso: string): string {
	const diff = Date.now() - Date.parse(iso);
	if (!Number.isFinite(diff)) return "";
	const minutes = Math.round(diff / 60000);
	if (minutes < 1) return "сейчас";
	if (minutes < 60) return `${minutes} мин назад`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} ч назад`;
	return `${Math.round(hours / 24)} дн назад`;
}

export function GoalsScreen(): ReactNode {
	const [goals, setGoals] = useState<GoalState[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [goalText, setGoalText] = useState("");
	const [criteriaText, setCriteriaText] = useState("");
	const [stepsText, setStepsText] = useState("");
	const [project, setProject] = useState("");
	const [busy, setBusy] = useState(false);
	const [report, setReport] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const data = await api.getGoals();
			setGoals(data.goals);
			setError(null);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		}
	}, []);

	useEffect(() => {
		void load();
		// Живой режим: состояние цели читается с контроллера, а не из кэша UI.
		const timer = setInterval(() => void load(), 2000);
		return () => clearInterval(timer);
	}, [load]);

	const active = useMemo(() => goals?.find(item => item.slug === selected) ?? null, [goals, selected]);

	const create = useCallback(async () => {
		if (goalText.trim().length < 3) {
			setError("Опиши цель хотя бы тремя символами");
			return;
		}
		setBusy(true);
		try {
			await api.createGoal({
				goal: goalText.trim(),
				criteria: criteriaText.split("\n").map(line => line.trim()).filter(Boolean),
				steps: stepsText.split("\n").map(line => line.trim()).filter(Boolean),
				project: project.trim() || undefined,
			});
			setCreating(false);
			setGoalText("");
			setCriteriaText("");
			setStepsText("");
			await load();
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		} finally {
			setBusy(false);
		}
	}, [goalText, criteriaText, stepsText, project, load]);

	const drive = useCallback(
		async (slug: string) => {
			setBusy(true);
			try {
				await api.driveGoal(slug);
				await load();
			} catch (err) {
				setError(String(err instanceof Error ? err.message : err));
			} finally {
				setBusy(false);
			}
		},
		[load],
	);

	const showReport = useCallback(async (slug: string) => {
		try {
			const data = await api.goalReport(slug);
			setReport(data.text);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		}
	}, []);

	return (
		<div className="go">
			<div className="go-head">
				<div className="go-title">
					<Target size={18} aria-hidden="true" />
					<span>Цели</span>
					{goals !== null && <span className="go-count">{goals.length}</span>}
				</div>
				<div className="go-actions">
					<button type="button" className="go-icon" onClick={() => void load()} aria-label="Обновить">
						<RefreshCw size={16} />
					</button>
					<button type="button" className="go-primary" onClick={() => setCreating(true)}>
						<Plus size={16} />
						Цель
					</button>
				</div>
			</div>

			{error && (
				<div className="go-error" role="alert">
					{error}
					<button type="button" onClick={() => setError(null)} aria-label="Скрыть">
						<X size={14} />
					</button>
				</div>
			)}

			{creating && (
				<div className="go-form">
					<label className="go-label">
						Цель
						<textarea
							value={goalText}
							onChange={event => setGoalText(event.target.value)}
							placeholder="Например: починить сборку OMP Mobile и доказать тестами"
							rows={2}
						/>
					</label>
					<label className="go-label">
						Критерии (по одному на строку)
						<textarea
							value={criteriaText}
							onChange={event => setCriteriaText(event.target.value)}
							placeholder="AC-01: тесты зелёные"
							rows={2}
						/>
					</label>
					<label className="go-label">
						Шаги (по одному на строку, можно оставить пустым)
						<textarea
							value={stepsText}
							onChange={event => setStepsText(event.target.value)}
							placeholder="воспроизвести&#10;починить&#10;проверить"
							rows={3}
						/>
					</label>
					<label className="go-label">
						Проект (каталог, где идут проверки)
						<input value={project} onChange={event => setProject(event.target.value)} placeholder="/home/vincentfox/OMP/omp" />
					</label>
					<div className="go-form-actions">
						<button type="button" className="go-ghost" onClick={() => setCreating(false)}>
							Отмена
						</button>
						<button type="button" className="go-primary" disabled={busy} onClick={() => void create()}>
							{busy ? "Создаю…" : "Создать"}
						</button>
					</div>
				</div>
			)}

			{goals === null && <div className="go-empty">Загружаю цели…</div>}
			{goals !== null && goals.length === 0 && !creating && (
				<div className="go-empty">
					Пока ни одной цели. Опиши, чего нужно добиться — агент пойдёт к результату сам и вернётся с доказательствами
					или с конкретным препятствием.
				</div>
			)}

			<div className="go-list">
				{(goals ?? []).map(goal => (
					<button
						type="button"
						key={goal.slug}
						className={`go-card${selected === goal.slug ? " go-card--on" : ""}`}
						onClick={() => {
							setSelected(selected === goal.slug ? null : goal.slug);
							setReport(null);
						}}
					>
						<div className="go-card-top">
							<span className={phaseClass(goal.phase)}>{PHASE_LABEL[goal.phase] ?? goal.phase}</span>
							<span className="go-when">{ago(goal.updatedAt)}</span>
						</div>
						<div className="go-goal">{goal.goal}</div>
						<div className="go-bar" aria-hidden="true">
							<span style={{ width: `${progress(goal)}%` }} />
						</div>
						<div className="go-meta">
							шаг {Math.min(goal.current + 1, goal.steps.length)}/{goal.steps.length} · {progress(goal)}%
							{goal.residuals.length > 0 ? ` · рисков: ${goal.residuals.length}` : ""}
						</div>
					</button>
				))}
			</div>

			{active && (
				<section className="go-detail">
					<div className="go-detail-head">
						<h3>{active.goal}</h3>
						<span className={phaseClass(active.phase)}>{PHASE_LABEL[active.phase] ?? active.phase}</span>
					</div>
					{active.result && (
						<div className={`go-result${active.result.status === "ГОТОВО" ? " go-result--ok" : " go-result--bad"}`}>
							{active.result.status}: {active.result.detail}
						</div>
					)}
					<div className="go-detail-actions">
						<button
							type="button"
							className="go-primary"
							disabled={busy || active.phase === "RESULT" || active.phase === "BLOCKED"}
							onClick={() => void drive(active.slug)}
						>
							<Play size={15} />
							Запустить автономно
						</button>
						<button type="button" className="go-ghost" onClick={() => void showReport(active.slug)}>
							Отчёт
						</button>
					</div>

					<h4 className="go-sub">План</h4>
					<ol className="go-steps">
						{active.steps.map((step, index) => (
							<li key={`${step.name}-${index}`} className={`go-step go-step--${step.status}`}>
								<span className="go-step-name">{step.name}</span>
								<span className="go-step-state">
									{step.status === "done" ? "выполнен" : step.status === "failed" ? `провал ×${step.attempts}` : "ждёт"}
								</span>
								{step.evidence.length > 0 && (
									<ul className="go-evidence">
										{step.evidence.slice(-3).map((line, i) => (
											<li key={i}>{line}</li>
										))}
									</ul>
								)}
							</li>
						))}
					</ol>

					{active.residuals.length > 0 && (
						<>
							<h4 className="go-sub">RESIDUAL</h4>
							<ul className="go-residual">
								{active.residuals.map((item, index) => (
									<li key={index}>
										<strong>{item.text}</strong>
										<span>причина: {item.reason}</span>
										<span>влияние: {item.impact}</span>
										<span>снимается: {item.exitCondition}</span>
									</li>
								))}
							</ul>
						</>
					)}

					<h4 className="go-sub">История</h4>
					<ul className="go-log">
						{active.log.slice(-12).reverse().map((entry, index) => (
							<li key={index}>
								<span className="go-log-time">{entry.at.slice(11, 16)}</span>
								<span className="go-log-event">{entry.event}</span>
								<span className="go-log-detail">{entry.detail}</span>
							</li>
						))}
					</ul>

					{report && (
						<>
							<h4 className="go-sub">Отчёт</h4>
							<pre className="go-report">{report}</pre>
						</>
					)}
				</section>
			)}
		</div>
	);
}
