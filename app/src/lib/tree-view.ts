import type { TreeRoot, TreeTask, TreeWorkflow } from "./gateway";

/** Шаг с результатом: файлы в `data/output/` — единственный признак «сделано». */
export function taskDone(task: TreeTask): boolean {
	return task.outputs > 0;
}

/** Порядок шагов: по имени каталога (`01-check` → `02-build`), стабильно. */
export function sortTasks(tasks: readonly TreeTask[]): TreeTask[] {
	return [...tasks].sort((a, b) => a.path.localeCompare(b.path, "ru", { numeric: true }));
}

/** Прогресс процесса по всем шагам, включая подзадачи. */
export function workflowProgress(workflow: TreeWorkflow): { done: number; total: number } {
	const walk = (tasks: readonly TreeTask[]): { done: number; total: number } => {
		let done = 0;
		let total = 0;
		for (const task of tasks) {
			total += 1;
			if (taskDone(task)) done += 1;
			const nested = walk(task.subtasks);
			done += nested.done;
			total += nested.total;
		}
		return { done, total };
	};
	return walk(workflow.tasks);
}

/** Сколько шагов сжато в инструменты (`kind: "tool"`). */
export function collapsedCount(workflow: TreeWorkflow): number {
	let count = 0;
	const walk = (tasks: readonly TreeTask[]): void => {
		for (const task of tasks) {
			if (task.kind === "tool") count += 1;
			walk(task.subtasks);
		}
	};
	walk(workflow.tasks);
	return count;
}

export interface FlatTask {
	task: TreeTask;
	depth: number;
}

/** Плоский список шагов с глубиной вложенности для рендера с отступом. */
export function flattenTasks(tasks: readonly TreeTask[], depth = 0): FlatTask[] {
	const out: FlatTask[] = [];
	for (const task of sortTasks(tasks)) {
		out.push({ task, depth });
		out.push(...flattenTasks(task.subtasks, depth + 1));
	}
	return out;
}

/** Имя шага для отображения: последний сегмент пути. */
export function taskLabel(task: TreeTask): string {
	const parts = task.path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? task.path;
}

/** Сводка по корням: процессы и проблемы линтера, чтобы показать бейдж один раз. */
export function rootsSummary(roots: readonly TreeRoot[]): { workflows: number; problems: string[] } {
	let workflows = 0;
	const problems: string[] = [];
	for (const root of roots) {
		workflows += root.workflows.length;
		problems.push(...root.lint.problems);
	}
	return { workflows, problems };
}
