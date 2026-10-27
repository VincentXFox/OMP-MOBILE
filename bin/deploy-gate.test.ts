import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, diffHashOf, runnerKeyId, VISUAL_POSITIONS, VISUAL_THEMES, VISUAL_VIEWPORTS, type VisualEvidence } from "./visual-gate.ts";
import { evaluateDeploy, type OwnerApproval } from "./deploy-gate.ts";

const cleanups: Array<() => void> = [];
const KEY = Buffer.alloc(32, 9);
afterAll(() => {
	for (const cleanup of cleanups) cleanup();
});

/**
 * Стенд-двойник верификатора: отвечает по протоколу сокета. Реальный демон
 * проверяется отдельно (verifier.test.ts) — здесь нужен управляемый ответ
 * на `check`, `approve` и `check-approval`.
 */
async function startVerifierStub(options: { attestationOk?: boolean; approvalsOk?: boolean; consumeLedger?: Set<string> } = {}): Promise<string> {
	const runtime = mkdtempSync(join(tmpdir(), "vgate-vf-"));
	const socket = join(runtime, "verify.sock");
	const used = options.consumeLedger ?? new Set<string>();
	const server = Bun.serve({
		unix: socket,
		async fetch(req) {
			const request = (await req.json()) as Record<string, unknown>;
			const action = String(request["action"] ?? "");
			if (action === "check") {
				const ok = options.attestationOk !== false;
				return Response.json({ ok, detail: ok ? "подпись верификатора верна, сертификат не менялся" : "нет аттестации" });
			}
			if (action === "approve") {
				if (options.approvalsOk === false) return Response.json({ ok: false, detail: "владелец не подтверждал" });
				const issuedAt = new Date();
				const body: Record<string, unknown> = {
					version: 1,
					release: request["release"],
					slug: request["slug"],
					commit: request["commit"],
					env: request["env"] ?? "prod",
					person: request["person"] ?? "владелец",
					issuedAt: issuedAt.toISOString(),
					expiresAt: new Date(issuedAt.getTime() + Number(request["ttlSec"] ?? 3600) * 1000).toISOString(),
					nonce: createHash("sha256").update(`${String(request["release"])}:${issuedAt.toISOString()}`).digest("hex").slice(0, 16),
					by: "omp-verifier-stub",
				};
				const mac = createHmac("sha256", KEY).update(canonicalJson(body)).digest("hex");
				return Response.json({ ok: true, approval: { ...body, mac }, detail: "разрешение выдано" });
			}
			if (action === "check-approval") {
				const approval = (request["approval"] ?? null) as Record<string, unknown> | null;
				if (approval === null) return Response.json({ ok: false, detail: "разрешение не передано" });
				const mac = String(approval["mac"] ?? "");
				const body = { ...approval };
				delete body["mac"];
				if (mac !== createHmac("sha256", KEY).update(canonicalJson(body)).digest("hex"))
					return Response.json({ ok: false, detail: "подпись разрешения не верна" });
				if (Date.parse(String(approval["expiresAt"])) < Date.now()) return Response.json({ ok: false, detail: "разрешение истекло" });
				const nonce = String(approval["nonce"] ?? "");
				if (used.has(nonce)) return Response.json({ ok: false, detail: "разрешение уже использовано" });
				if (request["consume"] === true) {
					used.add(nonce);
					return Response.json({ ok: true, detail: "разрешение погашено" });
				}
				return Response.json({ ok: true, detail: "разрешение действительно" });
			}
			return Response.json({ ok: false, detail: "неизвестное действие" });
		},
	});
	cleanups.push(() => {
		server.stop(true);
		rmSync(runtime, { recursive: true, force: true });
	});
	return socket;
}

interface Bench {
	cwd: string;
	slug: string;
	commit: string;
	approvalPath: string;
	shotsDir: string;
}

