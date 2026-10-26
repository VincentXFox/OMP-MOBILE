#!/usr/bin/env bun
/**
 * autonomy — контроллер автономного исполнения цели.
 *
 * Модель не держит правила в голове: цикл, лимиты, смена стратегии, границы и
 * подтверждения живут здесь, в коде. Модели отдаётся компактный контекст
 * (цель, фаза, текущий шаг, попытки, доступные действия), а не весь устав.
 *
 * Фазы: PLAN → EXECUTE → (RECOVER) → VERIFY → RESULT | BLOCKED.
 * Состояние пишется на диск после каждого шага — переживает перезапуск OMP.
 *
 * Команды:
 *   start <slug> --goal "…" --ac "AC-01: …" [--step "…"]… [--strategy "…"]…
 *         [--danger "regex"]… [--max-steps N] [--max-attempts N] [--gate <slug>]
 *   next <slug>                 компактный контекст для модели
 *   step <slug> --did "…" --result ok|fail [--evidence "…"] [--approve "причина"]
 *   verify <slug>               VERIFY через quality-gate (сертификат как условие RESULT)
 *   resume <slug>               восстановить и показать, что делать дальше
 *   drive <slug> [--driver "cmd"]  автоцикл: драйвер получает контекст на stdin,
 *                               печатает STEP:/RESULT:/EVIDENCE:, контроллер ведёт состояние
 *   status <slug> | report <slug> | list
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { decide, type Decision } from "./policy.ts";

type Phase = "PLAN" | "EXECUTE" | "RECOVER" | "VERIFY" | "RESULT" | "BLOCKED";

interface Step {
	name: string;
	status: "todo" | "doing" | "done" | "failed";
	attempts: number;
	strategy: number;
	evidence: string[];
}

interface Residual {
	text: string;
	reason: string;
	impact: string;
	exitCondition: string;
}

interface State {
	slug: string;
	goal: string;
	criteria: string[];
	phase: Phase;
	steps: Step[];
	current: number;
	strategies: string[];
	strategyIndex: number;
	gateSlug: string | null;
	limits: { maxSteps: number; maxAttempts: number; maxIdentical: number; maxMinutes: number; maxStall: number };
	stall: number;
	startedAt: string;
	attemptKeys: { key: string; count: number }[];
	approvals: { action: string; note: string; at: string }[];
	danger: string[];
	residuals: Residual[];
	log: { at: string; phase: string; event: string; detail: string }[];
	createdAt: string;
	updatedAt: string;
	result: { status: "ГОТОВО" | "PARTIAL" | "BLOCKED"; detail: string } | null;
}

const ROOT = join(process.cwd(), ".omp", "autonomy");

/** Границы: без явного подтверждения такие действия контроллер не пропускает. */
const DEFAULT_DANGER = [
	"rm\\s+-rf\\s+/",
	"mkfs\\.",
	"dd\\s+of=/dev/",
	"drop\\s+database",
	"truncate\\s+table",
	"git\\s+push\\s+(?:--force|-f)",
	"git\\s+reset\\s+--hard",
	"shutdown|reboot|poweroff",
	"\\bsudo\\b",
	"chmod\\s+777",
];

function argValues(argv: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
	return out;
}

function argValue(argv: string[], flag: string): string | null {
	const values = argValues(argv, flag);
	return values.length > 0 ? (values[values.length - 1] as string) : null;
}

function hasFlag(argv: string[], flag: string): boolean {
	return argv.includes(flag);
}

function now(): string {
	return new Date().toISOString();
}

function stateDir(slug: string): string {
	return join(ROOT, slug);
}

