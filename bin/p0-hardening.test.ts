import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, diffHashOf, runnerKeyId, checkVisual, VISUAL_POSITIONS, VISUAL_THEMES, VISUAL_VIEWPORTS, type VisualEvidence } from "./visual-gate.ts";
import { evaluateDeploy, type OwnerApproval } from "./deploy-gate.ts";
import deployGuard from "../deploy/hooks/pre/deploy-guard.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Настоящий демон верификатора на своём сокете, ключе и токене владельца. */
async function startDaemon(options: { ownerToken?: string } = {}): Promise<{ socket: string; key: Buffer; token: string }> {
	const runtime = temp("p0-vf-");
	const keyPath = join(runtime, "key");
	const key = Buffer.alloc(32, 5);
	writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
	const token = options.ownerToken ?? "owner-token-123";
	const tokenPath = join(runtime, "owner-token");
	writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
	const socket = join(runtime, "verify.sock");
	const child = Bun.spawn(["bun", join(import.meta.dir, "verifier-daemon.ts")], {
		env: {
			...process.env,
			OMP_VERIFIER_RUNTIME: runtime,
			OMP_VERIFIER_KEY: keyPath,
			OMP_OWNER_TOKEN_FILE: tokenPath,
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanups.push(() => child.kill());
	for (let i = 0; i < 60; i += 1) {
		if (existsSync(socket)) break;
		await Bun.sleep(100);
	}
	return { socket, key, token };
}

async function callDaemon(socket: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await fetch("http://verifier/", { method: "POST", unix: socket, body: JSON.stringify(payload) });
	return (await response.json()) as Record<string, unknown>;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// ── стенд проекта с подписанным визуальным пакетом ────────────────────────────
interface Stand {
	cwd: string;
	slug: string;
	commit: string;
	publicPem: string;
	keyId: string;
	shotsDir: string;
	evidencePath: string;
	signaturePath: string;
}

function stand(options: { slug?: string; git?: boolean; url?: string; pinKey?: boolean; shots?: "png" | "text" } = {}): Stand {
	const cwd = temp("p0-stand-");
	const slug = options.slug ?? "ui";
	if (options.git !== false) {
		Bun.spawnSync(["git", "init", "-q"], { cwd });
		Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd });
		Bun.spawnSync(["git", "config", "user.name", "t"], { cwd });
		writeFileSync(join(cwd, "readme.md"), "# repo\n");
		Bun.spawnSync(["git", "add", "."], { cwd });
		Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd });
	}
	const commit = options.git === false ? "" : Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd }).stdout.toString().trim();
	const dir = join(cwd, ".omp", "gate", slug, "visual");
	const shotsDir = join(dir, "shots");
	mkdirSync(shotsDir, { recursive: true });
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "visual-runner.pub"), publicPem);
	const combos: VisualEvidence["combos"] = [];
	for (const viewport of VISUAL_VIEWPORTS) {
		for (const theme of VISUAL_THEMES) {
			const shots: VisualEvidence["combos"][number]["shots"] = [];
			for (const position of VISUAL_POSITIONS) {
				const name = `${viewport.width}x${viewport.height}-${theme}-${position}.png`;
				const bytes =
					options.shots === "text"
						? Buffer.alloc(2048, 0x41)
						: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 3)]);
				writeFileSync(join(shotsDir, name), bytes);
				shots.push({ position, path: `shots/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
			}
			combos.push({
				viewport,
				theme,
				shots,
				dom: {
					overlap: { ok: true, detail: "нет" },
					lastBrand: { ok: true, detail: "достижим" },
					horizontalOverflow: { ok: true, detail: "нет" },
					buttons: { ok: true, detail: "работают" },
					theme: { ok: true, detail: "применена" },
				},
			});
		}
	}
	const evidence: VisualEvidence = {
		version: 1,
		slug,
		url: options.url ?? "http://127.0.0.1:18081/catalog",
		commit,
		diffHash: options.git === false ? "0".repeat(64) : diffHashOf(cwd),
		runId: "vr-hardening",
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		runner: { keyId: runnerKeyId(publicPem), chrome: "test", host: "test" },
		combos,
		totals: { combos: 16, shots: 48, failed: 0 },
	};
	const evidencePath = join(dir, "evidence.json");
	const signaturePath = join(dir, "evidence.sig");
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, "\t")}\n`);
	writeFileSync(signaturePath, `${cryptoSign(null, Buffer.from(canonicalJson(evidence), "utf8"), privateKey).toString("base64")}\n`);
	return { cwd, slug, commit, publicPem, keyId: runnerKeyId(publicPem), shotsDir, evidencePath, signaturePath };
}

