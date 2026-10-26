import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTONOMY = join(import.meta.dir, "autonomy.ts");
const WATCHDOG = join(import.meta.dir, "watchdog.ts");
const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "chaos-"));
	dirs.push(dir);
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	writeFileSync(join(dir, "readme.md"), "# проект\n");
	return dir;
}

async function run(cwd: string, bin: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("chaos: устойчивость контроллера", () => {
	test("битый state.json не перетирается молча — понятная ошибка", async () => {
		const cwd = workspace();
		await run(cwd, AUTONOMY, ["start", "c1", "--goal", "цель", "--step", "шаг"]);
		const statePath = join(cwd, ".omp", "autonomy", "c1", "state.json");
		writeFileSync(statePath, "{ это не json");
		const resume = await run(cwd, AUTONOMY, ["resume", "c1"]);
		expect(resume.code).not.toBe(0);
		expect(resume.err).toContain("ошибка контроллера");
		// файл не должен быть перезаписан «на всякий случай»
		expect(readFileSync(statePath, "utf8")).toBe("{ это не json");
	});

	test("остаток незавершённой записи не мешает продолжить", async () => {
		const cwd = workspace();
		await run(cwd, AUTONOMY, ["start", "c2", "--goal", "цель", "--step", "шаг"]);
		mkdirSync(join(cwd, ".omp", "autonomy", "c2"), { recursive: true });
		writeFileSync(join(cwd, ".omp", "autonomy", "c2", "state.json.tmp"), "мусор от убитого процесса");
		const resume = await run(cwd, AUTONOMY, ["resume", "c2"]);
		expect(resume.code).toBe(0);
		expect(resume.out).toContain("ТЕКУЩИЙ ШАГ: шаг");
	});

	test("лимит времени останавливает работу в BLOCKED", async () => {
		const cwd = workspace();
		await run(cwd, AUTONOMY, ["start", "c3", "--goal", "цель", "--step", "шаг", "--max-minutes", "0"]);
		const step = await run(cwd, AUTONOMY, ["step", "c3", "--did", "bun test", "--result", "ok"]);
		expect(step.code).toBe(1);
		expect(step.err).toContain("ресурсный лимит");
		const report = await run(cwd, AUTONOMY, ["report", "c3"]);
		expect(report.out).toContain("BLOCKED");
		expect(report.out).toContain("RESIDUAL");
	});

	test("наблюдатель не создаёт сертификатов и не выдаёт PASS", async () => {
		const cwd = workspace();
		const watchdog = await run(cwd, WATCHDOG, []);
		// шлюз может быть недоступен в песочнице — важно, что наблюдатель не пишет в .omp/gate
		expect([0, 1]).toContain(watchdog.code);
		expect(require("node:fs").existsSync(join(cwd, ".omp", "gate"))).toBe(false);
		expect(watchdog.out).not.toContain("PASS");
	});
});
