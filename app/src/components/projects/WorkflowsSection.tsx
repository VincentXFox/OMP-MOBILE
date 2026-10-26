import { useEffect, useState, type ReactNode } from "react";
import { fetchTree, type TreeRoot, type TreeWorkflow } from "../../lib/gateway";
import { collapsedCount, flattenTasks, rootsSummary, taskDone, taskLabel, workflowProgress } from "../../lib/tree-view";

/**
 * Секция «Воркфлоу» на экране «Проекты».
 *
 * Дерево процессов живёт на диске (`~/OMP/workflows`): процесс — папка,
 * шаг — папка с prompts/tools/data, подзадачи — в `subtasks/`. Здесь видно,
 * какие шаги уже оставили результат и в порядке ли структура, без захода в SSH.
 */
export function WorkflowsSection(): ReactNode {
	const [roots, setRoots] = useState<TreeRoot[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openName, setOpenName] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		const controller = new AbortController();
		fetchTree(null, controller.signal)
			.then((data) => {
				if (!alive) return;
				setRoots(data);
				setError(null);
				const first = data.flatMap((root) => root.workflows)[0];
				setOpenName((current) => current ?? first?.path ?? null);
			})
			.catch((err: unknown) => {
				if (!alive) return;
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			alive = false;
			controller.abort();
		};
	}, []);

	if (error !== null) {
		return (
			<section className="wf-section" aria-label="Воркфлоу">
				<div className="wf-head">
					<span className="wf-title">Воркфлоу</span>
				</div>
				<div className="wf-note wf-note--error">Не удалось получить дерево процессов: {error}</div>
			</section>
		);
	}

	if (roots === null) {
		return (
			<section className="wf-section" aria-label="Воркфлоу">
				<div className="wf-head">
					<span className="wf-title">Воркфлоу</span>
				</div>
				<div className="wf-note">Читаю дерево процессов…</div>
			</section>
		);
	}

	const summary = rootsSummary(roots);
	const workflows = roots.flatMap((root) => root.workflows);

	return (
		<section className="wf-section" aria-label="Воркфлоу">
			<div className="wf-head">
				<span className="wf-title">Воркфлоу</span>
				<span className="wf-count">{summary.workflows}</span>
				{summary.problems.length > 0 ? (
					<span className="wf-badge wf-badge--bad" title={summary.problems.join("\n")}>
						{summary.problems.length} проблем
					</span>
				) : (
					<span className="wf-badge wf-badge--ok">структура ок</span>
				)}
			</div>
			{workflows.length === 0 ? (
				<div className="wf-note">
					Процессов нет. Заведи их на мини-ПК: <code>bun bin/agent-tree.ts init</code>, затем <code>new-workflow</code>.
				</div>
			) : (
				<div className="wf-list">
					{workflows.map((workflow) => (
						<WorkflowCard
							key={workflow.path || workflow.name}
							workflow={workflow}
							open={openName === (workflow.path || workflow.name)}
							onToggle={() => setOpenName((current) => (current === (workflow.path || workflow.name) ? null : workflow.path || workflow.name))}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function WorkflowCard(props: { workflow: TreeWorkflow; open: boolean; onToggle: () => void }): ReactNode {
	const { workflow, open, onToggle } = props;
	const progress = workflowProgress(workflow);
	const collapsed = collapsedCount(workflow);
	const flat = flattenTasks(workflow.tasks);
	return (
		<div className={`wf-card${open ? " wf-card--open" : ""}`}>
			<button type="button" className="wf-card-head" aria-expanded={open} onClick={onToggle}>
				<span className={`wf-dot${progress.done === progress.total && progress.total > 0 ? " wf-dot--ok" : ""}`} aria-hidden="true" />
				<span className="wf-name">{workflow.name}</span>
				<span className="wf-progress">
					{progress.done}/{progress.total}
				</span>
			</button>
			{workflow.goal !== "" && (
				<div className="wf-goal" title={workflow.goal}>
					{workflow.goal}
				</div>
			)}
			{open && (
				<div className="wf-steps">
					{flat.map(({ task, depth }) => (
						<div key={task.path} className="wf-step" style={{ paddingLeft: `${depth * 14}px` }}>
							<span className={`wf-step-dot${taskDone(task) ? " wf-step-dot--done" : ""}`} aria-label={taskDone(task) ? "есть результат" : "результата нет"} />
							<span className="wf-step-name" title={task.path}>
								{taskLabel(task)}
							</span>
							{task.kind === "tool" && <span className="wf-chip">tool</span>}
							{task.subtasks.length > 0 && <span className="wf-chip wf-chip--muted">sub {task.subtasks.length}</span>}
							<span className="wf-step-meta">
								tools:{task.tools.length} · in:{task.inputs} out:{task.outputs}
							</span>
						</div>
					))}
					{collapsed > 0 && <div className="wf-note">сжато в инструменты: {collapsed}</div>}
				</div>
			)}
		</div>
	);
}