function check(stand: Stand, extra: Partial<Parameters<typeof checkVisual>[0]> = {}) {
	return checkVisual({
		cwd: stand.cwd,
		slug: stand.slug,
		publicKeyPath: join(stand.cwd, ".omp", "visual-runner.pub"),
		checkDiff: false,
		...extra,
	});
}

describe("P0: закрытые находки состязательного разбора", () => {
	// №5: якорь доверия — подмена ключа ловится пином keyId из контракта
	test("пакет с другим ключом не проходит, если контракт закрепил свой keyId", () => {
		const s = stand();
		expect(check(s, { expectedKeyId: s.keyId }).status).toBe("PASS");
		const other = stand({ slug: "ui" });
		expect(check(s, { expectedKeyId: other.keyId }).status).toBe("BLOCK");
		expect(check(s, { expectedKeyId: other.keyId }).reasons.join(" ")).toContain("контракт закрепляет");
	});

	// №6: пакет привязан к slug и к стенду контракта
	test("чужая приёмка не переиспользуется: другой slug и другой URL — BLOCK", () => {
		const s = stand();
		expect(check(s, { expectedUrl: "http://127.0.0.1:18081/catalog" }).status).toBe("PASS");
		expect(check(s, { expectedUrl: "https://lamplife.ru/catalog" }).status).toBe("BLOCK");
		const foreign = join(s.cwd, ".omp", "gate", "other", "visual");
		mkdirSync(join(s.cwd, ".omp", "gate", "other"), { recursive: true });
		Bun.spawnSync(["cp", "-r", join(s.cwd, ".omp", "gate", s.slug, "visual"), foreign]);
		const verdict = checkVisual({
			cwd: s.cwd,
			slug: "other",
			publicKeyPath: join(s.cwd, ".omp", "visual-runner.pub"),
			checkDiff: false,
		});
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("пакет снят для");
	});

	// №7: без git привязку проверить нечем — отказ, а не «пропустить»
	test("без git визуальный гейт отказывает (fail-closed)", () => {
		const s = stand({ git: false });
		const verdict = check(s);
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("git не дал commit");
	});

	// №14: keyId не зависит от хвостового перевода строки
	test("keyId одинаков для PEM с переводом строки и без", () => {
		const s = stand();
		expect(runnerKeyId(s.publicPem)).toBe(runnerKeyId(s.publicPem.trim()));
		expect(runnerKeyId(s.publicPem)).toBe(runnerKeyId(`${s.publicPem.trim()}\n`));
	});

	// №9: провенанс ревью — белый список
	test("ревью с произвольной строкой в evidence.kind не даёт AUTHORIZED", async () => {
		const daemon = await startDaemon();
		const s = stand();
		const gateDir = join(s.cwd, ".omp", "gate", s.slug);
		mkdirSync(gateDir, { recursive: true });
		writeFileSync(
			join(gateDir, "certificate.json"),
			JSON.stringify({
				slug: s.slug,
				status: "ГОТОВО",
				risk: "high",
				visual: { required: true, url: "http://127.0.0.1:18081/catalog", keyId: s.keyId },
				criteria: [{ id: "AC-01", text: "x" }],
				checks: [{ name: "t", cmd: "bun test", ok: true, exitCode: 0, blocking: true, covers: ["AC-01"] }],
				review: { by: "я", verdict: "PASS", note: "сам", evidence: { kind: "какая-то строка" } },
			}),
		);
		writeFileSync(join(gateDir, "staging.json"), JSON.stringify({ commit: s.commit, ok: true }));
		const verdict = await withEnv(
			{ OMP_VERIFIER_SOCKET: daemon.socket, OMP_VISUAL_RUNNER_PUB: join(s.cwd, ".omp", "visual-runner.pub") },
			() => evaluateDeploy({ cwd: s.cwd, slug: s.slug, release: "rel-1", commit: s.commit, env: "prod" }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "review")?.detail).toContain("без провенанса");
	});
});

