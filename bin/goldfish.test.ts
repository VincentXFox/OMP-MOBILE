/**
 * Тесты Goldfish: соразмерность, пакет, разбор вердикта, свежесть, привязка к проекту.
 *
 * Что здесь проверяется: детерминированные части механизма (без вызова модели).
 * Живой прогон проверяющего — отдельный сценарий, он требует модели и потому
 * вынесен в отчёт, а не в этот файл.
 *
 * Запуск: bun test ~/omp-mobile/bin/goldfish.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPacket, finalVerdict, freshPass, loadRuns, parseVerdict, publishRun, appendJournal, type GoldfishRun } from "./goldfish.ts";
import { classify } from "./goldfish-policy.ts";

const sandbox = (): string => mkdtempSync(join(tmpdir(), "gf-test-"));

describe("соразмерность проверки", () => {
	test("тривиальное общение не требует проверки", () => {
		expect(classify({ prompt: "спасибо", tools: [], paths: [], steps: 1 }).tier).toBe("none");
		expect(classify({ prompt: "ответь одним словом", tools: [], paths: [], steps: 0 }).tier).toBe("none");
	});

	test("изменения кода — стандартный уровень с проверкой результата", () => {
		const policy = classify({ prompt: "поправь функцию sum в sum.ts", tools: ["edit"], paths: ["proj/sum.ts"], steps: 5 });
		expect(policy.tier).toBe("standard");
		expect(policy.resultReview).toBe(true);
		expect(policy.attestation).toBe(false);
	});

	test("прод, сеть и доступы — усиленный уровень с аттестацией", () => {
		const policy = classify({ prompt: "поправь nginx на srv78 и открой порт", tools: ["edit", "bash"], paths: ["/etc/nginx/x.conf"], steps: 12 });
		expect(policy.tier).toBe("enhanced");
		expect(policy.planReview).toBe(true);
		expect(policy.attestation).toBe(true);
		expect(policy.reviewers).toBe(2);
	});

	test("исследование без правок — лёгкий уровень без обязательной проверки", () => {
		expect(classify({ prompt: "изучи, как устроен роутер", tools: ["read"], paths: [], steps: 4 }).tier).toBe("light");
	});
});

describe("пакет фактов", () => {
	test("пакет содержит задачу, критерии, план и результат", () => {
		const packet = buildPacket({ stage: "result", task: "починить сумму", criteria: "sum(2,3)=5", plan: "поменять знак", result: "знак поменян", materials: [] });
		expect(packet.text).toContain("починить сумму");
		expect(packet.text).toContain("sum(2,3)=5");
		expect(packet.text).toContain("поменять знак");
		expect(packet.text).toContain("знак поменян");
		expect(packet.text).toContain("Что не передано");
	});

	test("хеш пакета меняется вместе с текстом работы", () => {
		const a = buildPacket({ stage: "result", task: "задача", result: "результат А", materials: [] });
		const b = buildPacket({ stage: "result", task: "задача", result: "результат Б", materials: [] });
		expect(a.hash).not.toBe(b.hash);
		expect(a.subjectHash).not.toBe(b.subjectHash);
	});

	test("хеш предмета меняется при правке материала", () => {
		const dir = sandbox();
		const file = join(dir, "code.ts");
		writeFileSync(file, "export const a = 1;\n", "utf8");
		const before = buildPacket({ stage: "result", task: "т", materials: [file] }).subjectHash;
		writeFileSync(file, "export const a = 2;\n", "utf8");
		const after = buildPacket({ stage: "result", task: "т", materials: [file] }).subjectHash;
		rmSync(dir, { recursive: true, force: true });
		expect(before).not.toBe(after);
	});
});

describe("разбор ответа проверяющего", () => {
	test("корректный вердикт разбирается с замечаниями", () => {
		const parsed = parseVerdict('{"verdict":"NEEDS-FIX","findings":[{"severity":"critical","text":"нет проверки","ref":"plan.md:3"}],"unverified":["влияние на прод"]}');
		expect(parsed?.verdict).toBe("NEEDS-FIX");
		expect(parsed?.findings[0]?.id).toBe("GF-1");
		expect(parsed?.findings[0]?.severity).toBe("critical");
		expect(parsed?.unverified[0]).toContain("прод");
	});

	test("пустой, битый и оборванный ответ не принимается", () => {
		expect(parseVerdict("")).toBeNull();
		expect(parseVerdict("никакого json здесь нет")).toBeNull();
		expect(parseVerdict('{"verdict":"PAS')).toBeNull();
		expect(parseVerdict('{"verdict":"MAYBE"}')).toBeNull();
	});

	test("таймаут и пустой вывод дают ERROR, а не PASS", () => {
		expect(finalVerdict(null)).toBe("ERROR");
	});

	test("PASS с критичным замечанием понижается до NEEDS-FIX", () => {
		const parsed = parseVerdict('{"verdict":"PASS","findings":[{"severity":"critical","text":"доказательство подменяет поведение"}]}');
		expect(finalVerdict(parsed)).toBe("NEEDS-FIX");
	});

	test("PASS без критичных замечаний остаётся PASS", () => {
		const parsed = parseVerdict('{"verdict":"PASS","findings":[{"severity":"minor","text":"мелочь"}]}');
		expect(finalVerdict(parsed)).toBe("PASS");
	});
});

describe("свежесть и привязка к проекту", () => {
	const run = (over: Partial<GoldfishRun> = {}): GoldfishRun => ({
		schema: 1,
		runId: "gf-test-1",
		taskId: "t",
		stage: "result",
		verdict: "PASS",
		packetHash: "p",
		subjectHash: "s",
		runner: { kind: "spawn", command: "omp", model: null, exitCode: 0, timedOut: false, attempts: 1, isolation: "тест" },
		findings: [],
		unverified: [],
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		tookMs: 1,
		dir: "/tmp",
		...over,
	});

	test("запись вне проекта не считается проверкой (подделка JSON не проходит)", () => {
		const dir = sandbox();
		mkdirSync(join(dir, ".omp", "gate", "slug"), { recursive: true });
		expect(freshPass([run()], "result", "s", { projectDir: dir })).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	test("опубликованная запись признаётся свежей", () => {
		const dir = sandbox();
		const published = publishRun(run(), dir, "slug");
		expect(published).not.toBeNull();
		expect(existsSync(published ?? "")).toBe(true);
		expect(freshPass([run()], "result", "s", { projectDir: dir })?.runId).toBe("gf-test-1");
		rmSync(dir, { recursive: true, force: true });
	});

	test("изменение предмета инвалидирует проверку", () => {
		const dir = sandbox();
		publishRun(run(), dir, "slug");
		expect(freshPass([run()], "result", "другой-хеш", { projectDir: dir })).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	test("чужой вердикт (NEEDS-FIX) не считается проверкой", () => {
		const dir = sandbox();
		publishRun(run({ verdict: "NEEDS-FIX" }), dir, "slug");
		expect(freshPass([run({ verdict: "NEEDS-FIX" })], "result", "s", { projectDir: dir })).toBeNull();
		rmSync(dir, { recursive: true, force: true });
	});

	test("для обязательного уровня требуется аттестация", () => {
		const dir = sandbox();
		publishRun(run(), dir, "slug");
		expect(freshPass([run()], "result", "s", { projectDir: dir, requireAttestation: true })).toBeNull();
		expect(freshPass([run({ attestation: { by: "omp-verifier", at: "now", mac: "x" } })], "result", "s", { projectDir: dir, requireAttestation: true })?.runId).toBe("gf-test-1");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("журнал доказательств", () => {
	test("запись попадает в журнал без секретов", () => {
		const dir = sandbox();
		const journal = join(dir, "evidence.jsonl");
		appendJournal({ kind: "test", runId: "gf-j", verdict: "PASS" }, journal);
		const body = readFileSync(journal, "utf8");
		expect(body).toContain("gf-j");
		expect(body).not.toContain("sk-");
		rmSync(dir, { recursive: true, force: true });
	});
});