/** Полный стенд: git-репозиторий, сертификат, подписанный визуальный пакет, staging, разрешение. */
function bench(options: { visual?: boolean; tamperShot?: boolean; reviewProvenance?: boolean; staleAttestation?: boolean } = {}): Bench {
	const cwd = mkdtempSync(join(tmpdir(), "dgate-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	Bun.spawnSync(["git", "init", "-q"], { cwd });
	Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd });
	Bun.spawnSync(["git", "config", "user.name", "t"], { cwd });
	writeFileSync(join(cwd, "readme.md"), "# repo\n");
	Bun.spawnSync(["git", "add", "."], { cwd });
	Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd });
	const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd }).stdout.toString().trim();

	const slug = "lamplife-filters";
	const gateDir = join(cwd, ".omp", "gate", slug);
	mkdirSync(join(gateDir, "logs"), { recursive: true });

	// Публичный ключ раннера создаём до сертификата: его отпечаток закрепляется в контракте.
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "visual-runner.pub"), publicPem);
	const pinnedKeyId = runnerKeyId(publicPem);
	// Сертификат: проверки пройдены, ревью с провенансом (или без него).
	writeFileSync(
		join(gateDir, "certificate.json"),
		JSON.stringify({
			slug,
			status: "ГОТОВО",
			risk: "high",
			visual: { required: true, url: "http://127.0.0.1:18081/catalog", keyId: pinnedKeyId },
			criteria: [{ id: "AC-01", text: "фильтры работают" }],
			checks: [{ name: "tests", cmd: "bun test", ok: true, exitCode: 0, blocking: true, covers: ["AC-01"] }],
			review:
				options.reviewProvenance === false
					? { by: "reviewer", verdict: "PASS", note: "сам себя проверил" }
					: { by: "spawn:reviewer", verdict: "PASS", note: "ок", evidence: { kind: "spawn", attempts: 1 } },
		}),
	);

	// Визуальный пакет: подписан тестовым ключом раннера.
	const visualDir = join(gateDir, "visual");
	const shotsDir = join(visualDir, "shots");
	mkdirSync(shotsDir, { recursive: true });
	const combos: VisualEvidence["combos"] = [];
	for (const viewport of VISUAL_VIEWPORTS) {
		for (const theme of VISUAL_THEMES) {
			const shots: VisualEvidence["combos"][number]["shots"] = [];
			for (const position of VISUAL_POSITIONS) {
				const name = `${viewport.width}x${viewport.height}-${theme}-${position}.png`;
				const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 5)]);
				writeFileSync(join(shotsDir, name), bytes);
				shots.push({ position, path: `shots/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
			}
			combos.push({
				viewport,
				theme,
				shots,
				dom: {
					overlap: { ok: true, detail: "нет перекрытий" },
					lastBrand: { ok: true, detail: "достижим" },
					horizontalOverflow: { ok: true, detail: "нет переполнения" },
					buttons: { ok: true, detail: "работают" },
					theme: { ok: true, detail: "тема применена" },
				},
			});
		}
	}
	const evidence: VisualEvidence = {
		version: 1,
		slug,
		url: "http://127.0.0.1:18081/catalog",
		commit,
		diffHash: diffHashOf(cwd),
		runId: "vr-test",
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		runner: { keyId: runnerKeyId(publicPem), chrome: "test", host: "test" },
		combos,
		totals: { combos: 16, shots: 48, failed: 0 },
	};
	writeFileSync(join(visualDir, "evidence.json"), `${JSON.stringify(evidence, null, "\t")}\n`);
	writeFileSync(join(visualDir, "evidence.sig"), `${cryptoSign(null, Buffer.from(canonicalJson(evidence), "utf8"), privateKey).toString("base64")}\n`);
	if (options.tamperShot === true) writeFileSync(join(shotsDir, "320x640-light-top.png"), Buffer.concat([Buffer.from([0x89]), Buffer.alloc(2048, 6)]));

	// staging QA на том же commit.
	writeFileSync(join(gateDir, "staging.json"), JSON.stringify({ commit, ok: true, detail: "стенд 18081: 16 комбинаций пройдено" }));

	return { cwd, slug, commit, approvalPath: join(cwd, "approval.json"), shotsDir };
}

/** Окружение теста: свой сокет верификатора и публичный ключ раннера стенда. */
function envFor(bench: Bench, socket: string): Record<string, string> {
	return { OMP_VERIFIER_SOCKET: socket, OMP_VISUAL_RUNNER_PUB: join(bench.cwd, ".omp", "visual-runner.pub") };
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

function writeApproval(path: string, approval: OwnerApproval): void {
	writeFileSync(path, `${JSON.stringify(approval, null, "\t")}\n`);
}

function approvalFor(bench: Bench, overrides: Partial<OwnerApproval> = {}, key = KEY): OwnerApproval {
	const body: Record<string, unknown> = {
		version: 1,
		release: "rel-1",
		slug: bench.slug,
		commit: bench.commit,
		env: "prod",
		person: "владелец",
		issuedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		nonce: "n1",
		by: "omp-verifier",
		...overrides,
	};
	const mac = createHmac("sha256", key).update(canonicalJson(body)).digest("hex");
	return { ...(body as unknown as OwnerApproval), mac };
}

describe("deployment gate", () => {
	test("все восемь условий выполнены → AUTHORIZED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		console.log("DBG conditions:", verdict.conditions.map((c) => `${c.ok ? "✔" : "✘"}${c.id}:${c.detail.slice(0, 70)}`).join(" | "));
		expect(verdict.status).toBe("AUTHORIZED");
		expect(verdict.conditions.every((condition) => condition.ok)).toBe(true);
	});

	test("без визуальной приёмки → DENIED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		rmSync(join(b.cwd, ".omp", "gate", b.slug, "visual"), { recursive: true, force: true });
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "visual")?.detail).toContain("UNVERIFIED");
	});

	test("подделанные скриншоты → BLOCKED", async () => {
		const socket = await startVerifierStub();
		const b = bench({ tamperShot: true });
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("BLOCKED");
	});

	test("ревью без провенанса → DENIED", async () => {
		const socket = await startVerifierStub();
		const b = bench({ reviewProvenance: false });
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "review")?.detail).toContain("без провенанса");
	});

	test("нет разрешения владельца → DENIED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: join(b.cwd, "нет.json") }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "ownerApproval")?.ok).toBe(false);
	});

	test("изменённый commit → BLOCKED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b, { commit: "f".repeat(40) }));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: "f".repeat(40), env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("BLOCKED");
		expect(verdict.conditions.find((c) => c.id === "commitMatch")?.ok).toBe(false);
	});

	test("аттестация не подтверждена → DENIED", async () => {
		const socket = await startVerifierStub({ attestationOk: false });
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "attestation")?.ok).toBe(false);
	});

	test("разрешение подписано чужим ключом → BLOCKED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b, {}, Buffer.alloc(32, 7)));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("BLOCKED");
		expect(verdict.conditions.find((c) => c.id === "ownerApproval")?.detail).toContain("подпись разрешения не верна");
	});

	test("разрешение одноразовое: после гашения повторный проход запрещён", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b));
		const first = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath, consume: true }),
		);
		expect(first.status).toBe("AUTHORIZED");
		const second = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(second.status).toBe("BLOCKED");
		expect(second.conditions.find((c) => c.id === "ownerApproval")?.detail).toContain("уже использовано");
	});

	test("истёкшее разрешение → BLOCKED", async () => {
		const socket = await startVerifierStub();
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b, { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
		const verdict = await withEnv(envFor(b, socket), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("BLOCKED");
		expect(verdict.conditions.find((c) => c.id === "ownerApproval")?.detail).toContain("истекло");
	});

	test("верификатор недоступен → DENIED, а не AUTHORIZED", async () => {
		const b = bench();
		writeApproval(b.approvalPath, approvalFor(b));
		const verdict = await withEnv(envFor(b, join(b.cwd, "нет-сокета.sock")), () =>
			evaluateDeploy({ cwd: b.cwd, slug: b.slug, release: "rel-1", commit: b.commit, env: "prod", approvalFile: b.approvalPath }),
		);
		expect(verdict.status).toBe("DENIED");
		expect(verdict.conditions.find((c) => c.id === "attestation")?.detail).toContain("верификатор недоступен");
	});
});
