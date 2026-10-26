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
		writeFileSync(join(cwd, "config.txt"), "password: '" + ("superSecret" + "Value123") + "'\n");
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

	test("самопроверка не считается независимой", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "self", "--task", "само", "--risk", "high", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "self"]);
		const denied = await gate(cwd, ["review", "self", "--by", "self", "--verdict", "PASS", "--note", "я проверил"]);
		expect(denied.code).toBe(2);
		expect(denied.err).toContain("не считается независимым ревьюером");
		const verify = await gate(cwd, ["verify", "self"]);
		expect(verify.code).toBe(1);
	});

	test("провал ревьюера не отмывается повторным прогоном", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "wash", "--task", "отмывание", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "wash"]);
		await gate(cwd, ["review", "wash", "--by", "reviewer", "--verdict", "FAIL", "--note", "нашёл дыру"]);
		const rerun = await gate(cwd, ["run", "wash"]);
		expect(rerun.code).toBe(1);
		const verify = await gate(cwd, ["verify", "wash"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("FAIL");
	});

	test("рукописный сертификат без логов проверок не проходит verify", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "fake", "--task", "фейк", "--ac", "AC-01: x", "--check", "истина::true"]);
		const dir = join(cwd, ".omp", "gate", "fake");
		writeFileSync(
			join(dir, "certificate.json"),
			JSON.stringify({
				slug: "fake",
				task: "фейк",
				risk: "high",
				certifiedAt: new Date().toISOString(),
				criteria: [{ id: "AC-01", text: "x" }],
				baseline: {},
				checks: [{ name: "ложь", cmd: "true", blocking: true, exitCode: 0, durationMs: 1, stdoutTail: "", stderrTail: "", ok: true, logFile: ".omp/gate/fake/logs/нет.log" }],
				probes: [],
				invariants: [{ name: "секреты не в диффе", ok: true, detail: "ok" }],
				after: {},
				regression: [],
				review: { by: "reviewer", independent: true, verdict: "PASS", note: "ok", at: new Date().toISOString() },
				residual: [],
				status: "ГОТОВО",
			}),
		);
		const verify = await gate(cwd, ["verify", "fake"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("логи проверок");
	});

	test("собственный таймаут проверки соблюдается и провал не теряется", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "slow", "--task", "медленно", "--ac", "AC-01: x", "--check", "pipe::sleep 60 | cat", "--timeout", "2"]);
		const started = Date.now();
		const run = await gate(cwd, ["run", "slow"]);
		const elapsed = Date.now() - started;
		expect(run.code).toBe(1);
		expect(elapsed).toBeLessThan(20_000);
		expect(run.out).toContain("статус FAILED");
	}, 40_000);

	test("секрет в новом файле больше 2 МиБ помечается как непроверенный", async () => {
		const cwd = repo();
		const fakeKey = "AKIA" + "ABCDEFGHIJKLMNOP"; // собираем из частей: литерал в диффе выглядел бы настоящим ключом
		const big = "x".repeat(2 * 1024 * 1024 + 10) + fakeKey;
		writeFileSync(join(cwd, "big.txt"), big);
		await gate(cwd, ["init", "big", "--task", "большой", "--ac", "AC-01: x", "--check", "истина::true"]);
		const run = await gate(cwd, ["run", "big"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("не проверено полностью");
	});

	test("необратимая git-команда в объявленной проверке нарушает инвариант", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "destr", "--task", "опасно", "--ac", "AC-01: x", "--check", "сброс::git reset --hard"]);
		const run = await gate(cwd, ["run", "destr"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("в проверках нет необратимых git-команд → НАРУШЕН");
	});

	test("«--by автор» не проходит: независимость по белому списку", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "byавтор", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "byавтор"]);
		const denied = await gate(cwd, ["review", "byавтор", "--by", "автор", "--verdict", "PASS", "--note", "я"]);
		expect(denied.code).toBe(2);
		expect(denied.err).toContain("не считается независимым");
	});

	test("FAIL нельзя перекрыть молча: нужен --supersede", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "sup", "--task", "t", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "sup"]);
		await gate(cwd, ["review", "sup", "--by", "reviewer", "--verdict", "FAIL", "--note", "дыра"]);
		const silent = await gate(cwd, ["review", "sup", "--by", "reviewer", "--verdict", "PASS", "--note", "передумал"]);
		expect(silent.code).toBe(2);
		expect(silent.err).toContain("--supersede");
		const explicit = await gate(cwd, ["review", "sup", "--by", "reviewer", "--verdict", "PASS", "--supersede", "--note", "дыру закрыл, перепроверил"]);
		expect(explicit.code).toBe(0);
	});

	test("лог проверки обязан содержать свою команду и код выхода", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "logs", "--task", "t", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "logs"]);
		const certPath = join(cwd, ".omp", "gate", "logs", "certificate.json");
		const cert = JSON.parse(await Bun.file(certPath).text());
		const logPath = join(cwd, cert.checks[0].logFile);
		await Bun.write(logPath, "подмена: пустой файл вместо вывода\n");
		const verify = await gate(cwd, ["verify", "logs"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("лог не соответствует команде");
	});

	test("похожие имена проверок получают разные логи", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "dup", "--task", "t", "--ac", "AC-01: x", "--check", "a b::echo FIRST", "--check", "a_b::echo SECOND"]);
		await gate(cwd, ["run", "dup"]);
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "dup", "certificate.json")).text());
		const files = cert.checks.map((check: { logFile: string }) => check.logFile);
		expect(new Set(files).size).toBe(2);
		const first = await Bun.file(join(cwd, files[0])).text();
		expect(first).toContain("FIRST");
	});

	test("subagent:self тоже не независим", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "subself", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "subself"]);
		const denied = await gate(cwd, ["review", "subself", "--by", "subagent:self", "--verdict", "PASS", "--note", "я"]);
		expect(denied.code).toBe(2);
	});

	test("подделка спавн-метки «omp -p …» не проходит", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "fake-spawn", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "fake-spawn"]);
		const denied = await gate(cwd, ["review", "fake-spawn", "--by", "omp -p self", "--verdict", "PASS", "--note", "я"]);
		expect(denied.code).toBe(2);
	});

	test("verify видит стоящий FAIL в истории reviews[]", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "hist", "--task", "t", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "hist"]);
		await gate(cwd, ["review", "hist", "--by", "reviewer", "--verdict", "FAIL", "--note", "дыра"]);
		const certPath = join(cwd, ".omp", "gate", "hist", "certificate.json");
		const cert = JSON.parse(await Bun.file(certPath).text());
		cert.review = { ...cert.reviews[0], verdict: "PASS" };
		cert.reviews = [...cert.reviews, cert.review];
		cert.status = "PARTIAL";
		await Bun.write(certPath, JSON.stringify(cert));
		const verify = await gate(cwd, ["verify", "hist"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("FAIL без явного --supersede");
	});

	test("несогласованный ok/exitCode в сертификате не проходит verify", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "incons", "--task", "t", "--ac", "AC-01: x", "--check", "истина::true"]);
		await gate(cwd, ["run", "incons"]);
		const certPath = join(cwd, ".omp", "gate", "incons", "certificate.json");
		const cert = JSON.parse(await Bun.file(certPath).text());
		cert.checks[0].exitCode = 1;
		cert.checks[0].ok = true;
		await Bun.write(certPath, JSON.stringify(cert));
		const verify = await gate(cwd, ["verify", "incons"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("ok не совпадает с кодом выхода");
	});

	test("битый сертификат даёт вердикт, а не исключение", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "broken", "--task", "t", "--ac", "AC-01: x", "--check", "истина::true"]);
		const dir = join(cwd, ".omp", "gate", "broken");
		writeFileSync(join(dir, "certificate.json"), JSON.stringify({ slug: "broken", status: "ГОТОВО" }));
		const verify = await gate(cwd, ["verify", "broken"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("сертификат повреждён");
	});
});
