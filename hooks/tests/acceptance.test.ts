/**
 * Регрессия на обходы приёмки: поддельный PASS, изменение предмета после ревью,
 * чужой проект, недоступный верификатор, исчерпание бюджета, расхождение
 * идентификаторов сессии, старый результат todo, пустой план.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { freshAcceptance, mayClaimDoneAny, readAcceptance, recordAttempt, recordVerified, writeAcceptance } from "../lib/gate-state.ts";
import { materialsDigest, verifyAcceptance } from "../lib/trusted-verification.ts";

const RUNS = join(homedir(), ".omp", "goldfish", "runs");
const PROJECT = "/tmp/omp-acceptance-project";
const SLUG = "probe";

const seedRun = (name: string, materials: string[], verdict = "PASS"): void => {
	const dir = join(RUNS, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), JSON.stringify({ stage: "result", verdict, finishedAt: new Date().toISOString() }));
	writeFileSync(join(dir, "packet.json"), JSON.stringify({ materials, task: "задача" }));
};
const seedRunWithTask = (name: string, materials: string[], task: string): void => {
	const dir = join(RUNS, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), JSON.stringify({ stage: "result", verdict: "PASS", finishedAt: new Date().toISOString() }));
	writeFileSync(join(dir, "packet.json"), JSON.stringify({ materials, task }));
};

const seedGate = (): void => {
	mkdirSync(join(PROJECT, ".omp", "gate", SLUG), { recursive: true });
	writeFileSync(join(PROJECT, ".omp", "gate", SLUG, "certificate.json"), JSON.stringify({ schema: 1, verdict: "PASS" }));
};
const cleanup = (): void => {
	rmSync(PROJECT, { recursive: true, force: true });
	for (const name of ["acc-probe-1", "acc-probe-2", "acc-probe-3"]) rmSync(join(RUNS, name), { recursive: true, force: true });
};

beforeEach(cleanup);
afterAll(cleanup);

describe("доверенная проверка", () => {
	test("поддельный ручной сертификат отклоняется: демон требует аттестацию", async () => {
		seedGate();
		seedRun("acc-probe-1", [join(PROJECT, "a.ts")]);
		writeFileSync(join(PROJECT, "a.ts"), "export const a = 1;\n");
		const result = await verifyAcceptance(PROJECT, "result", [join(PROJECT, "a.ts")]);
		expect(result.ok).toBe(false);
		// Демон доступен и отвечает: рукописный сертификат без его подписи не годится.
		expect(result.reason).toMatch(/аттестац|подпис|недоступен|не подтверждено/);
	});

	test("чужой прогон (материалы вне проекта) не принимается", async () => {
		seedGate();
		seedRun("acc-probe-2", ["/different-project/app.ts"]);
		const result = await verifyAcceptance(PROJECT, "result", [join(PROJECT, "a.ts")]);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("нет PASS-прогона");
	});

	test("без сертификата проекта одобрения нет", async () => {
		mkdirSync(PROJECT, { recursive: true });
		writeFileSync(join(PROJECT, "a.ts"), "x");
		seedRun("acc-probe-3", [join(PROJECT, "a.ts")]);
		const result = await verifyAcceptance(PROJECT, "result", [join(PROJECT, "a.ts")]);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("сертификат");
	});

	test("правка файла меняет хеш предмета", () => {
		mkdirSync(PROJECT, { recursive: true });
		const path = join(PROJECT, "a.ts");
		writeFileSync(path, "v1");
		const before = materialsDigest([path]);
		writeFileSync(path, "v2");
		expect(materialsDigest([path])).not.toBe(before);
	});
});

describe("машинное состояние приёмки", () => {
	test("успех не появляется от числа попыток", () => {
		mkdirSync(PROJECT, { recursive: true });
		expect(mayClaimDoneAny(PROJECT).ok).toBe(false);
		recordAttempt(PROJECT, SLUG, "result", "нет проверки");
		recordAttempt(PROJECT, SLUG, "result", "нет проверки");
		expect(mayClaimDoneAny(PROJECT).ok).toBe(false);
		const blocked = recordAttempt(PROJECT, SLUG, "result", "нет проверки");
		expect(blocked.status).toBe("blocked");
		expect(mayClaimDoneAny(PROJECT).ok).toBe(false);
		expect(readAcceptance(PROJECT, SLUG)?.status).toBe("blocked");
	});

	test("рукописный журнал приёмки не разрешает успех", () => {
		mkdirSync(PROJECT, { recursive: true });
		writeAcceptance({ ...freshAcceptance(PROJECT, SLUG, "result", "task-1"), status: "verified", verifiedAt: new Date().toISOString(), subjectHash: "hash-1", runId: "run-1" });
		// Раньше это давало право на ГОТОВО: файл писал кто угодно.
		expect(mayClaimDoneAny(PROJECT).ok).toBe(false);
		expect(readAcceptance(PROJECT, SLUG)?.status).toBe("verified");
	});

	test("свидетельство нельзя подделать объектом", async () => {
		const { isAcceptanceProof } = await import("../lib/trusted-verification.ts");
		expect(isAcceptanceProof({ ok: true, runId: "run-1", subjectHash: "x" })).toBe(false);
		expect(isAcceptanceProof(JSON.parse('{"ok":true,"verified":true}'))).toBe(false);
		expect(isAcceptanceProof(null)).toBe(false);
	});
});

const GATE_PROJECT = join(homedir(), "OMP", "omp-acceptance-probe");

describe("стоп-гейт принимает успех только по подтверждённой приёмке", () => {
	afterAll(() => rmSync(GATE_PROJECT, { recursive: true, force: true }));
	const runGate = async (project: string, text: string, worked = false) => {
		const mod = await import("../pre/grandmaster-stop-gate.ts");
		const handled: Record<string, Array<(...a: unknown[]) => unknown>> = {};
		(mod as { default: (pi: unknown) => void }).default({ on: (e: string, f: (...a: unknown[]) => unknown) => { (handled[e] ??= []).push(f); } });
		const ctx = { cwd: project };
		const event = {
			session_id: `gate-${Math.random()}`,
			last_assistant_message: text,
			// Приёмка требуется только для работы с изменениями: фикстура должна
			// содержать правку, иначе правило по замыслу не применяется.
			messages: worked ? [{ role: "assistant", content: [{ type: "toolCall", toolName: "edit" }] }] : [],
		};
		return (await handled.session_stop[0](event, ctx)) as { decision?: string; reason?: string } | undefined;
	};

	test("ГОТОВО без приёмки блокируется с причиной", async () => {
		mkdirSync(GATE_PROJECT, { recursive: true });
		const result = await runGate(GATE_PROJECT, "Сделал.\nСТАТУС: ГОТОВО", true);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("ПРИЁМКА");
	});

	test("честный PARTIAL проходит", async () => {
		mkdirSync(GATE_PROJECT, { recursive: true });
		const result = await runGate(
			GATE_PROJECT,
			"БЛОКЕР: приёмка не подтверждена\nПРОБОВАЛ: прогон проверки → нет сертификата\nСТАТУС: PARTIAL",
		);
		expect(result?.decision).not.toBe("block");
	});
});

describe("свидетельство привязано к задаче", () => {
	test("прогон другой задачи не подтверждает эту", async () => {
		const { proofForProject } = await import("../lib/trusted-verification.ts");
		mkdirSync(PROJECT, { recursive: true });
		writeFileSync(join(PROJECT, "a.ts"), "x");
		seedGate();
		seedRunWithTask("acc-probe-task", [join(PROJECT, "a.ts")], "задача А");
		const same = await proofForProject(PROJECT, "result", "задача А");
		const other = await proofForProject(PROJECT, "result", "задача Б");
		// Сертификат проекта один и тот же, но прогон относится только к задаче А.
		expect(other.proof).toBeNull();
		expect(other.reason).toMatch(/другой задаче|нет PASS-прогона/);
		expect(same.proof === null ? same.reason : "").not.toContain("другой задаче");
		rmSync(join(RUNS, "acc-probe-task"), { recursive: true, force: true });
	});
});
