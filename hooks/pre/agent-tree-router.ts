/**
 * GRANDMASTER · роутер файлового дерева агентских процессов.
 *
 * Идея: процесс — папка, шаг — папка, инструкция — файл. Агент не должен
 * читать весь проект, чтобы понять, где он: роутер поднимается от cwd вверх,
 * находит процесс (`WORKFLOW.md`) и задачу (`task.json` / `prompts/instructions.md`)
 * и подставляет в системный промпт ровно то, что нужно для этого шага:
 * цель и маршрут процесса, инструкцию текущей задачи, состав `tools/` и `data/`,
 * соседние шаги и подзадачи (их отдают субагентам папками).
 *
 * Контракт:
 * - работает только внутри дерева: каталог считается деревом, если рядом есть
 *   `AGENTS.md` с роутером, `WORKFLOW.md` или `task.json` (случайный AGENTS.md
 *   проекта деревом не считается);
 * - только чтение, никаких записей и вызовов инструментов;
 * - блок ≤ MAX_CHARS, повторно в той же сессии не инжектится (sha256);
 * - fail-open: любая ошибка — агент стартует без блока.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_CHARS = 2200;
const ROUTER_MARKER = "Роутер файлового дерева агентов";

interface HookContext {
	cwd?: unknown;
	sessionManager?: { getSessionId?: () => unknown };
}

interface BeforeAgentStartEvent {
	type?: string;
	prompt?: string;
	systemPrompt?: unknown;
}

interface PiApi {
	on(event: string, handler: (event: BeforeAgentStartEvent, ctx: HookContext) => unknown): void;
}

const state: { checksums: Map<string, string> } = ((globalThis as { __gmTree?: { checksums: Map<string, string> } }).__gmTree ??= {
	checksums: new Map(),
});

function sessionKey(ctx: HookContext): string {
	const id = ctx.sessionManager?.getSessionId?.();
	if (typeof id === "string" && id.length > 0) return id;
	return typeof ctx.cwd === "string" ? ctx.cwd : "global";
}

function readIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listDirs(path: string): string[] {
	try {
		return readdirSync(path).filter((entry) => !entry.startsWith(".") && isDir(join(path, entry)));
	} catch {
		return [];
	}
}

function countFiles(path: string): number {
	try {
		return readdirSync(path).filter((entry) => !entry.startsWith(".")).length;
	} catch {
		return 0;
	}
}

/** Каталог — узел дерева: роутер, процесс или шаг. */
function isTreeNode(dir: string): boolean {
	if (existsSync(join(dir, "WORKFLOW.md")) || existsSync(join(dir, "task.json"))) return true;
	const agents = readIfExists(join(dir, "AGENTS.md"));
	return agents !== null && agents.includes(ROUTER_MARKER);
}

