/**
 * Машинное состояние приёмки — единственный источник правды для гейтов.
 *
 * Живёт в каталоге приёмки проекта: `.omp/gate/<slug>/acceptance.json`.
 * Статусы:
 *  - `verified` — приёмка подтверждена доверенным верификатором и предмет не менялся;
 *  - `pending`  — попытки ещё не исчерпаны, работу можно доделать;
 *  - `blocked`  — бюджет попыток исчерпан: успех не принимается, честный
 *                 PARTIAL/BLOCKED проходит; причина и состояние сохраняются.
 *
 * Ни один статус не выставляется по числу попыток в ответе модели и не зависит
 * от формулировки: только от результата проверки, хеша предмета и бюджета.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AcceptanceStatus = "verified" | "pending" | "blocked";

export interface Acceptance {
	schema: 1;
	project: string;
	slug: string;
	stage: "plan" | "result";
	status: AcceptanceStatus;
	attempts: number;
	budget: number;
	runId: string | null;
	subjectHash: string | null;
	taskHash: string | null;
	verifiedAt: string | null;
	reason: string;
	updatedAt: string;
}

export const DEFAULT_BUDGET = 3;

export function gateDir(project: string, slug: string): string {
	return join(project, ".omp", "gate", slug);
}

export function acceptancePath(project: string, slug: string): string {
	return join(gateDir(project, slug), "acceptance.json");
}

export function readAcceptance(project: string, slug: string): Acceptance | null {
	try {
		const raw = JSON.parse(readFileSync(acceptancePath(project, slug), "utf8")) as Acceptance;
		if (raw === null || typeof raw !== "object") return null;
		return raw;
	} catch {
		return null;
	}
}

/** Атомарная запись: сначала во временный файл, затем rename. */
export function writeAcceptance(next: Acceptance): void {
	const dir = gateDir(next.project, next.slug);
	mkdirSync(dir, { recursive: true });
	const path = acceptancePath(next.project, next.slug);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1), "utf8");
	renameSync(tmp, path);
}

export function freshAcceptance(project: string, slug: string, stage: "plan" | "result", taskHash: string | null): Acceptance {
	return {
		schema: 1,
		project,
		slug,
		stage,
		status: "pending",
		attempts: 0,
		budget: DEFAULT_BUDGET,
		runId: null,
		subjectHash: null,
		taskHash,
		verifiedAt: null,
		reason: "приёмка ещё не подтверждена",
		updatedAt: new Date().toISOString(),
	};
}

/** Отметка неудачной попытки. Исчерпание бюджета — машинное состояние, не текст. */
export function recordAttempt(project: string, slug: string, stage: "plan" | "result", reason: string): Acceptance {
	const current = readAcceptance(project, slug) ?? freshAcceptance(project, slug, stage, null);
	const attempts = current.attempts + 1;
	const next: Acceptance = {
		...current,
		stage,
		attempts,
		status: attempts >= current.budget ? "blocked" : "pending",
		reason,
		verifiedAt: null,
		updatedAt: new Date().toISOString(),
	};
	if (next.status === "blocked") next.reason = `бюджет попыток исчерпан (${attempts}/${current.budget}): ${reason}`;
	writeAcceptance(next);
	return next;
}

export function recordVerified(project: string, slug: string, data: Pick<Acceptance, "stage" | "runId" | "subjectHash" | "taskHash">, reason: string): Acceptance {
	const current = readAcceptance(project, slug);
	const next: Acceptance = {
		...(current ?? freshAcceptance(project, slug, data.stage, data.taskHash)),
		...data,
		status: "verified",
		verifiedAt: new Date().toISOString(),
		reason,
		updatedAt: new Date().toISOString(),
	};
	writeAcceptance(next);
	return next;
}

/** Есть ли право назвать работу ГОТОВО: только подтверждённая приёмка. */
export function mayClaimDone(project: string, slug: string): { ok: boolean; reason: string } {
	const state = readAcceptance(project, slug);
	if (state === null) return { ok: false, reason: "приёмка не проводилась" };
	if (state.status !== "verified") return { ok: false, reason: state.reason };
	if (state.verifiedAt === null) return { ok: false, reason: "нет отметки времени приёмки" };
	return { ok: true, reason: state.reason };
}

/** Самое свежее состояние приёмки проекта (без знания слага). */
export function latestAcceptance(project: string): Acceptance | null {
	let names: string[] = [];
	try {
		names = readdirSync(join(project, ".omp", "gate"));
	} catch {
		return null;
	}
	let best: Acceptance | null = null;
	for (const name of names) {
		const state = readAcceptance(project, name);
		if (state === null) continue;
		if (best === null || state.updatedAt > best.updatedAt) best = state;
	}
	return best;
}

/**
 * Локальное состояние — журнал, а не доказательство: файл может написать кто угодно.
 * Поэтому статус `verified` здесь НЕ даёт права на успех; решение принимает гейт
 * по свидетельству доверенного компонента (trusted-verification.proofForProject).
 */
export function mayClaimDoneAny(project: string): { ok: boolean; reason: string; slug: string | null } {
	const state = latestAcceptance(project);
	if (state === null) return { ok: false, reason: "приёмка не проводилась: нет состояния в .omp/gate", slug: null };
	return { ok: false, reason: `локальный журнал приёмки (${state.status}) доказательством не является: нужен ответ верификатора`, slug: state.slug };
}
