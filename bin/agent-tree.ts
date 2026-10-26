#!/usr/bin/env bun
/**
 * agent-tree — файловое дерево агентских процессов (Workflow → Task → Subtask).
 *
 * Идея из «agent architecture as folders»: логика агента — это каталоги и
 * текстовые файлы, а не код фреймворка. Каждая задача делится на три папки:
 *   prompts/ — что делать (instructions.md читается только при входе в задачу)
 *   tools/   — чем делать (детерминированные скрипты, не «магия модели»)
 *   data/    — на чём делать (input/ → output/, схема результата в schema.json)
 * Субагенты получают папку подзадачи и работают в изоляции; новая задача
 * создаётся копией `_template_task/`, поэтому дерево расширяется без кода.
 *
 * Правила адаптации из доклада (§5) реализованы командами:
 *   collapse-task <wf>/<task>   — задача сжалась до инструмента (Task → Tool)
 *   demote-workflow <wf> <wf>/<task> — процесс стал подзадачей (Workflow → Subtask)
 *
 * Запуск: bun bin/agent-tree.ts <команда> [аргументы]
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { countTasks, lintAgentTree, scanAgentTree, type TaskStatus } from "../gateway/agent-tree.ts";

const DEFAULT_ROOT = join(homedir(), "OMP", "workflows");

const ROUTER_MD = `# Роутер файлового дерева агентов

Вся логика агентских процессов лежит в каталогах, а не в коде: процесс — папка,
шаг — папка, инструкция — файл. Модель и инструменты — сменные.

## Как ходить по дереву

1. **Процесс.** Каждый рабочий процесс — \`<workflow>/WORKFLOW.md\`: цель, маршрут,
   условия перехода между шагами. Перед началом читай его целиком.
2. **Задача.** \`<workflow>/<task>/\` делится строго на три части:
   - \`prompts/instructions.md\` — что делать (читается при входе в задачу);
   - \`tools/\` — чем делать: детерминированные скрипты этой задачи;
   - \`data/input/\` → \`data/output/\` — входы и результат, \`data/schema.json\` — форма результата.
3. **Подзадачи.** \`<task>/subtasks/<sub>/\` — независимые ветки. Каждую отдавай
   отдельному субагенту с путём только к его папке; агрегируй результаты в
   \`data/output/\` родительской задачи.
4. **Расширение.** Не хватает шага — копируй \`_template_task/\`, впиши
   \`prompts/instructions.md\` и выполни. Не меняй чужие папки «по месту».
5. **Сжатие.** Провайдер дал нативную фичу — не пиши фреймворк: \`collapse-task\`
   превращает шаг в инструмент, \`demote-workflow\` — процесс в подзадачу.

## Правила

- Результат шага — файл в \`data/output/\`; «сделано» без файла не считается.
- В \`tools/\` — только детерминированный код: повторный запуск даёт тот же результат.
- Внешние данные — через MCP (\`.mcp.json\`) или инструменты задачи; входы кладём в \`data/input/\`.
- Проверка структуры: \`bun ~/omp-mobile/bin/agent-tree.ts lint\`.
`;

const MCP_JSON = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

const TEMPLATE_INSTRUCTIONS = `# Задача: <название>

## Контекст
Опиши, где ты находишься в процессе и что уже готово (какие файлы есть в \`data/input/\`).

## Алгоритм
1. Прочитай входы из \`data/input/\`.
2. Сделай работу инструментами из \`tools/\` (или напрямую, если шаг — рассуждение).
3. Сохрани результат в \`data/output/\` по форме из \`data/schema.json\`.
4. Проверь результат: непустой файл, поля схемы на месте.

## Готово когда
- \`data/output/<файл>\` существует и соответствует схеме;
- в отчёте указано, чем проверено.
`;

const TEMPLATE_SCHEMA = `${JSON.stringify({ type: "object", required: ["status"], properties: { status: { type: "string" }, summary: { type: "string" } } }, null, 2)}\n`;

function die(message: string): never {
	console.error(`agent-tree: ${message}`);
	process.exit(1);
}

function parseFlags(argv: readonly string[]): { args: string[]; flags: Record<string, string> } {
	const args: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const item = argv[i] ?? "";
		if (item.startsWith("--")) {
			const key = item.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = "true";
			}
		} else {
			args.push(item);
		}
	}
	return { args, flags };
}

function rootOf(flags: Record<string, string>): string {
	return resolve(flags["root"] ?? DEFAULT_ROOT);
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 60);
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function writeIfAbsent(path: string, content: string, mode?: number): boolean {
	if (existsSync(path)) return false;
	ensureDir(dirname(path));
	writeFileSync(path, content, "utf8");
	if (mode !== undefined) chmodSync(path, mode);
	return true;
}

function title(text: string): string {
	const trimmed = text.trim();
	return trimmed.length === 0 ? "" : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

// ───────────────────────────────────────────────────────────────────────────
// init / new-*
// ───────────────────────────────────────────────────────────────────────────

function cmdInit(root: string): void {
	ensureDir(root);
	writeIfAbsent(join(root, "AGENTS.md"), ROUTER_MD);
	writeIfAbsent(join(root, ".mcp.json"), MCP_JSON);
	const template = join(root, "_template_task");
	for (const dir of ["prompts", "tools", "data/input", "data/output"]) ensureDir(join(template, dir));
	writeIfAbsent(join(template, "prompts", "instructions.md"), TEMPLATE_INSTRUCTIONS);
	writeIfAbsent(join(template, "data", "schema.json"), TEMPLATE_SCHEMA);
	writeIfAbsent(join(template, "task.json"), `${JSON.stringify({ kind: "task", template: true }, null, 2)}\n`);
	console.log(`agent-tree: дерево готово в ${root}`);
	console.log("  AGENTS.md — роутер, .mcp.json — внешние источники, _template_task — заготовка шага");
}

function workflowMd(name: string, goal: string): string {
	return `# Процесс: ${name}

## Цель
${goal.length > 0 ? goal : "опиши, зачем этот процесс и какой артефакт он даёт"}

## Маршрут
1. **\`./01-<шаг>/\`** — что делает шаг.
   - Условие перехода: файл \`./01-<шаг>/data/output/<файл>\` существует и валиден.
2. **\`./02-<шаг>/\`** — следующий шаг (вход — выход предыдущего).
3. **\`./03-subtasks/\`** — ветки, которые отдаются субагентам параллельно:
   - вход: ссылка на выход предыдущего шага;
   - агрегация: результаты подзадач складываются в \`data/output/\` родителя.

## Готово когда
- все шаги оставили файлы в своих \`data/output/\`;
- итоговый артефакт процесса описан в \`data/output/\` последнего шага.
`;
}

function cmdNewWorkflow(root: string, name: string, goal: string): void {
	const dir = join(root, slug(name));
	if (existsSync(dir)) die(`процесс уже есть: ${dir}`);
	ensureDir(dir);
	writeFileSync(join(dir, "WORKFLOW.md"), workflowMd(name, goal), "utf8");
	const template = join(root, "_template_task");
	if (existsSync(template)) {
		// Шаблон шага копируется внутрь процесса, чтобы новая задача была в одну команду.
		copyDir(template, join(dir, "_template_task"));
	}
	console.log(`процесс создан: ${dir}`);
	console.log(`  следующий шаг: bun bin/agent-tree.ts new-task ${slug(name)} 01-<шаг> --prompt "…"`);
}

function copyDir(from: string, to: string): void {
	ensureDir(to);
	for (const entry of readdirSync(from)) {
		const src = join(from, entry);
		const dst = join(to, entry);
		if (statSync(src).isDirectory()) copyDir(src, dst);
		else writeFileSync(dst, readFileSync(src));
	}
}

function taskDirs(base: string, prompt: string, taskTitle: string): void {
	for (const dir of ["prompts", "tools", "data/input", "data/output"]) ensureDir(join(base, dir));
	const body = `# Задача: ${taskTitle || basename(base)}\n\n${prompt.trim()}\n`;
	writeIfAbsent(join(base, "prompts", "instructions.md"), body);
	writeIfAbsent(join(base, "data", "schema.json"), TEMPLATE_SCHEMA);
	writeIfAbsent(join(base, "task.json"), `${JSON.stringify({ kind: "task", title: taskTitle }, null, 2)}\n`);
	writeIfAbsent(join(base, ".gitkeep"), "");
}

function cmdNewTask(root: string, workflow: string, name: string, prompt: string, subtasks: readonly string[]): void {
	const wfDir = join(root, workflow);
	if (!existsSync(join(wfDir, "WORKFLOW.md"))) die(`нет процесса ${workflow} (ожидался ${join(wfDir, "WORKFLOW.md")})`);
	const dir = join(wfDir, slug(name));
	if (existsSync(dir)) die(`задача уже есть: ${dir}`);
	taskDirs(dir, prompt, name);
	console.log(`задача создана: ${dir}`);
	for (const sub of subtasks) {
		if (sub.trim() === "") continue;
		cmdNewSubtask(dir, sub, "");
	}
}

function cmdNewSubtask(root: string, workflow: string, task: string, name: string, prompt: string): void {
	const taskDir = join(root, workflow, task);
	if (!existsSync(taskDir)) die(`нет задачи ${join(taskDir)}`);
	cmdNewSubtask(taskDir, name, prompt);
}

function cmdNewSubtaskFromTask(taskDir: string, name: string, prompt: string): void {
	const dir = join(taskDir, "subtasks", slug(name));
	if (existsSync(dir)) die(`подзадача уже есть: ${dir}`);
	taskDirs(dir, prompt, name);
	console.log(`подзадача создана: ${dir}`);
}

function cmdNewSubtask(taskDir: string, name: string, prompt: string): void {
	cmdNewSubtaskFromTask(taskDir, name, prompt);
}

/** Печать дерева: шаги с результатом помечены •, без результата — ○. */
function cmdList(root: string, json: boolean): void {
	const workflows = scanAgentTree(root);
	if (json) {
		console.log(JSON.stringify({ root, workflows }, null, 2));
		return;
	}
	if (workflows.length === 0) {
		console.log(`agent-tree: в ${root} нет процессов`);
		return;
	}
	for (const wf of workflows) {
		const counters = countTasks(wf.tasks);
		const extra = [
			counters.subtasks > 0 ? `подзадач: ${counters.subtasks}` : "",
			counters.tools > 0 ? `сжато в инструменты: ${counters.tools}` : "",
		].filter(Boolean);
		console.log(`${wf.hasWorkflowMd ? "✔" : "✘"} ${wf.name}  ${counters.done}/${counters.total} шагов с результатом${extra.length > 0 ? `, ${extra.join(", ")}` : ""}`);
		if (wf.goal !== "") console.log(`    ${wf.goal}`);
		const printTask = (task: TaskStatus, indent: string): void => {
			const badge = task.kind === "tool" ? " [tool]" : task.kind === "template" ? " [template]" : "";
			console.log(`${indent}${task.outputs > 0 ? "•" : "○"} ${basename(task.path)}${badge}  tools:${task.tools.length} in:${task.inputs} out:${task.outputs}${task.subtasks.length > 0 ? ` sub:${task.subtasks.length}` : ""}`);
			for (const sub of task.subtasks) printTask(sub, `${indent}    `);
		};
		for (const task of wf.tasks) printTask(task, "    ");
	}
}

