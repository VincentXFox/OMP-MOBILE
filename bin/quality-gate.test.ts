import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "quality-gate.ts");
const dirs: string[] = [];

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "qgate-"));
	dirs.push(dir);
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd: dir });
	Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: dir });
	writeFileSync(join(dir, "readme.md"), "# repo\n");
	Bun.spawnSync(["git", "add", "."], { cwd: dir });
	Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

async function gate(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", GATE, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

beforeAll(() => {
	// общий прогрев bun — первый запуск в темпе медленнее, это не влияет на логику
});

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("quality-gate", () => {
	test("контракт, прогон и отчёт на проходящих проверках", async () => {
		const cwd = repo();
		const init = await gate(cwd, [
			"init",
			"ok",
			"--task",
			"проверка движка",
			"--ac",
			"AC-01: файл создаётся",
			"--ac",
			"AC-02: тест проходит",
			"--check",
			"эхо::test -f readme.md",
			"--check",
			"истина::true",
		]);
		expect(init.code).toBe(0);
		const run = await gate(cwd, ["run", "ok"]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("EVIDENCE [эхо]");
		expect(run.out).toContain("CONTRACT: AC-01 файл создаётся; AC-02 тест проходит");
		expect(run.out).toContain("INVARIANTS: секреты не в диффе → соблюдён");
		const verify = await gate(cwd, ["verify", "ok"]);
		expect(verify.code).toBe(0);
	});

	test("провал блокирующей проверки даёт FAILED и код 1", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "bad", "--task", "провал", "--ac", "AC-01: что-то", "--check", "ложь::false"]);
		const run = await gate(cwd, ["run", "bad"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("статус FAILED");
		const verify = await gate(cwd, ["verify", "bad"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("проваленные блокирующие проверки");
	});

	test("секрет в диффе нарушает инвариант", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, "config.txt"), "password: 'superSecretValue123'\n");
		await gate(cwd, ["init", "secret", "--task", "секрет", "--ac", "AC-01: x", "--check", "истина::true"]);
		const run = await gate(cwd, ["run", "secret"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("НАРУШЕН");
		expect(run.out).toContain("password literal");
	});

	test("рискованная работа без независимой проверки не проходит verify", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "risk", "--task", "риск", "--risk", "high", "--ac", "AC-01: службы живы", "--check", "истина::true"]);
		await gate(cwd, ["run", "risk"]);
		const before = await gate(cwd, ["verify", "risk"]);
		expect(before.code).toBe(1);
		expect(before.err).toContain("независимая проверка");
		const review = await gate(cwd, ["review", "risk", "--by", "reviewer", "--verdict", "PASS", "--note", "перепроверил выводы"]);
		expect(review.code).toBe(0);
		const after = await gate(cwd, ["verify", "risk"]);
		expect(after.code).toBe(0);
	});

	test("вердикт FAIL переводит сертификат в FAILED", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "rev", "--task", "ревью", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "rev"]);
		const review = await gate(cwd, ["review", "rev", "--by", "reviewer", "--verdict", "FAIL", "--note", "нашёл дыру"]);
		expect(review.code).toBe(1);
		const verify = await gate(cwd, ["verify", "rev"]);
		expect(verify.code).toBe(1);
	});

	test("контракт без критериев отвергается", async () => {
		const cwd = repo();
		const init = await gate(cwd, ["init", "empty", "--task", "пусто"]);
		expect(init.code).toBe(2);
		expect(init.err).toContain("нужен хотя бы один --ac");
	});
});