async function save(state: State): Promise<void> {
	state.updatedAt = now();
	await mkdir(stateDir(state.slug), { recursive: true });
	const tmp = join(stateDir(state.slug), "state.json.tmp");
	await writeFile(tmp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	await rename(tmp, join(stateDir(state.slug), "state.json"));
}

async function load(slug: string): Promise<State> {
	const path = join(stateDir(slug), "state.json");
	if (!existsSync(path)) throw new Error(`нет цели «${slug}»: сначала autonomy start ${slug} --goal "…"`);
	return JSON.parse(await readFile(path, "utf8")) as State;
}

function log(state: State, event: string, detail: string): void {
	state.log.push({ at: now(), phase: state.phase, event, detail });
	if (state.log.length > 500) state.log = state.log.slice(-500);
}

function currentStep(state: State): Step | null {
	return state.steps[state.current] ?? null;
}

/** Компактный контекст для модели: только то, что нужно для следующего действия. */
function context(state: State): string {
	const step = currentStep(state);
	const lines: string[] = [];
	lines.push(`ЦЕЛЬ: ${state.goal}`);
	lines.push(`ФАЗА: ${state.phase}`);
	lines.push(`КРИТЕРИИ: ${state.criteria.join("; ") || "не заданы"}`);
	lines.push(`ПЛАН: ${state.steps.map((item, index) => `${index + 1}.${item.status === "done" ? "✓" : item.status === "failed" ? "✗" : "•"} ${item.name}`).join(" | ")}`);
	if (step) {
		lines.push(`ТЕКУЩИЙ ШАГ: ${step.name} (попыток: ${step.attempts}, стратегия: ${step.strategy >= 0 ? state.strategies[step.strategy] : "базовая"})`);
		lines.push(`АЛЬТЕРНАТИВНЫЕ СТРАТЕГИИ: ${state.strategies.filter((_, index) => index > step.strategy).join(" | ") || "не осталось"}`);
		if (step.evidence.length > 0) lines.push(`ЧТО УЖЕ ДОКАЗАНО: ${step.evidence.slice(-3).join(" ; ")}`);
	}
	lines.push(`ЛИМИТЫ: шагов ${state.limits.maxSteps}, попыток на шаг ${state.limits.maxAttempts}, повторов одного действия ${state.limits.maxIdentical}`);
	lines.push(`ДОСТУПНЫЕ ДЕЙСТВИЯ: step --did "…" --result ok|fail [--evidence "…"] · verify · resume · status`);
	lines.push(`ГРАНИЦЫ: опасное действие требует --approve "причина"; запрет не обходится, а эскалируется`);
	lines.push(`ПАМЯТЬ: решения и журнал — .omp/autonomy/${state.slug}/decisions.md и state.json (по ссылке, не в контексте)`);
	lines.push(`РЕСУРСЫ: время ${Math.round((Date.now() - Date.parse(state.startedAt)) / 60000)}/${state.limits.maxMinutes} мин, застой ${state.stall}/${state.limits.maxStall}`);
	return lines.join("\n");
}

function policyVerdict(state: State, action: string): { decision: Decision; rule: string | null } {
	const verdict = decide(action);
	if (verdict.decision === "deny") return verdict;
	// Пользовательские шаблоны цели усиливают границы, но не ослабляют политику.
	const extra = [...DEFAULT_DANGER, ...state.danger].find((pattern) => {
		try {
			return new RegExp(pattern, "iu").test(action);
		} catch {
			return false;
		}
	});
	if (extra) return { decision: "confirm", rule: extra };
	return verdict;
}

function attemptKey(step: string, action: string): string {
	return createHash("sha256").update(`${step}\u0000${action}`).digest("hex").slice(0, 12);
}

async function cmdStart(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: autonomy start <slug> --goal \"…\"");
	const goal = argValue(argv, "--goal");
	if (!goal) throw new Error("нужна цель: --goal \"чего добиться\"");
	const steps = argValues(argv, "--step").map((name, index) => ({
		name,
		status: "todo" as const,
		attempts: 0,
		strategy: 0,
		evidence: [],
		id: index,
	}));
	const state: State = {
		slug,
		goal,
		criteria: argValues(argv, "--ac"),
		phase: "PLAN",
		steps:
			steps.length > 0
				? steps.map(({ name }) => ({ name, status: "todo", attempts: 0, strategy: -1, evidence: [] }))
				: [{ name: "выполнить цель", status: "todo", attempts: 0, strategy: -1, evidence: [] }],
		current: 0,
		strategies: argValues(argv, "--strategy"),
		strategyIndex: 0,
		gateSlug: argValue(argv, "--gate"),
		limits: {
			maxSteps: Number(argValue(argv, "--max-steps") ?? 40),
			maxAttempts: Number(argValue(argv, "--max-attempts") ?? 5),
			maxIdentical: Number(argValue(argv, "--max-identical") ?? 2),
			maxMinutes: Number(argValue(argv, "--max-minutes") ?? 120),
			maxStall: Number(argValue(argv, "--max-stall") ?? 6),
		},
		stall: 0,
		startedAt: now(),
		attemptKeys: [],
		approvals: [],
		danger: argValues(argv, "--danger"),
		residuals: [],
		log: [],
		createdAt: now(),
		updatedAt: now(),
		result: null,
	};
	log(state, "start", `цель принята: ${goal}`);
	await save(state);
	console.log(context(state));
	return 0;
}