// ───────────────────────────────────────────────────────────────────────────
// §5 доклада: сжатие структуры при обновлениях провайдеров
// ───────────────────────────────────────────────────────────────────────────

function cmdCollapseTask(root: string, spec: string, note: string): void {
	const [workflow, task] = spec.split("/");
	if (workflow === undefined || task === undefined) die("нужно <процесс>/<задача>");
	const dir = join(root, workflow, task);
	if (!existsSync(dir)) die(`нет задачи ${dir}`);
	let meta: Record<string, unknown> = {};
	try {
		meta = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
	} catch {
		/* без meta создадим */
	}
	meta["kind"] = "tool";
	meta["collapsedAt"] = new Date().toISOString();
	if (note.length > 0) meta["note"] = note;
	writeFileSync(join(dir, "task.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

	const subtasksDir = join(dir, "subtasks");
	if (existsSync(subtasksDir) && readdirSync(subtasksDir).length > 0) {
		const archive = join(dir, "_subtasks-archived");
		ensureDir(archive);
		for (const entry of readdirSync(subtasksDir)) renameSync(join(subtasksDir, entry), join(archive, entry));
	}
	const instructions = join(dir, "prompts", "instructions.md");
	const current = existsSync(instructions) ? readFileSync(instructions, "utf8") : "";
	writeFileSync(
		instructions,
		`${current.trimEnd()}\n\n## Сжато в инструмент\n${note.length > 0 ? note : "Шаг заменён одной нативной возможностью провайдера."}\n` +
			`Задача помечена \`kind: tool\`: промпт и данные остались для истории, но исполнение — один вызов из \`tools/\`.\nПравила навигации не меняются: результат по-прежнему кладётся в \`data/output/\`.\n`,
		"utf8",
	);
	console.log(`задача сжата в инструмент: ${dir} (kind: tool)`);
}

function cmdDemoteWorkflow(root: string, workflow: string, target: string): void {
	const [targetWorkflow, targetTask] = target.split("/");
	if (targetWorkflow === undefined || targetTask === undefined) die("нужно <процесс-получатель>/<задача>");
	const from = join(root, workflow);
	const to = join(root, targetWorkflow, targetTask, "subtasks", workflow);
	if (!existsSync(from)) die(`нет процесса ${from}`);
	if (existsSync(to)) die(`цель уже существует: ${to}`);
	ensureDir(dirname(to));
	renameSync(from, to);
	console.log(`процесс ${workflow} стал подзадачей: ${to}`);
	console.log("  обнови WORKFLOW.md получателя: подзадача запускается отдельным субагентом со своей папкой.");
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function main(argv: readonly string[]): void {
	const { args, flags } = parseFlags(argv);
	const root = rootOf(flags);
	const command = args[0] ?? "help";
	switch (command) {
		case "init":
			return cmdInit(root);
		case "new-workflow": {
			const name = args[1];
			if (name === undefined) die("нужно имя процесса");
			return cmdNewWorkflow(root, name, flags["goal"] ?? "");
		}
		case "new-task": {
			const workflow = args[1];
			const name = args[2];
			if (workflow === undefined || name === undefined) die("нужно <процесс> <имя-шага>");
			const subtasks = (flags["subtasks"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			return cmdNewTask(root, workflow, name, flags["prompt"] ?? "", subtasks);
		}
		case "new-subtask": {
			const spec = args[1];
			const name = args[2];
			if (spec === undefined || name === undefined) die("нужно <процесс>/<задача> <имя-подзадачи>");
			const [workflow, task] = spec.split("/");
			if (workflow === undefined || task === undefined) die("нужно <процесс>/<задача>");
			return cmdNewSubtask(root, workflow, task, name, flags["prompt"] ?? "");
		}
		case "list":
			return cmdList(root, flags["json"] === "true");
		case "lint": {
			const result = lintAgentTree(root);
			if (flags["json"] === "true") {
				console.log(JSON.stringify(result, null, 2));
			} else if (result.ok) {
				console.log(`agent-tree: структура в порядке (${result.workflows} процессов, ${result.tasks} шагов)`);
			} else {
				for (const problem of result.problems) console.log(`✘ ${problem}`);
				console.log(`agent-tree: ${result.problems.length} проблем`);
			}
			if (!result.ok) process.exit(1);
			return;
		}
		case "collapse-task": {
			const spec = args[1];
			if (spec === undefined) die("нужно <процесс>/<задача>");
			return cmdCollapseTask(root, spec, flags["note"] ?? "");
		}
		case "demote-workflow": {
			const workflow = args[1];
			const target = args[2];
			if (workflow === undefined || target === undefined) die("нужно <процесс> <процесс-получатель>/<задача>");
			return cmdDemoteWorkflow(root, workflow, target);
		}
		default:
			console.log(`agent-tree — дерево агентских процессов

  init [--root DIR]
  new-workflow <имя> --goal "текст"
  new-task <процесс> <шаг> [--prompt "текст"] [--subtasks a,b]
  new-subtask <процесс>/<задача> <имя> [--prompt "текст"]
  list [--json] [--root DIR]
  lint [--json] [--root DIR]
  collapse-task <процесс>/<задача> [--note "причина"]
  demote-workflow <процесс> <получатель>/<задача>

Дерево по умолчанию: ${DEFAULT_ROOT}`);
	}
}

main(process.argv.slice(2));
