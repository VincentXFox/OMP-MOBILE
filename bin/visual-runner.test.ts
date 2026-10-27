import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMatrix,
	canonicalize,
	countFailures,
	DEFAULT_CHROME,
	DEFAULT_KEY_PATH,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_VIEWPORTS,
	type Evidence,
	generateKeyPairPem,
	isShotEmpty,
	keyIdFor,
	loadOrCreateKey,
	MIN_SHOT_BYTES,
	parseArgs,
	parseThemes,
	parseViewports,
	sha256Hex,
	shotPath,
	signEvidence,
	verifyEvidence,
	type Viewport,
} from "./visual-runner.ts";

const VIEWPORTS: Viewport[] = [
	{ width: 320, height: 640 },
	{ width: 390, height: 844 },
];

function sampleEvidence(): Evidence {
	const checks = { ok: true, detail: "ок" };
	return {
		version: 1,
		slug: "catalog",
		url: "http://127.0.0.1:18081/catalog",
		commit: "1774d4d",
		diffHash: "0123456789abcdef",
		runId: "vr-0123456789abcdef",
		startedAt: "2026-10-28T00:00:00.000Z",
		finishedAt: "2026-10-28T00:01:00.000Z",
		runner: { keyId: "ed25519:deadbeefdeadbeef", chrome: "Google Chrome 156.0.0.0", host: "host" },
		combos: [
			{
				viewport: { width: 320, height: 640 },
				theme: "light",
				shots: [{ position: "top", path: "shots/320x640-light-top.png", sha256: sha256Hex("png-bytes"), bytes: 4096 }],
				dom: { overlap: checks, lastBrand: checks, horizontalOverflow: checks, buttons: checks, theme: checks },
			},
		],
		totals: { combos: 1, shots: 1, failed: 0 },
	};
}

describe("канонизация JSON", () => {
	test("ключи отсортированы, без пробелов, порядок входа не важен", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }));
		expect(canonicalize({ "": "empty-key" })).toBe('{"":"empty-key"}');
	});

	test("вложенность и массивы сохраняют порядок", () => {
		expect(canonicalize({ z: [3, { b: 1, a: 2 }], a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1},"z":[3,{"a":2,"b":1}]}');
	});

	test("кириллица и спецсимволы не ломают канонизацию", () => {
		const canonical = canonicalize({ текст: "Показать 45819 товаров", quote: 'a"b', slash: "a\\b" });
		expect(canonical).toBe('{"quote":"a\\"b","slash":"a\\\\b","текст":"Показать 45819 товаров"}');
		expect(JSON.parse(canonical)).toEqual({ quote: 'a"b', slash: "a\\b", текст: "Показать 45819 товаров" });
	});

	test("числа и null", () => {
		expect(canonicalize({ b: null, a: 1.5 })).toBe('{"a":1.5,"b":null}');
	});
});