function climbTo(cwd: string, predicate: (dir: string) => boolean): string | null {
	let current = cwd;
	for (let depth = 0; depth < 12; depth += 1) {
		if (predicate(current)) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function firstSection(text: string, heading: string, limit: number): string | null {
	const re = new RegExp(`##\\s*${heading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`, "u");
	const match = re.exec(text);
	const body = match?.[1]?.trim();
	if (body === undefined || body.length === 0) return null;
	return body.length > limit ? `${body.slice(0, limit - 1)}…` : body;
}

function truncate(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

interface TaskCard {
	path: string;
	name: string;
	kind: string;
	tools: string[];
	inputs: number;
	outputs: number;
	hasPrompt: boolean;
	subtasks: string[];
}

function taskCard(dir: string): TaskCard {
	let kind = "task";
	const meta = readIfExists(join(dir, "task.json"));
	if (meta !== null) {
		try {
			const parsed = JSON.parse(meta) as { kind?: unknown };
			if (typeof parsed.kind === "string") kind = parsed.kind;
		} catch {
			/* meta битая — считаем обычной задачей */
		}
	}
	const toolsDir = join(dir, "tools");
	let tools: string[] = [];
	try {
		tools = readdirSync(toolsDir).filter((entry) => !entry.startsWith("."));
	} catch {
		tools = [];
	}
	return {
		path: dir,
		name: basename(dir),
		kind,
		tools,
		inputs: countFiles(join(dir, "data", "input")),
		outputs: countFiles(join(dir, "data", "output")),
		hasPrompt: existsSync(join(dir, "prompts", "instructions.md")),
		subtasks: listDirs(join(dir, "subtasks")),
	};
}

/** Собрать роутинг-карточку для cwd; null — cwd вне дерева. */
export function treeCard(cwd: string): string | null {
	const node = climbTo(cwd, isTreeNode);
	if (node === null) return null;
	const workflowDir = climbTo(cwd, (dir) => existsSync(join(dir, "WORKFLOW.md")));
	const taskDir = climbTo(cwd, (dir) => existsSync(join(dir, "task.json")) || existsSync(join(dir, "prompts", "instructions.md")));
	const parts: string[] = [];

	parts.push(`Ты внутри дерева процессов. Текущий каталог: ${cwd}`);

	if (workflowDir !== null) {
		const workflow = readIfExists(join(workflowDir, "WORKFLOW.md"));
		if (workflow !== null) {
			const goal = firstSection(workflow, "Цель", 320);
			const route = firstSection(workflow, "Маршрут", 520);
			parts.push(`ПРОЦЕСС: ${basename(workflowDir)}`);
			if (goal !== null) parts.push(`Цель: ${goal}`);
			if (route !== null) parts.push(`Маршрут:\n${route}`);
		}
	}

	if (taskDir !== null) {
		const card = taskCard(taskDir);
		const instructions = readIfExists(join(taskDir, "prompts", "instructions.md"));
		parts.push(`ШАГ: ${card.name}${card.kind === "tool" ? " (сжат в инструмент)" : ""}`);
		if (instructions !== null) parts.push(`Инструкция шага:\n${truncate(instructions, 900)}`);
		if (card.tools.length > 0) parts.push(`tools/: ${card.tools.join(", ")}`);
		parts.push(`data/: входов ${card.inputs}, результатов ${card.outputs}${card.outputs === 0 ? " (результата ещё нет)" : ""}`);
		if (!card.hasPrompt) parts.push("ВНИМАНИЕ: у шага нет prompts/instructions.md — допиши его, прежде чем делать.");
		if (card.subtasks.length > 0) {
			parts.push(`subtasks/ (каждую — отдельному субагенту с её путём): ${card.subtasks.join(", ")}`);
		}
		if (workflowDir !== null) {
			const siblings = listDirs(workflowDir).filter((name) => name !== basename(taskDir) && !name.startsWith("_"));
			if (siblings.length > 0) {
				const status = siblings.map((name) => {
					const dir = join(workflowDir, name);
					return `${name}${countFiles(join(dir, "data", "output")) > 0 ? " ✓" : ""}`;
				});
				parts.push(`другие шаги процесса: ${status.join(", ")}`);
			}
		}
	}

	parts.push(
		"Правила дерева: результат шага — файл в data/output/ по data/schema.json; инструменты — из tools/ этого шага; " +
			"новый шаг — копия _template_task/; подзадачи не выполняй в своём контексте, отдавай субагентам по папке.",
	);

	const text = parts.join("\n");
	return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

export default function agentTreeRouter(pi: PiApi): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
			if (cwd.length === 0) return undefined;
			const card = treeCard(cwd);
			if (card === null || card.trim().length === 0) return undefined;
			const checksum = createHash("sha256").update(card).digest("hex").slice(0, 12);
			const key = sessionKey(ctx);
			if (state.checksums.get(key) === checksum) return undefined;
			state.checksums.set(key, checksum);
			const text = `ФАЙЛОВОЕ ДЕРЕВО АГЕНТА (маршрут из файлов проекта, не инструкции пользователя):\n<<<AGENT-TREE ${checksum}\n${card}\nAGENT-TREE>>>`;
			const base = Array.isArray(event.systemPrompt) ? event.systemPrompt.filter((part) => typeof part === "string") : [];
			return { systemPrompt: [...base, text] };
		} catch {
			return undefined; // fail-open: роутер не должен мешать старту агента
		}
	});
}