async function cmdNext(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	console.log(context(state));
	return 0;
}

async function appendDecision(slug: string, line: string): Promise<void> {
	const path = join(stateDir(slug), "decisions.md");
	await mkdir(stateDir(slug), { recursive: true });
	const previous = existsSync(path) ? await readFile(path, "utf8") : "# Решения\n";
	await writeFile(path, `${previous}- ${now()} — ${line}\n`, "utf8");
}

async function cmdStep(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	if (state.phase === "RESULT" || state.phase === "BLOCKED") {
		console.error(`цель уже закрыта: ${state.phase}`);
		return 1;
	}
	const elapsedMinutes = (Date.now() - Date.parse(state.startedAt)) / 60000;
	if (elapsedMinutes > state.limits.maxMinutes) {
		state.phase = "BLOCKED";
		state.result = { status: "BLOCKED", detail: `превышен лимит времени ${state.limits.maxMinutes} мин` };
		state.residuals.push({
			text: "цель не достигнута в отведённое время",
			reason: `прошло ${Math.round(elapsedMinutes)} мин при лимите ${state.limits.maxMinutes}`,
			impact: "работа остановлена по ресурсному лимиту",
			exitCondition: "продолжить с новым лимитом или упростить цель",
		});
		log(state, "resource.blocked", `время ${Math.round(elapsedMinutes)} мин > ${state.limits.maxMinutes}`);
		await save(state);
		console.error(`ресурсный лимит: прошло ${Math.round(elapsedMinutes)} мин (лимит ${state.limits.maxMinutes})`);
		return 1;
	}
	const did = argValue(argv, "--did");
	const result = argValue(argv, "--result");
	if (!did || (result !== "ok" && result !== "fail")) throw new Error("нужно --did \"что сделал\" --result ok|fail");

	// Политика проверяется до любых изменений состояния: deny не обходится, confirm требует причины.
	const verdict = policyVerdict(state, did);
	if (verdict.decision === "deny") {
		console.error(
			`ЗАПРЕЩЕНО политикой (правило: ${verdict.rule}). Это граница полномочий, а не техническое препятствие: ` +
				"предложи разрешённый путь достижения цели.",
		);
		log(state, "boundary", `deny: ${verdict.rule}`);
		state.residuals.push({
			text: `действие отклонено политикой: ${did.slice(0, 80)}`,
			reason: `правило deny: ${verdict.rule}`,
			impact: "шаг требует другого способа",
			exitCondition: "согласовать с владельцем изменение политики",
		});
		await appendDecision(state.slug, `deny: ${verdict.rule} (${did.slice(0, 80)})`);
		await save(state);
		return 3;
	}
	if (verdict.decision === "confirm" && !hasFlag(argv, "--approve")) {
		console.error(
			`ДЕЙСТВИЕ ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ (правило: ${verdict.rule ?? "незнакомое действие"}). ` +
				"Повтори с --approve \"зачем это нужно\" или выбери обратимый путь.",
		);
		log(state, "boundary", `confirm без причины: ${verdict.rule ?? did.slice(0, 80)}`);
		await save(state);
		return 1;
	}
	if (verdict.decision === "confirm") {
		state.approvals.push({ action: did.slice(0, 200), note: argValue(argv, "--approve") ?? "", at: now() });
		log(state, "approval", `${verdict.rule ?? "действие"} подтверждён: ${argValue(argv, "--approve") ?? ""}`);
		// Перед рискованным шагом снимаем контрольную точку: откат должен существовать заранее.
		if (state.gateSlug) {
			const engine = join(import.meta.dir, "quality-gate.ts");
			const snapshot = spawn("bun", [engine, "snapshot", state.gateSlug], { cwd: process.cwd() });
			await new Promise<void>((resolveSnapshot) => {
				snapshot.on("close", () => resolveSnapshot());
				snapshot.on("error", () => resolveSnapshot());
			});
			log(state, "snapshot", `контрольная точка перед рискованным шагом: ${state.gateSlug}`);
		}
	}

	const step = currentStep(state);
	if (!step) {
		state.phase = "VERIFY";
		await save(state);
		console.log("шаги кончились → VERIFY");
		return 0;
	}
	if (state.phase === "PLAN") state.phase = "EXECUTE";
	step.attempts += 1;

	if (result === "ok") {
		step.status = "done";
		const evidence = argValue(argv, "--evidence");
		if (evidence) step.evidence.push(evidence);
		log(state, "step.ok", `${step.name}: ${did.slice(0, 120)}`);
		state.current += 1;
		state.attemptKeys = [];
		state.stall = 0;
		if (state.current >= state.steps.length) state.phase = "VERIFY";
	} else {
		const key = attemptKey(step.name, did);
		const bucket = state.attemptKeys.find((item) => item.key === key);
		if (bucket) bucket.count += 1;
		else state.attemptKeys.push({ key, count: 1 });
		const repeats = bucket?.count ?? 1;
		log(state, "step.fail", `${step.name}: ${did.slice(0, 120)} (повтор ${repeats})`);
		// Один и тот же вход третий раз — это цикл, а не настойчивость.
		if (repeats >= state.limits.maxIdentical) {
			const nextStrategy = (step.strategy ?? -1) + 1;
			if (nextStrategy < state.strategies.length) {
				step.strategy = nextStrategy;
				state.attemptKeys = [];
				state.phase = "RECOVER";
				log(state, "recover", `одинаковое действие ${repeats}× → стратегия «${state.strategies[nextStrategy]}»`);
			} else {
				state.phase = "RECOVER";
				state.residuals.push({
					text: `шаг «${step.name}» не выполнен`,
					reason: `стратегии исчерпаны (${state.strategies.length || 1}), одинаковое действие повторялось ${repeats}×`,
					impact: `цель «${state.goal}» не достигнута`,
					exitCondition: "нужна новая стратегия или внешняя информация",
				});
				state.phase = "BLOCKED";
				state.result = { status: "BLOCKED", detail: `шаг «${step.name}»: стратегии исчерпаны` };
				log(state, "blocked", "стратегии исчерпаны");
			}
		}
		if (step.attempts >= state.limits.maxAttempts && state.phase !== "BLOCKED") {
			state.phase = "RECOVER";
			log(state, "recover", `попыток ${step.attempts} ≥ лимита ${state.limits.maxAttempts}`);
		}
		step.status = "failed";
		state.stall += 1;
		if (state.stall >= state.limits.maxStall && state.phase !== "BLOCKED") {
			state.phase = "BLOCKED";
			state.result = { status: "BLOCKED", detail: `застой: ${state.stall} неудач без прогресса` };
			state.residuals.push({
				text: `шаг «${step.name}» не двигается`,
				reason: `${state.stall} неудачных попыток подряд без выполненного шага`,
				impact: "цель не достигается выбранными способами",
				exitCondition: "нужна внешняя информация или другой класс решений",
			});
			log(state, "stall.blocked", `${state.stall} неудач подряд`);
		}
	}
	if (state.steps.length > state.limits.maxSteps) {
		state.phase = "BLOCKED";
		state.result = { status: "BLOCKED", detail: "превышен лимит шагов" };
	}
	await save(state);
	console.log(context(state));
	return 0;
}

