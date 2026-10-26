import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE = join(import.meta.dir, "autonomy.ts");
const GATE = join(import.meta.dir, "quality-gate.ts");
const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "autonomy-"));
	dirs.push(dir);
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	writeFileSync(join(dir, "readme.md"), "# проект\n");
	return dir;
}

async function run(cwd: string, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", ENGINE, ...args], {
		cwd,
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, QUALITY_GATE_KEY: join(cwd, ".key"), QUALITY_GATE_LOG: join(cwd, ".gate-log.jsonl") },
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("autonomy controller", () => {
	test("цель принимается, контекст компактный и содержит действия", async () => {
		const cwd = workspace();
		const start = await run(cwd, ["start", "g1", "--goal", "починить сборку", "--ac", "AC-01: сборка зелёная", "--step", "воспроизвести", "--step", "починить"]);
		expect(start.code).toBe(0);
		expect(start.out).toContain("ЦЕЛЬ: починить сборку");
		expect(start.out).toContain("ДОСТУПНЫЕ ДЕЙСТВИЯ");
		expect(start.out).toContain("ГРАНИЦЫ");
	});

	test("успешный шаг двигает указатель, последний шаг уводит в VERIFY", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g2", "--goal", "цель", "--step", "один"]);
		const step = await run(cwd, ["step", "g2", "--did", "сделал", "--result", "ok", "--evidence", "лог показывает успех"]);
		expect(step.code).toBe(0);
		expect(step.out).toContain("ФАЗА: VERIFY");
	});

	test("состояние переживает перезапуск: resume продолжает с того же места", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g3", "--goal", "цель", "--step", "один", "--step", "два"]);
		await run(cwd, ["step", "g3", "--did", "шаг один", "--result", "ok"]);
		// новый процесс читает состояние с диска
		const resume = await run(cwd, ["resume", "g3"]);
		expect(resume.code).toBe(0);
		expect(resume.out).toContain("ТЕКУЩИЙ ШАГ: два");
		expect(existsSync(join(cwd, ".omp", "autonomy", "g3", "state.json"))).toBe(true);
	});

	test("одинаковое действие превращается в цикл: стратегия меняется", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g4", "--goal", "цель", "--step", "шаг", "--strategy", "вторая попытка", "--max-identical", "2"]);
		await run(cwd, ["step", "g4", "--did", "bun test", "--result", "fail"]);
		const second = await run(cwd, ["step", "g4", "--did", "bun test", "--result", "fail"]);
		expect(second.out).toContain("ФАЗА: RECOVER");
		expect(second.out).toContain("вторая попытка");
	});

	test("стратегии исчерпаны → BLOCKED с остаточным риском", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g5", "--goal", "цель", "--step", "шаг", "--max-identical", "1"]);
		const blocked = await run(cwd, ["step", "g5", "--did", "bun test", "--result", "fail"]);
		expect(blocked.out).toContain("ФАЗА: BLOCKED");
		const report = await run(cwd, ["report", "g5"]);
		expect(report.out).toContain("RESIDUAL: шаг");
		expect(report.out).toContain("снимается");
	});

	test("опасное действие без подтверждения блокируется, с подтверждением проходит", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g6", "--goal", "цель", "--step", "шаг"]);
		const denied = await run(cwd, ["step", "g6", "--did", "git reset --hard origin/master", "--result", "ok"]);
		expect(denied.code).toBe(1);
		expect(denied.err).toContain("ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ");
		const forbidden = await run(cwd, ["step", "g6", "--did", "rm -rf / --no-preserve-root", "--result", "ok"]);
		expect(forbidden.code).toBe(3);
		expect(forbidden.err).toContain("ЗАПРЕЩЕНО политикой");
		expect(forbidden.err).toContain("граница полномочий");
		const approved = await run(cwd, ["step", "g6", "--did", "git reset --hard origin/master", "--result", "ok", "--approve", "владелец разрешил откат"]);
		expect(approved.code).toBe(0);
		const report = await run(cwd, ["report", "g6"]);
		expect(report.out).toContain("ПОДТВЕРЖДЕНИЯ: 1");
	});

	test("VERIFY опирается на сертификат quality-gate, а не на слова", async () => {
		const cwd = workspace();
		Bun.spawnSync(["git", "add", "."], { cwd });
		Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
		const gateRun = (args: string[]) =>
			Bun.spawnSync(["bun", GATE, ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, QUALITY_GATE_KEY: join(cwd, ".key"), QUALITY_GATE_LOG: join(cwd, ".gate-log.jsonl") },
			});
		gateRun(["init", "ver", "--task", "цель", "--ac", "AC-01: файл на месте", "--check", "файл::test -f readme.md", "--covers", "файл=AC-01", "--residual-none", "охват — файл"]);
		gateRun(["run", "ver"]);
		gateRun(["review", "ver", "--by", "reviewer", "--verdict", "PASS", "--note", "проверил"]);
		await run(cwd, ["start", "g7", "--goal", "цель", "--step", "шаг", "--gate", "ver"]);
		await run(cwd, ["step", "g7", "--did", "сделал", "--result", "ok"]);
		const verify = await run(cwd, ["verify", "g7"]);
		expect(verify.code).toBe(0);
		expect(verify.out).toContain("RESULT: ГОТОВО");
	});

	test("VERIFY без контракта уводит в RECOVER, а не в успех", async () => {
		const cwd = workspace();
		await run(cwd, ["start", "g8", "--goal", "цель", "--step", "шаг"]);
		await run(cwd, ["step", "g8", "--did", "сделал", "--result", "ok"]);
		const verify = await run(cwd, ["verify", "g8"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("VERIFY невозможен без контракта");
	});

	test("drive ведёт цикл сам и останавливается на блокере", async () => {
		const cwd = workspace();
		const driver = join(cwd, "driver.sh");
		writeFileSync(driver, '#!/bin/bash\ncat >/dev/null\necho "STEP: попытка через альтернативу"\necho "RESULT: fail"\necho "EVIDENCE: драйверу нечем проверять"\n');
		await run(cwd, ["start", "g9", "--goal", "цель", "--step", "шаг", "--max-identical", "1"]);
		const drive = await run(cwd, ["drive", "g9", "--driver", `bash ${driver}`]);
		expect(drive.code).toBe(0);
		expect(drive.out).toContain("цикл завершён: BLOCKED");
	});
});
