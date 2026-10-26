import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTasks, lintAgentTree, scanAgentTree } from "../agent-tree.ts";

const ROUTER = "# Роутер файлового дерева агентов\n\nправила\n";

function tree(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-tree-"));
	writeFileSync(join(root, "AGENTS.md"), ROUTER);
	return root;
}

function step(root: string, workflow: string, name: string, options: { prompt?: string | null; tools?: string[]; outputs?: string[]; schema?: string | null; kind?: string; subtasks?: string[] } = {}): string {
	const dir = join(root, workflow, name);
	for (const sub of ["prompts", "tools", "data/input", "data/output"]) mkdirSync(join(dir, sub), { recursive: true });
	const prompt = options.prompt === undefined ? "# Шаг\n\nсделай работу и положи результат в data/output по схеме\n" : options.prompt;
	if (prompt !== null) writeFileSync(join(dir, "prompts", "instructions.md"), prompt);
	for (const tool of options.tools ?? []) writeFileSync(join(dir, "tools", tool), "#!/usr/bin/env bun\n");
	for (const out of options.outputs ?? []) writeFileSync(join(dir, "data", "output", out), "{}");
	const schema = options.schema === undefined ? JSON.stringify({ type: "object" }) : options.schema;
	if (schema !== null) writeFileSync(join(dir, "data", "schema.json"), schema);
	writeFileSync(join(dir, "task.json"), JSON.stringify({ kind: options.kind ?? "task" }));
	for (const sub of options.subtasks ?? []) step(join(dir, "subtasks"), "", sub);
	return dir;
}

function workflow(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "WORKFLOW.md"), "# Процесс\n\n## Цель\nсделать штуку\n\n## Маршрут\n1. шаг\n");
	mkdirSync(join(dir, "_template_task", "prompts"), { recursive: true });
	writeFileSync(join(dir, "_template_task", "prompts", "instructions.md"), "шаблон\n");
	return dir;
}

describe("сканер файлового дерева", () => {
	test("находит процесс, шаги и подзадачи с их состоянием", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-check", { tools: ["check.ts"], outputs: ["check.json"], subtasks: ["api"] });
		step(root, "release", "02-build", { tools: ["build.ts"], kind: "tool" });
		const scanned = scanAgentTree(root);
		expect(scanned).toHaveLength(1);
		const wf = scanned[0];
		expect(wf?.name).toBe("release");
		expect(wf?.hasWorkflowMd).toBe(true);
		expect(wf?.goal).toBe("сделать штуку");
		const byName = new Map((wf?.tasks ?? []).map((t) => [t.path.split("/").pop(), t]));
		expect(byName.get("01-check")?.outputs).toBe(1);
		expect(byName.get("01-check")?.tools).toEqual(["check.ts"]);
		expect(byName.get("01-check")?.subtasks).toHaveLength(1);
		expect(byName.get("02-build")?.kind).toBe("tool");
	});

	test("счётчики складывают подзадачи", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-check", { outputs: ["a.json"], subtasks: ["api", "ui"] });
		const tasks = scanAgentTree(root)[0]?.tasks ?? [];
		expect(countTasks(tasks).total).toBe(3);
		expect(countTasks(tasks).done).toBe(1);
		expect(countTasks(tasks).subtasks).toBe(2);
	});

	test("пустой каталог даёт пустой список, а не падение", () => {
		expect(scanAgentTree(mkdtempSync(join(tmpdir(), "omp-empty-")))).toEqual([]);
		expect(scanAgentTree("/нет/такого/каталога")).toEqual([]);
	});
});

describe("линтер структуры", () => {
	test("правильное дерево проходит", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-check", { tools: ["check.ts"] });
		const result = lintAgentTree(root);
		expect(result.ok).toBe(true);
		expect(result.problems).toEqual([]);
		expect(result.workflows).toBe(1);
		expect(result.tasks).toBe(1);
	});

	test("шаг без промпта, без схемы и без результата — это проблемы", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-check", { prompt: null, tools: ["check.ts"], schema: null });
		const result = lintAgentTree(root);
		expect(result.ok).toBe(false);
		expect(result.problems.join("\n")).toContain("нет prompts/instructions.md");
	});

	test("битая схема ловится отдельной строкой", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-check", { tools: ["check.ts"], schema: "{не json" });
		const problems = lintAgentTree(root).problems.join("\n");
		expect(problems).toContain("schema.json — невалидный JSON");
	});

	test("шаг без инструментов допустим только как подробное рассуждение", () => {
		const root = tree();
		workflow(root, "release");
		step(root, "release", "01-think", { tools: [], prompt: "# Шаг\n\nкороткая инструкция\n" });
		expect(lintAgentTree(root).problems.join("\n")).toContain("пустые tools/");
		step(root, "release", "02-think", { tools: [], prompt: `# Шаг\n\n${"подробная инструкция шага-рассуждения. ".repeat(12)}\n## Готово когда\n- результат описан\n` });
		const after = lintAgentTree(root).problems.join("\n");
		expect(after).not.toContain("02-think");
	});

	test("процесс без цели, маршрута и шаблона — три отдельные проблемы", () => {
		const root = tree();
		const dir = join(root, "empty");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "WORKFLOW.md"), "# Процесс\n\nбез разделов\n");
		const problems = lintAgentTree(root).problems.join("\n");
		expect(problems).toContain("нет раздела «Цель»");
		expect(problems).toContain("нет раздела «Маршрут»");
		expect(problems).toContain("нет _template_task");
	});

	test("без AGENTS.md дерево не считается настроенным", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-norouter-"));
		workflow(root, "release");
		step(root, "release", "01-check", { tools: ["check.ts"] });
		expect(lintAgentTree(root).problems.join("\n")).toContain("нет AGENTS.md");
	});
});
