/**
 * Автономность: PARTIAL не закрывает задачу, лимит повторов не отдаёт её владельцу.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mayContinueWithoutOwner, mutateTaskState, readTaskState, requiresWork } from "../lib/task-state.ts";

const P = join(tmpdir(), `task-state-${process.pid}`);
afterAll(() => rmSync(P, { recursive: true, force: true }));

test("задача переживает окончание ответа: состояние на диске", async () => {
	mkdirSync(P, { recursive: true });
	await mutateTaskState(P, (s) => {
		s.goal = "починить парсер и подтвердить тестом";
		s.criteria = ["AC-01: тест зелёный"];
		s.open = ["исправить парсер"];
		s.status = "needs-fix";
	});
	// новый «процесс»: читаем только с диска
	const fresh = readTaskState(P);
	expect(fresh?.goal).toContain("починить парсер");
	expect(fresh?.criteria).toEqual(["AC-01: тест зелёный"]);
	expect(requiresWork(fresh)).toBe(true);
	expect(mayContinueWithoutOwner(fresh)).toBe(true);
});

test("PARTIAL не закрывает задачу и не переводит её в ожидание владельца", async () => {
	await mutateTaskState(P, (s) => {
		s.status = "needs-fix";
		s.attempts += 1;
		s.findings = ["тест упал: ожидалось 2, получено 1"];
	});
	const state = readTaskState(P);
	expect(state?.status).toBe("needs-fix");
	expect(requiresWork(state)).toBe(true);
	expect(mayContinueWithoutOwner(state)).toBe(true);
	expect(state?.findings?.[0]).toContain("тест упал");
});

test("явная отмена владельца останавливает задачу", async () => {
	await mutateTaskState(P, (s) => {
		s.status = "cancelled";
	});
	expect(mayContinueWithoutOwner(readTaskState(P))).toBe(false);
});

test("ожидание внешнего условия фиксирует условие продолжения", async () => {
	await mutateTaskState(P, (s) => {
		s.status = "awaiting-external";
		s.waitingFor = "доступ к устройству";
	});
	const state = readTaskState(P);
	expect(state?.waitingFor).toBe("доступ к устройству");
	expect(requiresWork(state)).toBe(false);
	expect(mayContinueWithoutOwner(state)).toBe(false);
});