describe("P0: разрешения владельца (демон)", () => {
	test("№1: одноразовость при параллельном погашении — успешен ровно один", async () => {
		const daemon = await startDaemon();
		const issued = await callDaemon(daemon.socket, {
			action: "approve",
			slug: "ui",
			release: "rel-1",
			commit: "a".repeat(40),
			env: "prod",
			person: "владелец",
			ownerToken: daemon.token,
			ttlSec: 600,
		});
		expect(issued["ok"]).toBe(true);
		const approval = issued["approval"] as Record<string, unknown>;
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				callDaemon(daemon.socket, { action: "check-approval", approval, consume: true, release: "rel-1", commit: "a".repeat(40), env: "prod" }),
			),
		);
		expect(results.filter((r) => r["ok"] === true)).toHaveLength(1);
	});

	test("№2: без токена владельца разрешение не выдаётся", async () => {
		const daemon = await startDaemon();
		const withoutToken = await callDaemon(daemon.socket, { action: "approve", slug: "ui", release: "rel-x", commit: "b".repeat(40), env: "prod", person: "владелец" });
		expect(withoutToken["ok"]).toBe(false);
		expect(String(withoutToken["detail"])).toContain("токен владельца");
		const wrongToken = await callDaemon(daemon.socket, { action: "approve", slug: "ui", release: "rel-x", commit: "b".repeat(40), env: "prod", person: "владелец", ownerToken: "не-тот" });
		expect(wrongToken["ok"]).toBe(false);
		const right = await callDaemon(daemon.socket, { action: "approve", slug: "ui", release: "rel-x", commit: "b".repeat(40), env: "prod", person: "владелец", ownerToken: daemon.token });
		expect(right["ok"]).toBe(true);
	});

	test("№3: разрешение не переносится на другой release, commit и env", async () => {
		const daemon = await startDaemon();
		const issued = await callDaemon(daemon.socket, {
			action: "approve",
			slug: "ui",
			release: "rel-alpha",
			commit: "c".repeat(40),
			env: "prod",
			person: "владелец",
			ownerToken: daemon.token,
		});
		const approval = issued["approval"] as Record<string, unknown>;
		const otherRelease = await callDaemon(daemon.socket, { action: "check-approval", approval, release: "rel-beta", commit: "c".repeat(40), env: "prod" });
		expect(otherRelease["ok"]).toBe(false);
		expect(String(otherRelease["detail"])).toContain("другой release");
		const otherCommit = await callDaemon(daemon.socket, { action: "check-approval", approval, release: "rel-alpha", commit: "d".repeat(40), env: "prod" });
		expect(otherCommit["ok"]).toBe(false);
		const otherEnv = await callDaemon(daemon.socket, { action: "check-approval", approval, release: "rel-alpha", commit: "c".repeat(40), env: "staging" });
		expect(otherEnv["ok"]).toBe(false);
		expect(String(otherEnv["detail"])).toContain("другое окружение");
		const correct = await callDaemon(daemon.socket, { action: "check-approval", approval, release: "rel-alpha", commit: "c".repeat(40), env: "prod" });
		expect(correct["ok"]).toBe(true);
	});

	test("подделанный mac разрешения отвергается", async () => {
		const daemon = await startDaemon();
		const issued = await callDaemon(daemon.socket, { action: "approve", slug: "ui", release: "rel-m", commit: "e".repeat(40), env: "prod", person: "владелец", ownerToken: daemon.token });
		const approval = { ...(issued["approval"] as Record<string, unknown>), mac: createHmac("sha256", Buffer.alloc(32, 1)).update("x").digest("hex") };
		const answer = await callDaemon(daemon.socket, { action: "check-approval", approval });
		expect(answer["ok"]).toBe(false);
		expect(String(answer["detail"])).toContain("подпись разрешения не верна");
	});
});