/**
 * Goal Guardian: перед RESULT сверяем не «сколько шагов сделано», а доказана ли цель.
 * Смотрим сертификат: все критерии покрыты пройденными проверками, аттестат положительный.
 */
async function goalGuard(state: State, gateSlug: string): Promise<string[]> {
	const problems: string[] = [];
	const certPath = join(process.cwd(), ".omp", "gate", gateSlug, "certificate.json");
	if (!existsSync(certPath)) return [...problems, `нет сертификата ${gateSlug}: результат не подтверждён`];
	const cert = JSON.parse(await readFile(certPath, "utf8")) as {
		status?: string;
		criteria?: { id: string }[];
		checks?: { ok?: boolean; covers?: string[] }[];
		review?: { verdict?: string } | null;
	};
	// Критерии могут жить в контракте приёмки: цель в контроллере не обязана их дублировать.
	const criteria = (cert.criteria ?? []).map((item) => item.id);
	if (criteria.length === 0 && state.criteria.length === 0) problems.push("цель без критериев: доказать нечего");
	const covered = new Set((cert.checks ?? []).filter((check) => check.ok).flatMap((check) => check.covers ?? []));
	const uncovered = criteria.filter((id) => !covered.has(id));
	if (uncovered.length > 0) problems.push(`критерии без доказательства: ${uncovered.join(", ")}`);
	if (cert.status === "FAILED") problems.push("сертификат в статусе FAILED");
	if ((cert.review?.verdict ?? "N/A") !== "PASS") problems.push(`ревью не PASS: ${cert.review?.verdict ?? "N/A"}`);
	const undone = state.steps.filter((step) => step.status !== "done").map((step) => step.name);
	if (undone.length > 0) problems.push(`шаги не выполнены: ${undone.join(", ")}`);
	return problems;
}

