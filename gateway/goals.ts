/**
 * goals — API управления автономными целями для Pocket.
 *
 * Тонкая обёртка над контроллером `bin/autonomy.ts`: цели живут в общем каталоге
 * (`~/.omp/autonomy`), проверки выполняются в каталоге проекта, а UI получает
 * состояние, план, журнал, доказательства и остаточные риски как есть.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ENGINE = join(homedir(), "omp-mobile", "bin", "autonomy.ts");
const ROOT = process.env.OMP_AUTONOMY_ROOT ?? join(homedir(), ".omp", "autonomy");

export interface GoalStep {
	name: string;
	status: "todo" | "doing" | "done" | "failed";
	attempts: number;
	evidence: string[];
}

export interface GoalState {
	slug: string;
	goal: string;
	phase: string;
	current: number;
	steps: GoalStep[];
	criteria: string[];
	limits: Record<string, number>;
	approvals: { action: string; note: string; at: string }[];
	residuals: { text: string; reason: string; impact: string; exitCondition: string }[];
	log: { at: string; phase: string; event: string; detail: string }[];
	result: { status: string; detail: string } | null;
	project?: string;
	updatedAt: string;
	createdAt: string;
}

function engineEnv(): Record<string, string> {
	return { ...process.env, OMP_AUTONOMY_ROOT: ROOT } as Record<string, string>;
}

async function runEngine(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
	const proc = spawn("bun", [ENGINE, ...args], { cwd, env: engineEnv() });
	let out = "";
	let err = "";
	proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
	const { promise, resolve } = Promise.withResolvers<number>();
	proc.on("close", (code) => resolve(code ?? 1));
	proc.on("error", () => resolve(1));
	return { code: await promise, out, err };
}

function slugify(goal: string): string {
	const base = goal
		.toLowerCase()
		.replace(/[^a-zа-я0-9]+/giu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 36);
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${base || "goal"}-${suffix}`;
}

function statePath(slug: string): string {
	return join(ROOT, slug, "state.json");
}

export async function listGoals(): Promise<GoalState[]> {
	if (!existsSync(ROOT)) return [];
	const entries = await readdir(ROOT, { withFileTypes: true });
	const goals: GoalState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = statePath(entry.name);
		if (!existsSync(path)) continue;
		try {
			const state = JSON.parse(await readFile(path, "utf8")) as GoalState;
			goals.push(state);
		} catch {
			// битое состояние цели не должно ломать список: покажем пропуск в UI через отсутствие
		}
	}
	return goals.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function readGoal(slug: string): Promise<GoalState | null> {
	const path = statePath(slug);
	if (!existsSync(path)) return null;
	return JSON.parse(await readFile(path, "utf8")) as GoalState;
}

export interface CreateGoalInput {
	goal: string;
	criteria?: string[];
	steps?: string[];
	project?: string;
	strategy?: string[];
	maxMinutes?: number;
	maxCost?: number;
	gate?: string;
}

export async function createGoal(input: CreateGoalInput): Promise<{ ok: boolean; slug?: string; error?: string }> {
	const goal = (input.goal ?? "").trim();
	if (goal.length < 3) return { ok: false, error: "цель слишком короткая" };
	const project = input.project ?? join(homedir(), "OMP", "omp");
	if (!existsSync(project)) return { ok: false, error: `нет каталога проекта: ${project}` };
	await mkdir(ROOT, { recursive: true });
	const slug = slugify(goal);
	const args = ["start", slug, "--goal", goal, "--project", project];
	for (const ac of input.criteria ?? []) if (ac.trim()) args.push("--ac", ac.trim());
	for (const step of input.steps ?? []) if (step.trim()) args.push("--step", step.trim());
	for (const strategy of input.strategy ?? []) if (strategy.trim()) args.push("--strategy", strategy.trim());
	if (input.gate) args.push("--gate", input.gate);
	if (input.maxMinutes) args.push("--max-minutes", String(input.maxMinutes));
	if (input.maxCost) args.push("--max-cost", String(input.maxCost));
	const result = await runEngine(args, project);
	if (result.code !== 0) return { ok: false, error: result.err.trim() || result.out.trim() || "контроллер отказал" };
	return { ok: true, slug };
}

/** Автономный прогон: драйвер получает контекст и делает шаги сам, без кнопок Next/Step. */
export async function driveGoal(slug: string, driver = "omp -p"): Promise<{ ok: boolean; detail: string }> {
	const state = await readGoal(slug);
	if (!state) return { ok: false, detail: "цель не найдена" };
	if (state.phase === "RESULT" || state.phase === "BLOCKED") return { ok: false, detail: `цель уже закрыта: ${state.phase}` };
	const project = state.project ?? join(homedir(), "OMP", "omp");
	const child = spawn("bun", [ENGINE, "drive", slug, "--driver", driver], { cwd: project, env: engineEnv(), detached: true });
	child.unref();
	await mkdir(ROOT, { recursive: true });
	return { ok: true, detail: `автономный прогон запущен (pid ${child.pid ?? "?"})` };
}

export async function reportGoal(slug: string): Promise<{ ok: boolean; text: string }> {
	const state = await readGoal(slug);
	if (!state) return { ok: false, text: "цель не найдена" };
	const project = state.project ?? join(homedir(), "OMP", "omp");
	const result = await runEngine(["report", slug], project);
	return { ok: result.code === 0, text: (result.out || result.err).trim() };
}

export { ROOT as GOALS_ROOT, ENGINE as GOALS_ENGINE };
