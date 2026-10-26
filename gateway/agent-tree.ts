/**
 * Сканер и линтер файлового дерева агентских процессов (Workflow → Task → Subtask).
 *
 * Те же правила, что у CLI `bin/agent-tree.ts`: процесс — папка с WORKFLOW.md,
 * шаг — папка с prompts/, tools/, data/{input,output}; подзадачи — в subtasks/;
 * шаблон шага — `_template_task/`. Модуль нужен шлюзу, чтобы PWA показывала
 * процессы и их готовность, и CLI, чтобы не дублировать разбор.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Корни, которые смотрим: домашние процессы плюс всё из OMP_TREE_ROOTS. */
export function defaultTreeRoots(): string[] {
	const roots = [join(homedir(), "OMP", "workflows")];
	const extra = process.env["OMP_TREE_ROOTS"];
	if (extra !== undefined && extra !== "") {
		for (const part of extra.split(":")) {
			if (part.trim() !== "") roots.push(part.trim());
		}
	}
	return roots;
}

// ───────────────────────────────────────────────────────────────────────────
// Обход дерева
// ───────────────────────────────────────────────────────────────────────────

interface TaskStatus {
	path: string;
	kind: "task" | "tool" | "template";
	hasPrompt: boolean;
	tools: string[];
	inputs: number;
	outputs: number;
	hasSchema: boolean;
	subtasks: TaskStatus[];
}

function countFiles(dir: string): number {
	try {
		return readdirSync(dir).filter((f) => !f.startsWith(".")).length;
	} catch {
		return 0;
	}
}

function taskKind(dir: string): TaskStatus["kind"] {
	if (basename(dir).startsWith("_template")) return "template";
	try {
		const meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as { kind?: unknown };
		if (meta.kind === "tool") return "tool";
	} catch {
		/* нет meta — обычная задача */
	}
	return "task";
}

function scanTask(dir: string): TaskStatus {
	const toolsDir = join(dir, "tools");
	const tools = existsSync(toolsDir) ? readdirSync(toolsDir).filter((f) => !f.startsWith(".")) : [];
	const subtasksDir = join(dir, "subtasks");
	const subtasks = existsSync(subtasksDir)
		? readdirSync(subtasksDir)
				.filter((f) => statSync(join(subtasksDir, f)).isDirectory())
				.map((f) => scanTask(join(subtasksDir, f)))
		: [];
	return {
		path: dir,
		kind: taskKind(dir),
		hasPrompt: existsSync(join(dir, "prompts", "instructions.md")),
		tools,
		inputs: countFiles(join(dir, "data", "input")),
		outputs: countFiles(join(dir, "data", "output")),
		hasSchema: existsSync(join(dir, "data", "schema.json")),
		subtasks,
	};
}

interface WorkflowStatus {
	name: string;
	path: string;
	hasWorkflowMd: boolean;
	goal: string;
	tasks: TaskStatus[];
}

function workflowGoal(path: string): string {
	try {
		const text = readFileSync(join(path, "WORKFLOW.md"), "utf8");
		const match = /##\s*Цель\s*\n+([^\n#]+)/u.exec(text);
		return match?.[1]?.trim() ?? "";
	} catch {
		return "";
	}
}

export function scanAgentTree(root: string): WorkflowStatus[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => !entry.startsWith(".") && entry !== "_template_task" && entry !== "AGENTS.md")
		.filter((entry) => {
			try {
				return statSync(join(root, entry)).isDirectory();
			} catch {
				return false;
			}
		})
		.map((entry) => {
			const path = join(root, entry);
			const tasks = readdirSync(path)
				.filter((name) => {
					try {
						return statSync(join(path, name)).isDirectory() && !name.startsWith(".");
					} catch {
						return false;
					}
				})
				.filter((name) => name !== "_template_task")
				.map((name) => scanTask(join(path, name)));
			return { name: entry, path, hasWorkflowMd: existsSync(join(path, "WORKFLOW.md")), goal: workflowGoal(path), tasks };
		});
}

export function countTasks(tasks: readonly TaskStatus[]): { total: number; done: number; subtasks: number; tools: number } {
	let total = 0;
	let done = 0;
	let subtasks = 0;
	let tools = 0;
	for (const task of tasks) {
		if (task.kind === "template") continue;
		total += 1;
		if (task.outputs > 0) done += 1;
		if (task.kind === "tool") tools += 1;
		const nested = countTasks(task.subtasks);
		subtasks += nested.subtasks + task.subtasks.length;
		total += nested.total;
		done += nested.done;
	}
	return { total, done, subtasks, tools };
}

export function lintAgentTree(root: string): { ok: boolean; problems: string[]; workflows: number; tasks: number } {
	const problems: string[] = [];
	const workflows = scanAgentTree(root);
	if (!existsSync(join(root, "AGENTS.md"))) problems.push(`${root}: нет AGENTS.md (роутер дерева)`);
	if (workflows.length === 0) problems.push(`${root}: нет ни одного процесса`);
	const lintTask = (task: TaskStatus, label: string): void => {
		if (task.kind === "tool") {
			if (!task.hasPrompt) problems.push(`${label}: сжатый инструмент без prompts/instructions.md`);
		} else {
			if (!task.hasPrompt) problems.push(`${label}: нет prompts/instructions.md`);
			// Шаг без инструментов допустим, если это шаг-рассуждение с явным
			// критерием готовности: иначе агент не поймёт, что работа закончена.
			const reasoningStep = task.hasPrompt && readFileSync(join(task.path, "prompts", "instructions.md"), "utf8").length >= 400;
			if (task.tools.length === 0 && task.subtasks.length === 0 && !reasoningStep) {
				problems.push(`${label}: пустые tools/ и нет subtasks/ (или опиши шаг подробнее: 400+ символов)`);
			}
		}
		if (!existsSync(join(task.path, "data", "input"))) problems.push(`${label}: нет data/input`);
		if (!existsSync(join(task.path, "data", "output"))) problems.push(`${label}: нет data/output`);
		if (task.hasSchema) {
			try {
				JSON.parse(readFileSync(join(task.path, "data", "schema.json"), "utf8"));
			} catch {
				problems.push(`${label}: data/schema.json — невалидный JSON`);
			}
		}
		for (const sub of task.subtasks) lintTask(sub, `${label}/${basename(sub.path)}`);
	};
	for (const wf of workflows) {
		if (!wf.hasWorkflowMd) problems.push(`${wf.path}: нет WORKFLOW.md`);
		else {
			const text = readFileSync(join(wf.path, "WORKFLOW.md"), "utf8");
			if (!/##\s*Цель/u.test(text)) problems.push(`${wf.path}: в WORKFLOW.md нет раздела «Цель»`);
			if (!/##\s*Маршрут/u.test(text)) problems.push(`${wf.path}: в WORKFLOW.md нет раздела «Маршрут»`);
		}
		if (!existsSync(join(wf.path, "_template_task"))) problems.push(`${wf.path}: нет _template_task (нечем расширять процесс)`);
		for (const task of wf.tasks) lintTask(task, `${wf.name}/${basename(task.path)}`);
	}
	return { ok: problems.length === 0, problems, workflows: workflows.length, tasks: countTasks(workflows.flatMap((w) => w.tasks)).total };
}

