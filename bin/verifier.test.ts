/**
 * Интеграционные проверки изоляции верификатора: настоящий демон, отдельный ключ,
 * попытки подделать аттестат и подменить артефакт. Каждый критерий — отдельный тест.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON = join(import.meta.dir, "verifier-daemon.ts");
const GATE = join(import.meta.dir, "quality-gate.ts");
const cleanups: (() => void)[] = [];

/** Готовность демона определяется его же сообщением в stdout. */
async function waitForReady(child: ReturnType<typeof Bun.spawn>): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const guard = setTimeout(() => reject(new Error("верификатор не сообщил о готовности")), 15_000);
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		const reader = child.stdout.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value);
			if (buffer.includes("слушает")) {
				clearTimeout(guard);
				resolve();
				return;
			}
		}
		clearTimeout(guard);
		reject(new Error(`верификатор завершился: ${buffer.slice(0, 200)}`));
	})();
	await promise;
}

interface Bench {
	cwd: string;
	socket: string;
	keyPath: string;
}

async function bench(): Promise<Bench> {
	const root = mkdtempSync(join(tmpdir(), "verifier-"));
	const cwd = join(root, "project");
	const runtime = join(root, "run");
	const keyPath = join(root, "verifier-key");
	const whitelist = join(root, "checks.json");
	Bun.spawnSync(["mkdir", "-p", cwd, runtime]);
	Bun.spawnSync(["git", "init", "-q"], { cwd });
	writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(cwd, ".gitignore"), ".omp/\n");
	Bun.spawnSync(["git", "add", "."], { cwd });
	Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd });
	writeFileSync(keyPath, "a".repeat(64));
	chmodSync(keyPath, 0o600);
	writeFileSync(
		whitelist,
		JSON.stringify({ allowed: ["^test\\s+-[efd]\\s+[^;&|]+$"] }),
	);
	const child = Bun.spawn(["bun", DAEMON], {
		env: { ...process.env, OMP_VERIFIER_RUNTIME: runtime, OMP_VERIFIER_KEY: keyPath, OMP_VERIFIER_WHITELIST: whitelist },
		stdout: "pipe",
		stderr: "ignore",
	});
	// Ждём готовности по строке демона, а не фиксированной паузой.
	await waitForReady(child);
	const socket = join(runtime, "verify.sock");
	cleanups.push(() => {
		child.kill();
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, socket, keyPath };
}

function env(b: Bench): Record<string, string> {
	return {
		...process.env,
		OMP_VERIFIER_SOCKET: b.socket,
		QUALITY_GATE_KEY: join(b.cwd, ".key"),
		QUALITY_GATE_LOG: join(b.cwd, ".log.jsonl"),
	};
}

async function gate(b: Bench, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", GATE, ...args], { cwd: b.cwd, stdout: "pipe", stderr: "pipe", env: { ...env(b), ...extraEnv } });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

async function prepared(b: Bench, slug = "iso"): Promise<void> {
	await gate(b, [
		"init",
		slug,
		"--task",
		"изоляция",
		"--risk",
		"high",
		"--ac",
		"AC-01: файл на месте",
		"--check",
		"файл::test -f a.ts",
		"--covers",
		"файл=AC-01",
		"--check",
		"нет::test -f missing.txt",
		"--expect",
		"нет=1",
		"--covers",
		"нет=AC-01",
		"--adversarial",
		"подмена артефакта::правка файла после прогона::verify поймал расхождение",
		"--artifact",
		"a.ts",
		"--residual-none",
		"охват — существование файла",
	]);
	await gate(b, ["run", slug]);
	// PASS теперь только из запущенного ревьюера: подменяем `omp` в PATH фейком.
	const bin = join(b.cwd, ".fake-bin");
	Bun.spawnSync(["mkdir", "-p", bin]);
	writeFileSync(join(bin, "omp"), "#!/bin/bash\nprintf 'VERDICT: PASS\\nNOTE: проверено\\n'\n", { mode: 0o755 });
	await gate(b, ["review", slug, "--spawn", "--review-timeout", "20"], { PATH: `${bin}:${process.env.PATH ?? ""}` });
}

afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

describe("изоляция верификатора", () => {
	test("аттестацию выдаёт демон, и без неё приёмка не закрывается", async () => {
		const b = await bench();
		await prepared(b);
		const before = await gate(b, ["verify", "iso"]);
		expect(before.code).toBe(1);
		expect(before.err).toContain("аттестац");
		const attest = await gate(b, ["attest", "iso"]);
		expect(attest.code).toBe(0);
		expect(attest.out).toContain("PASS");
		const after = await gate(b, ["verify", "iso"]);
		expect(`${after.err}${after.out}`).toContain("сертификат полный");
		expect(after.code).toBe(0);
	});

	test("подделанный аттестат отвергается: подпись чужим ключом не проходит", async () => {
		const b = await bench();
		await prepared(b);
		await gate(b, ["attest", "iso"]);
		const path = join(b.cwd, ".omp", "gate", "iso", "attestation.json");
		const attestation = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		attestation.detail = "я всё проверил сам";
		writeFileSync(path, JSON.stringify(attestation));
		const verify = await gate(b, ["verify", "iso"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toContain("аттестат не подтверждён");
	});

	test("правка сертификата после аттестации ломает связь", async () => {
		const b = await bench();
		await prepared(b);
		await gate(b, ["attest", "iso"]);
		const certPath = join(b.cwd, ".omp", "gate", "iso", "certificate.json");
		const cert = JSON.parse(readFileSync(certPath, "utf8")) as Record<string, unknown>;
		cert.residualNone = "рисков нет";
		writeFileSync(certPath, JSON.stringify(cert));
		const verify = await gate(b, ["verify", "iso"]);
		expect(verify.code).toBe(1);
		expect(verify.err).toMatch(/аттестат не подтверждён|подпись не сходится/);
	});

	test("проверка вне белого списка не исполняется верификатором", async () => {
		const b = await bench();
		await gate(b, [
			"init",
			"wl",
			"--task",
			"белый список",
			"--risk",
			"high",
			"--ac",
			"AC-01: произвольная команда",
			"--check",
			"своя::echo произвольная-команда",
			"--covers",
			"своя=AC-01",
			"--adversarial",
			"обход белого списка::команда вне шаблонов::верификатор отказал",
			"--artifact",
			"a.ts",
			"--residual-none",
			"охват — файл",
		]);
		await gate(b, ["run", "wl"]);
		await gate(b, ["review", "wl", "--by", "reviewer", "--verdict", "PASS", "--note", "проверено"]);
		const attest = await gate(b, ["attest", "wl"]);
		expect(attest.code).toBe(1);
		expect(attest.out).toContain("вне белого списка");
	});

	test("исполнитель не имеет кода, читающего ключ верификатора", async () => {
		// Права в песочнице проверить нельзя (один uid), поэтому проверяем свойство кода:
		// движок приёмки не открывает ключ верификатора и умеет только спрашивать демона.
		const source = readFileSync(GATE, "utf8");
		expect(source.includes("verifier-key")).toBe(false);
		expect(source.includes("askVerifier")).toBe(true);
		// Права на реальном ключе проверяются в системном прогоне (см. отчёт: cat → Permission denied).
	});
});