async function cmdGuard(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	const gateSlug = argValue(argv, "--gate") ?? state.gateSlug;
	if (!gateSlug) {
		console.error("нет контракта: RESULT невозможен");
		return 1;
	}
	const problems = await goalGuard(state, gateSlug);
	if (problems.length === 0) {
		console.log("цель доказана: критерии покрыты, ревью PASS, шаги выполнены");
		return 0;
	}
	console.error(`цель не доказана: ${problems.join("; ")}`);
	return 1;
}

async function cmdVerify(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	const gateSlug = argValue(argv, "--gate") ?? state.gateSlug;
	if (!gateSlug) {
		console.error("VERIFY невозможен без контракта: передай --gate <slug> сертификата quality-gate");
		state.phase = "RECOVER";
		await save(state);
		return 1;
	}
	const guardProblems = await goalGuard(state, gateSlug);
	if (guardProblems.length > 0) {
		state.phase = "RECOVER";
		state.residuals.push({
			text: "цель не доказана",
			reason: guardProblems.join("; "),
			impact: "RESULT запрещён",
			exitCondition: "закрыть критерии и повторить verify",
		});
		log(state, "guard.fail", guardProblems.join("; "));
		await save(state);
		console.error(`Goal Guardian: ${guardProblems.join("; ")}`);
		return 1;
	}
	// Движок фиксирован: подмена --engine давала бы фальшивый PASS мимо настоящей проверки.
	const engine = join(import.meta.dir, "quality-gate.ts");
	const child = spawn("bun", [engine, "verify", gateSlug], { cwd: process.cwd() });
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
	const { promise, resolve } = Promise.withResolvers<number>();
	child.on("close", (code) => resolve(code ?? 1));
	child.on("error", () => resolve(1));
	const code = await promise;
	if (code === 0) {
		state.phase = "RESULT";
		state.result = { status: "ГОТОВО", detail: out.trim() };
		log(state, "verify.ok", out.trim());
		await save(state);
		console.log(`RESULT: ГОТОВО · ${out.trim()}`);
		return 0;
	}
	state.phase = "RECOVER";
	log(state, "verify.fail", `${out.trim()} ${err.trim()}`.slice(0, 300));
	await save(state);
	console.error(`VERIFY не пройден: ${err.trim() || out.trim()}`);
	return 1;
}

