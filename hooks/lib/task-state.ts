/**
 * Устойчивое состояние задачи. Живёт вне сессии и процесса: переживает окончание
 * ответа, смену исполнителя и перезапуск OMP. Один реестр на проект — параллельных
 * статусов нет.
 *
 * Ключевое различие: «исполнитель закончил ответ» ≠ «задача закрыта».
 * PARTIAL/BLOCKED описывают промежуточный результат и переводят задачу в
 * needs-fix / awaiting-external, а не в «закрыта».
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./lock.ts";

export type TaskStatus = "open" | "needs-fix" | "awaiting-external" | "verified" | "cancelled";

export interface TaskState {
	schema: 1;
	/** Исходная цель: не подменяется последней технической ошибкой. */
	goal: string;
	criteria: string[];
	stage: string;
	open: string[];
	status: TaskStatus;
	attempts: number;
	findings: string[];
	/** Условие продолжения для awaiting-external. */
	waitingFor: string | null;
	updatedAt: string;
}

export function taskStatePath(project: string): string {
	return join(project, ".omp", "task-state.json");
}

export function readTaskState(project: string): TaskState | null {
	try {
		const raw = JSON.parse(readFileSync(taskStatePath(project), "utf8")) as TaskState;
		return raw !== null && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

export function writeTaskState(project: string, state: TaskState): void {
	const path = taskStatePath(project);
	mkdirSync(join(project, ".omp"), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
	renameSync(tmp, path);
}

/** Изменение состояния под межпроцессным замком: параллельные задачи не смешиваются. */
export async function mutateTaskState<T>(project: string, fn: (state: TaskState) => T | Promise<T>): Promise<T> {
	return withFileLock(`${taskStatePath(project)}.lock`, async () => {
		const current = readTaskState(project) ?? {
			schema: 1 as const,
			goal: "",
			criteria: [],
			stage: "работа",
			open: [],
			status: "open" as TaskStatus,
			attempts: 0,
			findings: [],
			waitingFor: null,
			updatedAt: new Date().toISOString(),
		};
		const result = await fn(current);
		current.updatedAt = new Date().toISOString();
		writeTaskState(project, current);
		return result;
	});
}

/** Задача ещё требует работы: только в этом состоянии исполнитель обязан продолжать. */
export function requiresWork(state: TaskState | null): boolean {
	if (state === null) return false;
	return state.status === "open" || state.status === "needs-fix";
}

/** Продолжение допустимо без участия владельца. */
export function mayContinueWithoutOwner(state: TaskState | null): boolean {
	if (state === null) return true;
	return state.status !== "awaiting-external" && state.status !== "cancelled";
}