describe("ключи Ed25519", () => {
	test("keyId — sha256 публичного PEM, первые 16 hex", () => {
		const path = join(mkdtempSync(join(tmpdir(), "vr-keys-")), "k.ed25519");
		const pair = loadOrCreateKey(path);
		const expected = `ed25519:${sha256Hex(`${pair.publicPem.trimEnd()}\n`).slice(0, 16)}`;
		expect(keyIdFor(pair.publicPem)).toBe(expected);
		expect(keyIdFor(pair.publicPem)).toMatch(/^ed25519:[0-9a-f]{16}$/);
		rmSync(path.replace(/\/[^/]+$/, ""), { recursive: true, force: true });
	});

	test("ключ создаётся с правами 600 и повторно не перезаписывается", () => {
		const dir = mkdtempSync(join(tmpdir(), "vr-keys2-"));
		const path = join(dir, "visual-runner.ed25519");
		const first = loadOrCreateKey(path);
		expect(existsSync(path)).toBe(true);
		expect(existsSync(`${path}.pub`)).toBe(true);
		expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
		const second = loadOrCreateKey(path);
		expect(second.privatePem).toBe(first.privatePem);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("подпись пакета Ed25519", () => {
	const pair = generateKeyPairPem();

	test("честный пакет проверяется", () => {
		const evidence = sampleEvidence();
		const signature = signEvidence(evidence, pair.privatePem);
		expect(signature.length).toBeGreaterThan(80);
		expect(verifyEvidence(evidence, signature, pair.publicPem)).toBe(true);
	});

	test("изменённый байт подписи не проходит", () => {
		const evidence = sampleEvidence();
		const signature = signEvidence(evidence, pair.privatePem);
		const raw = Buffer.from(signature, "base64");
		raw[10] = (raw[10] ?? 0) ^ 0x01;
		expect(verifyEvidence(evidence, raw.toString("base64"), pair.publicPem)).toBe(false);
	});

	test("подделанный пакет (изменён url) не проходит", () => {
		const evidence = sampleEvidence();
		const signature = signEvidence(evidence, pair.privatePem);
		const forged: Evidence = { ...evidence, url: "http://evil.example/catalog" };
		expect(verifyEvidence(forged, signature, pair.publicPem)).toBe(false);
	});

	test("изменён sha256 скриншота или счётчики не проходят", () => {
		const evidence = sampleEvidence();
		const signature = signEvidence(evidence, pair.privatePem);
		const shotForged = structuredClone(evidence);
		const shot = shotForged.combos[0]?.shots[0];
		if (!shot) throw new Error("нет скриншота в образце");
		shot.sha256 = sha256Hex("другие байты");
		expect(verifyEvidence(shotForged, signature, pair.publicPem)).toBe(false);
		const totalsForged = structuredClone(evidence);
		totalsForged.totals.failed = 0;
		totalsForged.totals.shots = 48;
		expect(verifyEvidence(totalsForged, signature, pair.publicPem)).toBe(false);
	});

	test("чужим публичным ключом подпись не подтверждается", () => {
		const evidence = sampleEvidence();
		const stranger = generateKeyPairPem();
		const signature = signEvidence(evidence, pair.privatePem);
		expect(verifyEvidence(evidence, signature, stranger.publicPem)).toBe(false);
	});

	test("подпись не зависит от порядка ключей в памяти", () => {
		const a = sampleEvidence();
		const b: Evidence = {
			totals: a.totals,
			combos: a.combos,
			runner: a.runner,
			finishedAt: a.finishedAt,
			startedAt: a.startedAt,
			runId: a.runId,
			diffHash: a.diffHash,
			commit: a.commit,
			url: a.url,
			slug: a.slug,
			version: 1,
		};
		expect(signEvidence(a, pair.privatePem)).toBe(signEvidence(b, pair.privatePem));
	});
});

describe("пустой скриншот", () => {
	test("порог 1024 байта: меньше — пусто", () => {
		expect(MIN_SHOT_BYTES).toBe(1024);
		expect(isShotEmpty(0)).toBe(true);
		expect(isShotEmpty(1)).toBe(true);
		expect(isShotEmpty(1023)).toBe(true);
		expect(isShotEmpty(1024)).toBe(false);
		expect(isShotEmpty(120_000)).toBe(false);
	});
});

describe("разбор --viewports", () => {
	test("по умолчанию восемь viewport'ов из спецификации", () => {
		expect(parseViewports(DEFAULT_VIEWPORTS)).toEqual([
			{ width: 320, height: 640 },
			{ width: 320, height: 844 },
			{ width: 360, height: 640 },
			{ width: 360, height: 844 },
			{ width: 390, height: 640 },
			{ width: 390, height: 844 },
			{ width: 430, height: 640 },
			{ width: 430, height: 844 },
		]);
	});

	test("пробелы и один viewport", () => {
		expect(parseViewports(" 320x640 , 390x844 ")).toEqual(VIEWPORTS);
		expect(parseViewports("320x640")).toEqual([{ width: 320, height: 640 }]);
	});

	test("кривой ввод — ошибка, а не молчаливый пропуск", () => {
		expect(() => parseViewports("")).toThrow();
		expect(() => parseViewports("320")).toThrow();
		expect(() => parseViewports("320x")).toThrow();
		expect(() => parseViewports("320*640")).toThrow();
		expect(() => parseViewports("10x640")).toThrow();
	});

	test("темы: только light/dark, дубликаты убираются", () => {
		expect(parseThemes("light,dark")).toEqual(["light", "dark"]);
		expect(parseThemes("dark")).toEqual(["dark"]);
		expect(parseThemes(" LIGHT , DARK ")).toEqual(["light", "dark"]);
		expect(() => parseThemes("light,sepia")).toThrow();
		expect(() => parseThemes("")).toThrow();
	});
});

describe("пути и матрица", () => {
	test("пути скриншотов — shots/<W>x<H>-<theme>-<position>.png", () => {
		expect(shotPath({ width: 320, height: 640 }, "light", "top")).toBe("shots/320x640-light-top.png");
		expect(shotPath({ width: 430, height: 844 }, "dark", "bottom")).toBe("shots/430x844-dark-bottom.png");
	});

	test("матрица 8×2 = 16 комбинаций в порядке viewport→theme", () => {
		const matrix = buildMatrix(parseViewports(DEFAULT_VIEWPORTS), ["light", "dark"]);
		expect(matrix.length).toBe(16);
		expect(matrix[0]).toEqual({ viewport: { width: 320, height: 640 }, theme: "light" });
		expect(matrix[1]).toEqual({ viewport: { width: 320, height: 640 }, theme: "dark" });
		expect(matrix[15]).toEqual({ viewport: { width: 430, height: 844 }, theme: "dark" });
	});

	test("негативный контроль: 1 viewport × 1 тема = 2 комбинации, 6 скриншотов", () => {
		const matrix = buildMatrix([{ width: 320, height: 640 }], ["light"]);
		expect(matrix.length).toBe(1);
		expect(matrix.length * 3).toBe(3);
		expect(buildMatrix([{ width: 320, height: 640 }], ["light", "dark"]).length).toBe(2);
		expect(buildMatrix([{ width: 320, height: 640 }], ["light", "dark"]).length * 3).toBe(6);
	});

	test("счётчик провалов видит пустые скриншоты и упавшие проверки", () => {
		const combos = [
			{
				viewport: { width: 320, height: 640 },
				theme: "light" as const,
				shots: [
					{ position: "top" as const, path: "a", sha256: "x", bytes: 5000 },
					{ position: "middle" as const, path: "b", sha256: "", bytes: 0 },
					{ position: "bottom" as const, path: "c", sha256: "y", bytes: 2048 },
				],
				dom: {
					overlap: { ok: true, detail: "" },
					lastBrand: { ok: false, detail: "перекрыт" },
					horizontalOverflow: { ok: true, detail: "" },
					buttons: { ok: true, detail: "" },
					theme: { ok: true, detail: "" },
				},
			},
		];
		expect(countFailures(combos, 3)).toBe(2);
		expect(countFailures([], 3)).toBe(0);
	});
});

describe("аргументы командной строки", () => {
	test("обязательные флаги и значения по умолчанию", () => {
		const options = parseArgs(["--url", "http://127.0.0.1/catalog", "--slug", "catalog", "--out", "/tmp/out"]);
		expect(options.url).toBe("http://127.0.0.1/catalog");
		expect(options.slug).toBe("catalog");
		expect(options.viewports.length).toBe(8);
		expect(options.themes).toEqual(["light", "dark"]);
		expect(options.keyPath).toBe(DEFAULT_KEY_PATH);
		expect(options.chrome).toBe(DEFAULT_CHROME);
		expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
		expect(options.keepOpen).toBe(false);
		expect(options.commit).toBeUndefined();
	});

	test("--keep-open, --themes и --viewports нестандартные", () => {
		const options = parseArgs([
			"--url", "http://x/", "--slug", "s", "--out", "/tmp/out",
			"--viewports", "320x640", "--themes", "light", "--keep-open", "--timeout-ms", "5000",
		]);
		expect(options.viewports).toEqual([{ width: 320, height: 640 }]);
		expect(options.themes).toEqual(["light"]);
		expect(options.keepOpen).toBe(true);
		expect(options.timeoutMs).toBe(5000);
	});

	test("без обязательных флагов и с неизвестным флагом — ошибка", () => {
		expect(() => parseArgs(["--url", "http://x/"])).toThrow();
		expect(() => parseArgs(["--url", "http://x/", "--slug", "s", "--out", "/tmp/o", "--nope", "1"])).toThrow();
		expect(() => parseArgs(["--url"])).toThrow();
		expect(() => parseArgs(["позиционный"])).toThrow();
		expect(() => parseArgs(["--url", "http://x/", "--slug", "s", "--out", "/tmp/o", "--diff-hash"])).toThrow();
	});
});