async function cmdResume(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	// Состояние целиком на диске: после перезапуска OMP продолжаем с того же места.
	const state = await load(slug);
	log(state, "resume", `продолжение с шага ${state.current} в фазе ${state.phase}`);
	await save(state);
	console.log(context(state));
	if (state.phase === "RESULT" || state.phase === "BLOCKED") console.log(`ИТОГ: ${state.result?.status} · ${state.result?.detail}`);
	return 0;
}

async function cmdStatus(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	console.log(`${state.slug}: ${state.phase} · шаг ${state.current + 1}/${state.steps.length} · цепь: ${state.goal}`);
	if (state.result) console.log(`  итог: ${state.result.status} — ${state.result.detail}`);
	for (const item of state.residuals) console.log(`  остаток: ${item.text} (причина: ${item.reason})`);
	return 0;
}

async function cmdReport(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");
	const state = await load(slug);
	const done = state.steps.filter((step) => step.status === "done").length;
	console.log(`ЦЕЛЬ: ${state.goal}`);
	console.log(`ФАЗА: ${state.phase} · шагов выполнено ${done}/${state.steps.length}`);
	console.log(`КРИТЕРИИ: ${state.criteria.join("; ") || "не заданы"}`);
	console.log(`ИТОГ: ${state.result ? `${state.result.status} — ${state.result.detail}` : "не закрыт"}`);
	console.log("ДОКАЗАТЕЛЬСТВА:");
	for (const step of state.steps) for (const evidence of step.evidence) console.log(`- ${step.name}: ${evidence}`);
	const last = state.log.slice(-10).map((item) => `${item.at.slice(11, 19)} ${item.event}: ${item.detail.slice(0, 100)}`);
	console.log("ПОСЛЕДНИЕ СОБЫТИЯ:");
	for (const line of last) console.log(`- ${line}`);
	console.log(`RESIDUAL: ${state.residuals.length > 0 ? state.residuals.map((item) => `${item.text} → ${item.impact} (снимается: ${item.exitCondition})`).join("; ") : "явных рисков не заявлено"}`);
	console.log(`ПОДТВЕРЖДЕНИЯ: ${state.approvals.length}`);
	return 0;
}

