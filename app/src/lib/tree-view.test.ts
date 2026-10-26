import { expect, test } from "bun:test";
import { collapsedCount, flattenTasks, rootsSummary, sortTasks, taskDone, taskLabel, workflowProgress } from "./tree-view";
import type { TreeRoot, TreeTask, TreeWorkflow } from "./gateway";

function task(patch: Partial<TreeTask>): TreeTask {
	const base: TreeTask = {
		path: "/w/01-check",
		kind: "task",
		hasPrompt: true,
		tools: ["check.ts"],
		inputs: 0,
		outputs: 0,
		hasSchema: true,
		subtasks: [],
	};
	return { ...base, ...patch };
}

function workflow(tasks: TreeTask[]): TreeWorkflow {
	return { name: "release", path: "/w", hasWorkflowMd: true, goal: "цель", tasks };
}

test("шаг с результатом — только при файлах в data/output", () => {
	expect(taskDone(task({ outputs: 0 }))).toBe(false);
	expect(taskDone(task({ outputs: 2 }))).toBe(true);
});

test("шаги сортируются по имени каталога, а не по порядку ответа API", () => {
	const sorted = sortTasks([task({ path: "/w/03-verify" }), task({ path: "/w/01-check" }), task({ path: "/w/02-build" })]);
	expect(sorted.map((t) => taskLabel(t))).toEqual(["01-check", "02-build", "03-verify"]);
});

test("прогресс считает подзадачи и не врёт про общий счёт", () => {
	const wf = workflow([
		task({ path: "/w/01-check", outputs: 1, subtasks: [task({ path: "/w/01-check/subtasks/api", outputs: 1 }), task({ path: "/w/01-check/subtasks/ui", outputs: 0 })] }),
		task({ path: "/w/02-build", outputs: 0 }),
	]);
	expect(workflowProgress(wf)).toEqual({ done: 2, total: 4 });
});

test("сжатые в инструменты шаги считаются отдельно", () => {
	const wf = workflow([task({ path: "/w/01-check", kind: "tool" }), task({ path: "/w/02-build" })]);
	expect(collapsedCount(wf)).toBe(1);
});

test("плоский список даёт глубину для отступа", () => {
	const flat = flattenTasks([task({ path: "/w/02-build" }), task({ path: "/w/01-check", subtasks: [task({ path: "/w/01-check/subtasks/api" })] })]);
	expect(flat.map((f) => `${f.depth}:${taskLabel(f.task)}`)).toEqual(["0:01-check", "1:api", "0:02-build"]);
});

test("сводка по корням собирает проблемы линтера", () => {
	const roots: TreeRoot[] = [
		{ path: "/a", workflows: [workflow([])], lint: { ok: false, problems: ["нет WORKFLOW.md"], workflows: 1, tasks: 0 } },
		{ path: "/b", workflows: [workflow([]), workflow([])], lint: { ok: true, problems: [], workflows: 2, tasks: 0 } },
	];
	expect(rootsSummary(roots)).toEqual({ workflows: 3, problems: ["нет WORKFLOW.md"] });
});