describe("P0: deploy-guard закрывает обходы выкладки", () => {
	async function guard(command: string): Promise<boolean> {
		let handler: ((event: { toolName: string; input: { command: string } }, ctx: unknown) => unknown) | null = null;
		deployGuard({ on: (event: string, fn: (event: { toolName: string; input: { command: string } }, ctx: unknown) => unknown) => {
			if (event === "tool_call") handler = fn;
		} } as never);
		const result = (await handler!({ toolName: "bash", input: { command } }, {})) as { block?: boolean } | undefined;
		return result?.block === true;
	}

	test("№10: docker-compose ловится так же, как docker compose", async () => {
		expect(await guard("ssh root@194.58.95.216 'docker restart web'")).toBe(true);
		expect(await guard("ssh root@194.58.95.216 'docker-compose restart web'")).toBe(true);
	});

	test("№11: запись через tee/dd/sed -i/cp/install и POST-запросы блокируются", async () => {
		for (const command of [
			"ssh root@194.58.95.216 'echo x | tee /srv/lamplife/apps/lamplife/lamplife/www/x.html'",
			"ssh root@194.58.95.216 'dd if=/tmp/x of=/srv/lamplife/x'",
			"ssh root@194.58.95.216 \"sed -i 's/a/b/' /srv/lamplife/apps/lamplife/lamplife/www/catalog.html\"",
			"ssh root@194.58.95.216 'cp /tmp/x /srv/lamplife/x'",
			"ssh root@194.58.95.216 'install -m 644 /tmp/x /srv/lamplife/x'",
			"curl -X POST https://lamplife.ru/api/deploy",
			"rsync -a ./dist/ root@194.58.95.216:/srv/lamplife/apps/",
		]) {
			expect(await guard(command)).toBe(true);
		}
	});

	test("№13: чтение и скачивание с прода не блокируются", async () => {
		expect(await guard("curl -s https://lamplife.ru/catalog | head -c 200")).toBe(false);
		expect(await guard("ssh root@194.58.95.216 'cat /srv/lamplife/apps/lamplife/lamplife/www/catalog.html'")).toBe(false);
		expect(await guard("scp root@194.58.95.216:/srv/lamplife/backup.tar /tmp/")).toBe(false);
		expect(await guard("git -C /tmp/repo status")).toBe(false);
	});

	test("неизвестная команда к проду считается опасной (fail-closed)", async () => {
		expect(await guard("ssh root@194.58.95.216 'какой-то-скрипт.sh --apply'")).toBe(true);
		expect(await guard("ssh root@194.58.95.216 'sh -c \"echo привет\"'")).toBe(true);
	});
});

describe("P0: связка сертификата и привязок", () => {
	test("визуальное требование переносится в сертификат при run", () => {
		const cwd = temp("p0-cert-");
		Bun.spawnSync(["git", "init", "-q"], { cwd });
		Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd });
		Bun.spawnSync(["git", "config", "user.name", "t"], { cwd });
		writeFileSync(join(cwd, "app.txt"), "x\n");
		Bun.spawnSync(["git", "add", "."], { cwd });
		Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd });
		const gate = join(import.meta.dir, "quality-gate.ts");
		const run = (args: string[]) => Bun.spawnSync(["bun", gate, ...args], { cwd, env: { ...process.env, QUALITY_GATE_KEY: join(cwd, ".key") }, stdout: "pipe", stderr: "pipe" });
		run(["init", "vg", "--task", "t", "--ac", "AC-01: x", "--check", "tests::test -f app.txt", "--covers", "tests=AC-01", "--visual-required", "--visual-url", "http://127.0.0.1:18081/catalog", "--residual-none", "охват — файл"]);
		run(["run", "vg"]);
		const cert = JSON.parse(readFileSync(join(cwd, ".omp", "gate", "vg", "certificate.json"), "utf8")) as { visual?: { required?: boolean } | null };
		expect(cert.visual?.required).toBe(true);
		// Без пакета доказательств verify обязан отказать.
		const verify = run(["verify", "vg"]);
		expect(verify.exitCode).toBe(1);
		expect(verify.stderr.toString()).toContain("визуальной приёмки");
	});
});
