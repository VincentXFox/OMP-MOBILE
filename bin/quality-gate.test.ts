import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function gate(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", GATE, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, QUALITY_GATE_KEY: join(cwd, ".key"), QUALITY_GATE_LOG: join(cwd, ".gate-log.jsonl"), ...extraEnv },
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

/**
 * Фейковый ревьюер: подменяет `omp` в PATH, чтобы проверять разбор вердикта
 * без сети и без модели. Возвращает переменные окружения для gate().
 */
function fakeReviewer(cwd: string, body: string): Record<string, string> {
	const bin = join(cwd, ".fake-bin");
	Bun.spawnSync(["mkdir", "-p", bin]);
	writeFileSync(join(bin, "omp"), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

/** Быстрый PASS-ревьюер: печатает вердикт и NOTE. */
function passingReviewer(cwd: string, note = "дифф чистый"): Record<string, string> {
	return fakeReviewer(cwd, `printf 'VERDICT: PASS\\nNOTE: ${note}\\n'`);
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
			"--covers",
			"эхо=AC-01",
			"--check",
			"readme::test -f readme.md",
			"--covers",
			"readme=AC-02",
			"--residual-none",
			"охват — существование файла",
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
		await gate(cwd, ["init", "secret", "--task", "секрет", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		const run = await gate(cwd, ["run", "secret"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("НАРУШЕН");
		expect(run.out).toContain("password literal");
	});

	test("рискованная работа без независимой проверки не проходит verify", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "risk", "--task", "риск", "--risk", "high", "--ac", "AC-01: службы живы", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--check", "нет::test -f missing.txt", "--expect", "нет=1", "--covers", "нет=AC-01", "--adversarial", "проверка врёт::пустой файл::получен отказ", "--artifact", "readme.md", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "risk"]);
		const before = await gate(cwd, ["verify", "risk"]);
		expect(before.code).toBe(1);
		expect(before.err).toContain("независимая проверка");
		const review = await gate(cwd, ["review", "risk", "--spawn", "--review-timeout", "20"], passingReviewer(cwd, "перепроверил выводы"));
		expect(review.code).toBe(0);
		// Аттестат выдаёт только независимый сервис: без него приёмка не закрывается (интеграция — verifier.test.ts).
		const withoutAttest = await gate(cwd, ["verify", "risk"]);
		expect(withoutAttest.code).toBe(1);
		expect(withoutAttest.err).toContain("аттестац");
		// Верификатор может отклонить прогон по своей политике (ключ, видимость временного каталога).
		// Тогда приёмка обязана остаться непройденной, а отказ — явным, без молчаливого PASS.
		const attest = await gate(cwd, ["attest", "risk"]);
		if (attest.code === 0) expect((await gate(cwd, ["verify", "risk"])).code).toBe(0);
		else {
			expect(`${attest.err}${attest.out}`.trim().length).toBeGreaterThan(0);
			expect((await gate(cwd, ["verify", "risk"])).code).toBe(1);
		}
	});

	test("вердикт FAIL переводит сертификат в FAILED", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "rev", "--task", "ревью", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "self", "--task", "само", "--risk", "high", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "self"]);
		// PASS руками не принимается вовсе (провенанс), независимость имени — второй контур.
		const deniedPass = await gate(cwd, ["review", "self", "--by", "self", "--verdict", "PASS", "--note", "я проверил"]);
		expect(deniedPass.code).toBe(2);
		expect(deniedPass.err).toContain("PASS без ревьюера не принимается");
		const deniedFail = await gate(cwd, ["review", "self", "--by", "self", "--verdict", "FAIL", "--note", "я"]);
		expect(deniedFail.code).toBe(2);
		expect(deniedFail.err).toContain("не считается независимым ревьюером");
		const verify = await gate(cwd, ["verify", "self"]);
		expect(verify.code).toBe(1);
	});

	test("провал ревьюера не отмывается повторным прогоном", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "wash", "--task", "отмывание", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "fake", "--task", "фейк", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "big", "--task", "большой", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "byавтор", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "byавтор"]);
		const denied = await gate(cwd, ["review", "byавтор", "--by", "автор", "--verdict", "FAIL", "--note", "я"]);
		expect(denied.code).toBe(2);
		expect(denied.err).toContain("не считается независимым");
		const deniedPass = await gate(cwd, ["review", "byавтор", "--by", "автор", "--verdict", "PASS", "--note", "я"]);
		expect(deniedPass.code).toBe(2);
		expect(deniedPass.err).toContain("PASS без ревьюера");
	});

	test("FAIL нельзя перекрыть молча: нужен --supersede", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "sup", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "sup"]);
		await gate(cwd, ["review", "sup", "--by", "reviewer", "--verdict", "FAIL", "--note", "дыра"]);
		const env = passingReviewer(cwd, "дыру закрыл, перепроверил");
		const silent = await gate(cwd, ["review", "sup", "--spawn", "--review-timeout", "20"], env);
		expect(silent.code).toBe(2);
		expect(silent.err).toContain("--supersede");
		const explicit = await gate(cwd, ["review", "sup", "--spawn", "--supersede", "--review-timeout", "20"], env);
		expect(explicit.code).toBe(0);
	});

	test("лог проверки обязан содержать свою команду и код выхода", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "logs", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "subself", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "subself"]);
		const denied = await gate(cwd, ["review", "subself", "--by", "subagent:self", "--verdict", "PASS", "--note", "я"]);
		expect(denied.code).toBe(2);
	});

	test("подделка спавн-метки «omp -p …» не проходит", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "fake-spawn", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		await gate(cwd, ["run", "fake-spawn"]);
		const denied = await gate(cwd, ["review", "fake-spawn", "--by", "omp -p self", "--verdict", "PASS", "--note", "я"]);
		expect(denied.code).toBe(2);
	});

	test("verify видит стоящий FAIL в истории reviews[]", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "hist", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "incons", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
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
		await gate(cwd, ["init", "broken", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — существование файла"]);
		const dir = join(cwd, ".omp", "gate", "broken");
		writeFileSync(join(dir, "certificate.json"), JSON.stringify({ slug: "broken", status: "ГОТОВО" }));
		const verify = await gate(cwd, ["verify", "broken"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("сертификат повреждён");
	});

	test("правка сертификата ломает подпись", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "sig", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — файл"]);
		await gate(cwd, ["run", "sig"]);
		expect((await gate(cwd, ["verify", "sig"])).code).toBe(0);
		const certPath = join(cwd, ".omp", "gate", "sig", "certificate.json");
		const cert = JSON.parse(await Bun.file(certPath).text());
		cert.residualNone = "рисков нет вообще";
		await Bun.write(certPath, JSON.stringify(cert));
		const verify = await gate(cwd, ["verify", "sig"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("подпись не сходится");
	});

	test("проверка-заглушка не считается доказательством", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "stub", "--task", "t", "--ac", "AC-01: x", "--check", "пусто::true", "--covers", "пусто=AC-01", "--residual-none", "охват — файл"]);
		await gate(cwd, ["run", "stub"]);
		const verify = await gate(cwd, ["verify", "stub"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("проверки-заглушки");
	});

	test("критерий без проверки даёт N/A и блокирует", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "uncov", "--task", "t", "--ac", "AC-01: a", "--ac", "AC-02: b", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — файл"]);
		await gate(cwd, ["run", "uncov"]);
		const verify = await gate(cwd, ["verify", "uncov"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("критерии без доказательства (N/A): AC-02");
	});

	test("негативный сценарий обязателен для риска high", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "noneg", "--task", "t", "--risk", "high", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — файл"]);
		await gate(cwd, ["run", "noneg"]);
		const verify = await gate(cwd, ["verify", "noneg"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("нет негативного сценария");
	});

	test("негативный сценарий проходит, когда код совпал с ожиданием", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "neg", "--task", "t", "--risk", "normal", "--ac", "AC-01: файла нет — команда падает", "--check", "нет::test -f missing.txt", "--expect", "нет=1", "--covers", "нет=AC-01", "--adversarial", "отрицательный сценарий подделан::проверил на реальном отсутствии файла::код 1 как ожидалось", "--artifact", "readme.md", "--residual-none", "охват — отсутствие файла"]);
		const run = await gate(cwd, ["run", "neg"]);
		expect(run.code).toBe(0);
		await gate(cwd, ["review", "neg", "--spawn", "--review-timeout", "20"], passingReviewer(cwd, "негатив ожидаем"));
		const attest = await gate(cwd, ["attest", "neg"]);
		if (attest.code === 0) expect((await gate(cwd, ["verify", "neg"])).code).toBe(0);
		else expect((await gate(cwd, ["verify", "neg"])).code).toBe(1);
	});

	test("ревью N/A не закрывает приёмку", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "na", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — файл"]);
		await gate(cwd, ["run", "na"]);
		await gate(cwd, ["review", "na", "--by", "reviewer", "--verdict", "N/A", "--note", "ревьюер не ответил"]);
		const verify = await gate(cwd, ["verify", "na"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("ревью не состоялось (N/A)");
	});

	test("остаточный риск без причины и условия не принимается", async () => {
		const cwd = repo();
		const denied = await gate(cwd, ["init", "res", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual", "только текст"]);
		expect(denied.code).toBe(2);
		expect(denied.err).toContain("причина");
	});

	test("RESIDUAL не заявлен — приёмка не закрывается", async () => {
		const cwd = repo();
		await gate(cwd, ["init", "nores", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01"]);
		await gate(cwd, ["run", "nores"]);
		const verify = await gate(cwd, ["verify", "nores"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("RESIDUAL не заявлен");
	});

	test("snapshot/rollback: возвращает состояние до точки и не трогает чужое", async () => {
		const cwd = repo();
		// было до точки: отслеживаемый файл + локальная правка + чужой новый файл
		writeFileSync(join(cwd, "readme.md"), "# проект\nлокальная правка\n");
		writeFileSync(join(cwd, "user-file.ts"), "export const user = 1;\n");
		const snap = await gate(cwd, ["init", "rb", "--task", "t", "--ac", "AC-01: x", "--check", "readme::test -f readme.md", "--covers", "readme=AC-01", "--residual-none", "охват — файл"]);
		expect(snap.code).toBe(0);
		expect((await gate(cwd, ["snapshot", "rb"])).code).toBe(0);
		// после точки: новый мусор и ещё одна правка
		writeFileSync(join(cwd, "garbage.ts"), "eval('плохо');\n");
		writeFileSync(join(cwd, "readme.md"), "# проект\nсломал\n");
		const denied = await gate(cwd, ["rollback", "rb"]);
		expect(denied.code).toBe(3);
		const rolled = await gate(cwd, ["rollback", "rb", "--approve", "вернуть как было"]);
		expect(rolled.code).toBe(0);
		const readme = await Bun.file(join(cwd, "readme.md")).text();
		expect(readme).toContain("локальная правка");
		expect(readme).not.toContain("сломал");
		expect(existsSync(join(cwd, "garbage.ts"))).toBe(false);
		expect(existsSync(join(cwd, "user-file.ts"))).toBe(true);
	});

	test("собственные артефакты приёмки не считаются изменением кода", async () => {
		const cwd = repo();
		writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
		await gate(cwd, ["init", "selfscan", "--task", "t", "--ac", "AC-01: x", "--check", "вывод::printf 'fixture: eval(payload) отклонён\\n'", "--covers", "вывод=AC-01", "--residual-none", "охват — вывод"]);
		const run = await gate(cwd, ["run", "selfscan"]);
		// в логе проверки есть слово-шаблон, но это не наш код: сканер не должен себя флагать
		expect(run.out).toContain("eval / new Function → чисто");
	});

	// ---- Аудит приёмки: вердикт обязан иметь провенанс (27.10) ----
	test("ручной PASS без ревьюера отвергается и статус не меняется", async () => {
		const cwd = repo();
		await gate(cwd, ["init","manual","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "manual"]);
		const forged = await gate(cwd, ["review", "manual", "--by", "reviewer", "--verdict", "PASS", "--note", "я посмотрел"]);
		expect(forged.code).toBe(2);
		expect(forged.err).toContain("PASS без ревьюера не принимается");
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "manual", "certificate.json")).text());
		expect(cert.review).toBeNull();
		expect(cert.status).toBe("PARTIAL");
	});

	test("запущенный ревьюер оставляет провенанс: попытки, копия предмета, привязка к subjectHash", async () => {
		const cwd = repo();
		await gate(cwd, ["init","prov","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "prov"]);
		const review = await gate(cwd, ["review", "prov", "--spawn", "--review-timeout", "20"], passingReviewer(cwd, "ок"));
		expect(review.code).toBe(0);
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "prov", "certificate.json")).text());
		expect(cert.review.by.startsWith("spawn:")).toBe(true);
		expect(cert.review.evidence.kind).toBe("spawn");
		expect(cert.review.evidence.attempts).toBeGreaterThanOrEqual(1);
		expect(cert.review.evidence.timedOut).toBe(false);
		expect(typeof cert.review.subjectHash).toBe("string");
		expect(cert.status).toBe("ГОТОВО");
	});

	test("молчащий ревьюер не превращается в PASS: код 3, статус PARTIAL", async () => {
		const cwd = repo();
		await gate(cwd, ["init","silent","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "silent"]);
		const review = await gate(cwd, ["review", "silent", "--spawn", "--review-timeout", "20"], fakeReviewer(cwd, "exit 0"));
		expect(review.code).toBe(3);
		expect(review.err).toContain("REVIEW_UNAVAILABLE");
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "silent", "certificate.json")).text());
		expect(cert.review).toBeNull();
		expect(cert.status).toBe("PARTIAL");
	});

	test("эхо задания («VERDICT: PASS|FAIL») вердиктом не считается", async () => {
		const cwd = repo();
		await gate(cwd, ["init","echo","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "echo"]);
		const echo = fakeReviewer(cwd, "printf 'Ответь ровно двумя строками:\\nVERDICT: PASS|FAIL\\nNOTE: <одна строка>\\n'");
		const review = await gate(cwd, ["review", "echo", "--spawn", "--review-timeout", "20"], echo);
		expect(review.code).toBe(3);
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "echo", "certificate.json")).text());
		expect(cert.review).toBeNull();
	});

	test("последняя строка вердикта побеждает: PASS и затем FAIL — это FAIL", async () => {
		const cwd = repo();
		await gate(cwd, ["init","flip","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "flip"]);
		const flip = fakeReviewer(cwd, "printf 'VERDICT: PASS\\nNOTE: показалось\\nVERDICT: FAIL\\nNOTE: нашёл дыру\\n'");
		const review = await gate(cwd, ["review", "flip", "--spawn", "--review-timeout", "20"], flip);
		expect(review.code).toBe(1);
		const cert = JSON.parse(await Bun.file(join(cwd, ".omp", "gate", "flip", "certificate.json")).text());
		expect(cert.review.verdict).toBe("FAIL");
		expect(cert.status).toBe("FAILED");
	});

	test("правка кода после вердикта делает ревью недействительным", async () => {
		const cwd = repo();
		await gate(cwd, ["init","fresh","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "fresh"]);
		await gate(cwd, ["review", "fresh", "--spawn", "--review-timeout", "20"], passingReviewer(cwd, "ок"));
		writeFileSync(join(cwd, "readme.md"), "# repo\n\nдописано после ревью\n");
		const verify = await gate(cwd, ["verify", "fresh"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("код менялся после вердикта");
	});

	test("вердикт PASS без провенанса не проходит verify (подмена сертификата)", async () => {
		const cwd = repo();
		await gate(cwd, ["init","noprov","--task","t","--ac","AC-01: x","--check","readme::test -f readme.md","--covers","readme=AC-01","--residual-none","охват — файл"]);
		await gate(cwd, ["run", "noprov"]);
		const certPath = join(cwd, ".omp", "gate", "noprov", "certificate.json");
		const cert = JSON.parse(await Bun.file(certPath).text());
		const at = new Date().toISOString();
		cert.review = { by: "reviewer", independent: true, verdict: "PASS", note: "я перепроверил", at };
		cert.reviews = [cert.review];
		cert.status = "ГОТОВО";
		await Bun.write(certPath, JSON.stringify(cert));
		const verify = await gate(cwd, ["verify", "noprov"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("без провенанса");
	});
});