async function cmdDrive(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug");

	let state = await load(slug);
	// Model Router: сложный шаг уходит сильной модели, сбой драйвера — фолбэку.
	const strong = argValue(argv, "--driver-strong");
	const fallback = argValue(argv, "--driver-fallback");
	const baseDriver = argValue(argv, "--driver") ?? "omp -p";
	const isComplex = (name: string) => /(?:архитект|сложн|debug|разбер|исслед|уязвим)/iu.test(name);
	let driver = strong && currentStep(state) && isComplex(currentStep(state)?.name ?? "") ? strong : baseDriver;
	for (let iteration = 0; iteration < state.limits.maxSteps; iteration++) {
		if (state.phase === "RESULT" || state.phase === "BLOCKED") break;
		const prompt = `${context(state)}\n\nСделай ОДИН шаг. Ответ строго тремя строками:\nSTEP: <что сделал>\nRESULT: ok|fail\nEVIDENCE: <чем подтверждено>`;
		const child = spawn("bash", ["-lc", driver], { cwd: process.cwd() });
		let out = "";
		const { promise, resolve } = Promise.withResolvers<void>();
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", () => {});
		child.on("close", () => resolve());
		child.on("error", () => resolve());
		child.stdin.write(prompt);
		child.stdin.end();
		await promise;
		const did = /STEP:\s*(.+)/u.exec(out)?.[1]?.trim();
		const result = /RESULT:\s*(ok|fail)/iu.exec(out)?.[1]?.toLowerCase() as "ok" | "fail" | undefined;
		const evidence = /EVIDENCE:\s*(.+)/u.exec(out)?.[1]?.trim();
		if ((!did || !result) && fallback && driver !== fallback) {
			// Роутер: драйвер не справился — задача уходит резервной модели без потери состояния.
			log(state, "router.fallback", `драйвер «${driver}» не дал шага → «${fallback}»`);
			driver = fallback;
			const retry = spawn("bash", ["-lc", fallback], { cwd: process.cwd() });
			let retryOut = "";
			const retryDone = Promise.withResolvers<void>();
			retry.stdout.on("data", (chunk: Buffer) => (retryOut += chunk.toString()));
			retry.on("close", () => retryDone.resolve());
			retry.on("error", () => retryDone.resolve());
			retry.stdin.write(prompt);
			retry.stdin.end();
			await retryDone.promise;
			const retryDid = /STEP:\s*(.+)/u.exec(retryOut)?.[1]?.trim();
			const retryResult = /RESULT:\s*(ok|fail)/iu.exec(retryOut)?.[1]?.toLowerCase() as "ok" | "fail" | undefined;
			const retryEvidence = /EVIDENCE:\s*(.+)/u.exec(retryOut)?.[1]?.trim();
			if (retryDid && retryResult) {
				const retryArgs = ["step", slug, "--did", retryDid, "--result", retryResult];
				if (retryEvidence) retryArgs.push("--evidence", retryEvidence);
				await cmdStep(retryArgs);
				state = await load(slug);
				continue;
			}
		}
		if (!did || !result) {
			state.phase = "RECOVER";
			state.residuals.push({
				text: "драйвер не дал разборчивый шаг",
				reason: `ответ не содержит STEP/RESULT: ${out.slice(0, 120)}`,
				impact: "цикл остановлен, чтобы не крутиться вслепую",
				exitCondition: "поправить драйвер или выполнить шаг вручную через step",
			});
			await save(state);
			console.error("драйвер ответил не по формату — цикл остановлен");
			return 1;
		}
		const stepArgs = ["step", slug, "--did", did, "--result", result];
		if (evidence) stepArgs.push("--evidence", evidence);
		const code = await cmdStep(stepArgs);
		state = await load(slug);
		if (code !== 0) break;
	}
	if (state.phase === "VERIFY") await cmdVerify([slug ? "verify" : "verify", slug]);
	state = await load(slug);
	console.log(`цикл завершён: ${state.phase}${state.result ? ` · ${state.result.status}` : ""}`);
	return 0;
}

async function cmdList(): Promise<number> {
	if (!existsSync(ROOT)) {
		console.log("целей нет");
		return 0;
	}
	for (const entry of await readdir(ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(ROOT, entry.name, "state.json");
		if (!existsSync(path)) continue;
		const state = JSON.parse(await readFile(path, "utf8")) as State;
		console.log(`${state.slug}: ${state.phase} · шаг ${state.current + 1}/${state.steps.length} · ${state.goal.slice(0, 60)}`);
	}
	return 0;
}

async function main(argv: string[]): Promise<number> {
	switch (argv[0]) {
		case "start":
			return cmdStart(argv);
		case "next":
			return cmdNext(argv);
		case "step":
			return cmdStep(argv);
		case "verify":
			return cmdVerify(argv);
		case "guard":
			return cmdGuard(argv);
		case "resume":
			return cmdResume(argv);
		case "status":
			return cmdStatus(argv);
		case "report":
			return cmdReport(argv);
		case "drive":
			return cmdDrive(argv);
		case "list":
			return cmdList();
		default:
			console.error("команды: start | next | step | guard | verify | resume | drive | status | report | list");
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(`ошибка контроллера: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	});
