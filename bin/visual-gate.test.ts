import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VISUAL_POSITIONS,
	VISUAL_THEMES,
	VISUAL_VIEWPORTS,
	canonicalJson,
	checkVisual,
	diffHashOf,
	runnerKeyId,
	verifyEvidenceSignature,
	type VisualEvidence,
} from "./visual-gate.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** PNG-заглушка честного размера: гейт считает пустым всё, что меньше 1 КиБ. */
function pngBytes(seed: string): Buffer {
	const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const body = Buffer.alloc(2048, 0);
	for (let i = 0; i < body.length; i += 1) body[i] = (seed.charCodeAt(i % seed.length) + i) % 256;
	return Buffer.concat([header, body]);
}

interface Fixture {
	cwd: string;
	slug: string;
	publicKeyPath: string;
	evidence: VisualEvidence;
	write: (mutate?: (evidence: VisualEvidence) => void) => void;
	shotsDir: string;
}

function makeFixture(slug = "ui"): Fixture {
	const cwd = mkdtempSync(join(tmpdir(), "vgate-"));
	dirs.push(cwd);
	const head = gitHead(cwd);
	const gateDir = join(cwd, ".omp", "gate", slug, "visual");
	const shotsDir = join(gateDir, "shots");
	mkdirSync(shotsDir, { recursive: true });

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = join(cwd, "runner.ed25519");
	const publicKeyPath = `${keyPath}.pub`;
	writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
	writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }).toString());

	const combos: VisualEvidence["combos"] = [];
	for (const viewport of VISUAL_VIEWPORTS) {
		for (const theme of VISUAL_THEMES) {
			const shots: VisualEvidence["combos"][number]["shots"] = [];
			for (const position of VISUAL_POSITIONS) {
				const name = `${viewport.width}x${viewport.height}-${theme}-${position}.png`;
				const bytes = pngBytes(name);
				writeFileSync(join(shotsDir, name), bytes);
				shots.push({ position, path: `shots/${name}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
			}
			combos.push({
				viewport,
				theme,
				shots,
				dom: {
					overlap: { ok: true, detail: "перекрытий нет" },
					lastBrand: { ok: true, detail: "последний бренд достижим" },
					horizontalOverflow: { ok: true, detail: "scrollWidth = clientWidth" },
					buttons: { ok: true, detail: "кнопки реагируют" },
					theme: { ok: true, detail: "фон соответствует теме" },
				},
			});
		}
	}

	const evidence: VisualEvidence = {
		version: 1,
		slug,
		url: "http://127.0.0.1:18081/catalog",
		commit: head,
		diffHash: diffHashOf(cwd),
		runId: "vr-test",
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		runner: { keyId: runnerKeyId(publicKey.export({ type: "spki", format: "pem" }).toString()), chrome: "test", host: "test" },
		combos,
		totals: { combos: combos.length, shots: combos.length * VISUAL_POSITIONS.length, failed: 0 },
	};

	const write = (mutate?: (evidence: VisualEvidence) => void): void => {
		const copy = JSON.parse(JSON.stringify(evidence)) as VisualEvidence;
		mutate?.(copy);
		writeFileSync(join(gateDir, "evidence.json"), `${JSON.stringify(copy, null, "\t")}\n`, "utf8");
		const signature = cryptoSign(null, Buffer.from(canonicalJson(copy), "utf8"), privateKey).toString("base64");
		writeFileSync(join(gateDir, "evidence.sig"), `${signature}\n`, "utf8");
	};

	// Подписываем ровно то, что лежит на диске: иначе первый же тест покажет BLOCK.
	write();
	return { cwd, slug, publicKeyPath, evidence, write, shotsDir };
}

function gitHead(cwd: string): string {
	const init = Bun.spawnSync(["git", "init", "-q"], { cwd, stderr: "ignore" });
	void init;
	Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd, stderr: "ignore" });
	Bun.spawnSync(["git", "config", "user.name", "t"], { cwd, stderr: "ignore" });
	writeFileSync(join(cwd, "readme.md"), "# repo\n");
	Bun.spawnSync(["git", "add", "."], { cwd, stderr: "ignore" });
	Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd, stderr: "ignore" });
	const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stderr: "ignore" });
	return proc.stdout.toString().trim();
}

describe("visual gate", () => {
	test("подписанный пакет 16×3 проходит", () => {
		const fixture = makeFixture();
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("PASS");
		expect(verdict.combos).toBe(16);
		expect(verdict.shots).toBe(48);
		expect(verdict.reasons).toEqual([]);
	});

	test("подделанная подпись — BLOCK, а не PASS", () => {
		const fixture = makeFixture();
		writeFileSync(join(fixture.cwd, ".omp", "gate", fixture.slug, "visual", "evidence.sig"), `${Buffer.alloc(64).toString("base64")}\n`);
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("подпись раннера не подтверждена");
	});

	test("изменённый после подписи пакет — BLOCK", () => {
		const fixture = makeFixture();
		fixture.write((copy) => {
			copy.combos[0]!.dom["overlap"] = { ok: false, detail: "перекрытие" };
		});
		// Правим файл уже после подписи.
		const evidencePath = join(fixture.cwd, ".omp", "gate", fixture.slug, "visual", "evidence.json");
		const raw = JSON.parse(readFileSync(evidencePath, "utf8")) as VisualEvidence;
		raw.combos[0]!.dom["overlap"] = { ok: true, detail: "подменили" };
		writeFileSync(evidencePath, JSON.stringify(raw));
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("BLOCK");
	});

	test("подменённый скриншот ловится по sha256 — BLOCK", () => {
		const fixture = makeFixture();
		writeFileSync(join(fixture.shotsDir, "320x640-light-top.png"), pngBytes("другой кадр"));
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("изменены после прогона");
	});

	test("пропущенный viewport — BLOCK", () => {
		const fixture = makeFixture();
		fixture.write((copy) => {
			copy.combos = copy.combos.filter((combo) => !(combo.viewport.width === 430 && combo.viewport.height === 844));
			copy.totals = { combos: copy.combos.length, shots: copy.combos.length * 3, failed: 0 };
		});
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("отсутствуют разрешения");
	});

	test("одна тема вместо двух — BLOCK", () => {
		const fixture = makeFixture();
		fixture.write((copy) => {
			copy.combos = copy.combos.filter((combo) => combo.theme === "light");
			copy.totals = { combos: copy.combos.length, shots: copy.combos.length * 3, failed: 0 };
		});
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("тема dark не проверена");
	});

	test("пустой скриншот — FAIL", () => {
		const onlyEmpty = makeFixture("empty");
		writeFileSync(join(onlyEmpty.shotsDir, "320x640-light-top.png"), Buffer.alloc(10, 1));
		const hash = createHash("sha256").update(Buffer.alloc(10, 1)).digest("hex");
		onlyEmpty.write((copy) => {
			const shot = copy.combos[0]!.shots.find((item) => item.position === "top")!;
			shot.sha256 = hash;
			shot.bytes = 10;
		});
		const emptyVerdict = checkVisual({ cwd: onlyEmpty.cwd, slug: onlyEmpty.slug, publicKeyPath: onlyEmpty.publicKeyPath, checkDiff: false });
		expect(emptyVerdict.status).toBe("FAIL");
		expect(emptyVerdict.reasons.join(" ")).toContain("пустых скриншотов");
	});

	test("проваленная DOM-проверка — FAIL", () => {
		const fixture = makeFixture();
		fixture.write((copy) => {
			copy.combos[3]!.dom["lastBrand"] = { ok: false, detail: "последний бренд закрыт шторкой" };
		});
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, checkDiff: false });
		console.log("DBG dom:", verdict.status, verdict.reasons);
		expect(verdict.status).toBe("FAIL");
		expect(verdict.reasons.join(" ")).toContain("провалены DOM-проверки");
	});

	test("скриншоты от другого commit — BLOCK", () => {
		const fixture = makeFixture();
		fixture.write((copy) => {
			copy.commit = "0".repeat(40);
		});
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath, expectedCommit: gitHead(fixture.cwd) });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("скриншоты сняты с commit");
	});

	test("код изменился после прогона — BLOCK", () => {
		const fixture = makeFixture();
		writeFileSync(join(fixture.cwd, "readme.md"), "# repo\n\nправка после прогона\n");
		const verdict = checkVisual({ cwd: fixture.cwd, slug: fixture.slug, publicKeyPath: fixture.publicKeyPath });
		expect(verdict.status).toBe("BLOCK");
		expect(verdict.reasons.join(" ")).toContain("код менялся после визуального прогона");
	});

	test("раннер не запускался — UNVERIFIED", () => {
		const cwd = mkdtempSync(join(tmpdir(), "vgate-none-"));
		dirs.push(cwd);
		const verdict = checkVisual({ cwd, slug: "ui", publicKeyPath: join(cwd, "nope.pub") });
		expect(verdict.status).toBe("UNVERIFIED");
		expect(verdict.reasons.join(" ")).toContain("browser-runner не запускался");
	});

	test("канонизация и проверка подписи не тавтологичны", () => {
		expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const evidence = { version: 1, slug: "x" } as unknown as VisualEvidence;
		const signature = cryptoSign(null, Buffer.from(canonicalJson(evidence), "utf8"), privateKey).toString("base64");
		expect(verifyEvidenceSignature(evidence, signature, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(true);
		expect(verifyEvidenceSignature({ ...evidence, slug: "y" } as VisualEvidence, signature, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
	});
});
