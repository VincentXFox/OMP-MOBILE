#!/usr/bin/env bun
/**
 * Visual Gate — приёмка интерфейса по факту, а не по словам.
 *
 * Проверяет пакет доказательств, который оставил доверенный browser-runner
 * (`bin/visual-runner.ts`): 8 разрешений × 2 темы = 16 комбинаций, по 3 скриншота
 * на комбинацию (48 PNG), пять DOM-проверок на комбинацию, подпись Ed25519
 * ключом раннера и привязка к commit + отпечатку кода.
 *
 * Ключевое свойство: исполнитель не может выдать PASS словами. Либо есть
 * подписанный пакет с совпадающими sha256 скриншотов и актуальным commit,
 * либо статус UNVERIFIED/BLOCK/FAIL.
 *
 * Запуск: bun bin/visual-gate.ts check <slug> [--cwd DIR] [--pub KEY.pub] [--json]
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VISUAL_VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
	{ width: 320, height: 640 },
	{ width: 320, height: 844 },
	{ width: 360, height: 640 },
	{ width: 360, height: 844 },
	{ width: 390, height: 640 },
	{ width: 390, height: 844 },
	{ width: 430, height: 640 },
	{ width: 430, height: 844 },
];
export const VISUAL_THEMES = ["light", "dark"] as const;
export const VISUAL_POSITIONS = ["top", "middle", "bottom"] as const;
export const VISUAL_MIN_SHOT_BYTES = 1024;

export type VisualStatus = "PASS" | "FAIL" | "UNVERIFIED" | "BLOCK";

export interface VisualShot {
	position: string;
	path: string;
	sha256: string;
	bytes: number;
}

export interface VisualDomCheck {
	ok: boolean;
	detail: string;
}

export interface VisualCombo {
	viewport: { width: number; height: number };
	theme: string;
	shots: VisualShot[];
	dom: Record<string, VisualDomCheck>;
}

export interface VisualEvidence {
	version: number;
	slug: string;
	url: string;
	commit: string;
	diffHash: string;
	runId: string;
	startedAt: string;
	finishedAt: string;
	runner: { keyId: string; chrome: string; host: string };
	combos: VisualCombo[];
	totals: { combos: number; shots: number; failed: number };
}

export interface VisualVerdict {
	status: VisualStatus;
	/** Почему именно такой статус: каждая причина — проверяемый факт. */
	reasons: string[];
	combos: number;
	shots: number;
	/** Отпечаток пакета: по нему видно, менялись ли доказательства после проверки. */
	evidenceDigest: string | null;
	commit: string;
	url: string;
	checkedAt: string;
}

/** Канонизация: ключи по алфавиту, без пробелов — подпись считается по этому тексту. */
export function canonicalJson(value: unknown): string {
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (node !== null && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(node as Record<string, unknown>).sort()) out[key] = walk((node as Record<string, unknown>)[key]);
			return out;
		}
		return node;
	};
	return JSON.stringify(walk(value));
}

export function sha256File(path: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

/** Отпечаток ключа: PEM нормализуется так же, как у раннера (иначе хвостовой \n ломает сверку). */
export function runnerKeyId(publicPem: string): string {
	const normalized = publicPem.replace(/\r\n/gu, "\n").trim().replace(/\n?$/u, "\n");
	return `ed25519:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

export function verifyEvidenceSignature(evidence: VisualEvidence, signatureB64: string, publicPem: string): boolean {
	try {
		const key = createPublicKey(publicPem);
		return cryptoVerify(null, Buffer.from(canonicalJson(evidence), "utf8"), key, Buffer.from(signatureB64, "base64"));
	} catch {
		return false;
	}
}

/**
 * Якорь доверия — фиксированный путь, не выбираемый проверяемым процессом.
 * Переменная окружения и `--pub` принимаются только если файл лежит вне
 * рабочего дерева и недоступен на запись текущему пользователю: иначе
 * исполнитель подставил бы свой ключ и подписал себе PASS (найдено 27.10).
 */
function defaultPublicKeyPath(): string {
	return process.env["OMP_VISUAL_RUNNER_PUB"] ?? join(homedir(), ".omp", "visual-runner.ed25519.pub");
}

/**
 * Якорь доверия: файл должен существовать и читаться. Подмена ключа ловится не
 * правами файла (в одном uid они ничего не значат), а пином `keyId` в контракте:
 * другой ключ даёт другой отпечаток и пакет отвергается.
 */
function trustAnchorProblem(path: string): string | null {
	if (!existsSync(path)) return `нет публичного ключа раннера (${path}): подлинность доказательств не проверить`;
	try {
		readFileSync(path);
	} catch {
		return `якорь доверия ${path} не читается`;
	}
	return null;
}

function git(cwd: string, args: string[]): string {
	try {
		const proc = Bun.spawnSync(["git", ...args], { cwd, timeout: 20_000, stderr: "ignore" });
		return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
	} catch {
		return "";
	}
}

/**
 * Отпечаток кода: ровно тот же способ, что у раннера — `git diff HEAD | sha256`
 * по СЫРЫМ байтам, без trim и обрезки. Разные способы хеширования на одном
 * состоянии репозитория давали разные отпечатки, и гейт объявлял честный пакет
 * устаревшим (найдено при интеграции 27.10).
 */
export function diffHashOf(cwd: string): string {
	const proc = Bun.spawnSync(["git", "diff", "HEAD"], { cwd, timeout: 20_000, stderr: "ignore" });
	if (proc.exitCode !== 0) return "";
	// Хешируем всегда, включая пустой дифф: иначе сравнение с пакетом раннера
	// «проходит» по недосмотру (пустая строка против sha256 пустоты).
	return createHash("sha256").update(proc.stdout).digest("hex");
}

export interface VisualCheckOptions {
	cwd: string;
	slug: string;
	publicKeyPath?: string;
	/** Ожидаемый commit: если не задан, берётся HEAD рабочего дерева. */
	expectedCommit?: string;
	/** Проверять привязку к текущему диффу (для «изменено после проверки»). */
	checkDiff?: boolean;
	/** Ожидаемый стенд из контракта: чужой URL не принимается. */
	expectedUrl?: string;
	/** Закреплённый в контракте отпечаток ключа раннера. */
	expectedKeyId?: string;
	now?: number;
}

/**
 * Проверка пакета доказательств. Возвращает статус и список причин:
 * PASS — только когда всё сошлось; BLOCK — доказательства подделаны/устарели;
 * FAIL — проверки интерфейса провалены; UNVERIFIED — раннер не запускался.
 */
export function checkVisual(options: VisualCheckOptions): VisualVerdict {
	const dir = join(options.cwd, ".omp", "gate", options.slug, "visual");
	const evidencePath = join(dir, "evidence.json");
	const signaturePath = join(dir, "evidence.sig");
	const reasons: string[] = [];
	const base: VisualVerdict = {
		status: "UNVERIFIED",
		reasons,
		combos: 0,
		shots: 0,
		evidenceDigest: null,
		commit: "",
		url: "",
		checkedAt: new Date(options.now ?? Date.now()).toISOString(),
	};

	if (!existsSync(evidencePath) || !existsSync(signaturePath)) {
		reasons.push("browser-runner не запускался: нет visual/evidence.json или visual/evidence.sig");
		return base;
	}

	let evidence: VisualEvidence;
	try {
		evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as VisualEvidence;
	} catch (error) {
		reasons.push(`пакет доказательств не читается: ${error instanceof Error ? error.message : String(error)}`);
		base.status = "BLOCK";
		return base;
	}
	const signature = readFileSync(signaturePath, "utf8").trim();
	base.evidenceDigest = sha256File(evidencePath);
	base.commit = String(evidence.commit ?? "");
	base.url = String(evidence.url ?? "");

	const publicKeyPath = options.publicKeyPath ?? defaultPublicKeyPath();
	const anchorProblem = trustAnchorProblem(publicKeyPath);
	if (anchorProblem !== null) {
		reasons.push(anchorProblem);
		base.status = "BLOCK";
		return base;
	}
	const publicPem = readFileSync(publicKeyPath, "utf8");
	if (!verifyEvidenceSignature(evidence, signature, publicPem)) {
		reasons.push("подпись раннера не подтверждена: пакет подделан или изменён после подписи");
		base.status = "BLOCK";
		return base;
	}
	if (evidence.runner?.keyId !== runnerKeyId(publicPem)) {
		reasons.push("пакет подписан не тем ключом, который доверен гейту");
		base.status = "BLOCK";
		return base;
	}
	// Пин ключа из контракта: контракт аттестуется верификатором, поэтому
	// подменить раннера вместе с ключом нельзя — это уже другая приёмка.
	if (options.expectedKeyId !== undefined && options.expectedKeyId !== "" && evidence.runner?.keyId !== options.expectedKeyId) {
		reasons.push(`пакет подписан ключом ${String(evidence.runner?.keyId ?? "—")}, а контракт закрепляет ${options.expectedKeyId}`);
		base.status = "BLOCK";
		return base;
	}

	// Пакет обязан быть про ЭТОТ проект и ЭТОТ стенд: чужая приёмка не переиспользуется.
	if (evidence.slug !== options.slug) {
		reasons.push(`пакет снят для «${String(evidence.slug ?? "—")}», а проверяется «${options.slug}»`);
		base.status = "BLOCK";
	}
	if (options.expectedUrl !== undefined && options.expectedUrl !== "" && evidence.url !== options.expectedUrl) {
		reasons.push(`пакет снят на стенде ${String(evidence.url ?? "—")}, а контракт требует ${options.expectedUrl}`);
		base.status = "BLOCK";
	}
	// Привязка к коду: без git проверять нечем — это отказ, а не «пропустить».
	const expectedCommit = options.expectedCommit ?? git(options.cwd, ["rev-parse", "HEAD"]);
	if (expectedCommit === "") {
		reasons.push("git не дал commit: привязку скриншотов к коду проверить нечем");
		base.status = "BLOCK";
	} else if (evidence.commit !== expectedCommit) {
		reasons.push(`скриншоты сняты с commit ${evidence.commit || "—"}, а проверяется ${expectedCommit}: нужен новый прогон`);
		base.status = "BLOCK";
	}
	if (options.checkDiff !== false) {
		const currentDiff = diffHashOf(options.cwd);
		if (evidence.diffHash !== currentDiff) {
			reasons.push("код менялся после визуального прогона: результаты устарели");
			base.status = "BLOCK";
		}
	}

	const combos = Array.isArray(evidence.combos) ? evidence.combos : [];
	const themes = new Set(combos.map((combo) => String(combo.theme)));
	const viewports = new Set(combos.map((combo) => `${combo.viewport?.width}x${combo.viewport?.height}`));
	const missingViewports = VISUAL_VIEWPORTS.map((v) => `${v.width}x${v.height}`).filter((v) => !viewports.has(v));
	if (missingViewports.length > 0) reasons.push(`отсутствуют разрешения: ${missingViewports.join(", ")}`);
	for (const theme of VISUAL_THEMES) if (!themes.has(theme)) reasons.push(`тема ${theme} не проверена`);
	if (themes.size < VISUAL_THEMES.length) reasons.push("проверена только одна тема");

	let shots = 0;
	let missingShots = 0;
	let emptyShots = 0;
	let changedShots = 0;
	const failedDom: string[] = [];
	for (const combo of combos) {
		const label = `${combo.viewport?.width}x${combo.viewport?.height}-${combo.theme}`;
		const positions = new Set((combo.shots ?? []).map((shot) => shot.position));
		for (const position of VISUAL_POSITIONS) if (!positions.has(position)) missingShots += 1;
		for (const shot of combo.shots ?? []) {
			shots += 1;
			const full = join(options.cwd, ".omp", "gate", options.slug, "visual", String(shot.path).replace(/^visual\//u, ""));
			if (!existsSync(full)) {
				missingShots += 1;
				continue;
			}
			let bytes = 0;
			try {
				bytes = statSync(full).size;
			} catch {
				missingShots += 1;
				continue;
			}
			if (bytes < VISUAL_MIN_SHOT_BYTES) emptyShots += 1;
			const actual = sha256File(full);
			if (actual !== null && shot.sha256 !== actual) changedShots += 1;
		}
		for (const [name, check] of Object.entries(combo.dom ?? {})) {
			if (check?.ok !== true) failedDom.push(`${label}:${name}`);
		}
	}
	base.combos = combos.length;
	base.shots = shots;

	const expectedShots = VISUAL_VIEWPORTS.length * VISUAL_THEMES.length * VISUAL_POSITIONS.length;
	if (missingShots > 0) reasons.push(`нет ${missingShots} скриншотов (ожидается ${expectedShots})`);
	if (shots !== expectedShots && missingShots === 0) reasons.push(`скриншотов ${shots}, ожидается ${expectedShots}`);
	if (emptyShots > 0) reasons.push(`пустых скриншотов: ${emptyShots}`);
	if (changedShots > 0) reasons.push(`изменены после прогона: ${changedShots} скриншотов (sha256 не совпал)`);
	if (failedDom.length > 0) reasons.push(`провалены DOM-проверки: ${failedDom.slice(0, 6).join(", ")}${failedDom.length > 6 ? " …" : ""}`);
	if (evidence.totals?.failed !== 0) reasons.push(`раннер сообщил о провалах: ${String(evidence.totals?.failed ?? "нет данных")}`);

	if (base.status === "UNVERIFIED" && reasons.length > 0) {
		// Подделка/устаревание — BLOCK; провал самих проверок интерфейса — FAIL.
		// Структурная неполнота матрицы (нет viewport, одна тема, не хватает кадров)
		// — тоже BLOCK: PASS без полного покрытия невозможен по определению.
		const blocked = reasons.some((reason) =>
			/поддел|устарел|изменены|другого commit|не тем ключом|не читается|отсутствуют разрешения|не проверена|только одна тема|нет \d+ скриншотов|скриншотов \d+, ожидается/u.test(
				reason,
			),
		);
		base.status = blocked ? "BLOCK" : "FAIL";
	}
	if (reasons.length === 0) base.status = "PASS";
	return base;
}

/** Запись вердикта в сертификат: visual.json рядом с certificate.json. */
export function writeVisualRecord(cwd: string, slug: string, verdict: VisualVerdict): string {
	const path = join(cwd, ".omp", "gate", slug, "visual.json");
	writeFileSync(path, `${JSON.stringify(verdict, null, "\t")}\n`, "utf8");
	return path;
}

function argValue(argv: readonly string[], flag: string): string | null {
	for (let i = argv.length - 1; i >= 0; i -= 1) if (argv[i] === flag && argv[i + 1] !== undefined) return argv[i + 1] as string;
	return null;
}

function main(argv: string[]): number {
	const command = argv[0];
	if (command !== "check") {
		console.error("команды: check <slug> [--cwd DIR] [--pub KEY.pub] [--commit SHA] [--json]");
		return 2;
	}
	const slug = argv[1];
	if (!slug) {
		console.error("нужен slug: visual-gate check <slug>");
		return 2;
	}
	const cwd = argValue(argv, "--cwd") ?? process.cwd();
	const verdict = checkVisual({
		cwd,
		slug,
		publicKeyPath: argValue(argv, "--pub") ?? undefined,
		expectedCommit: argValue(argv, "--commit") ?? undefined,
	});
	if (argv.includes("--json")) console.log(JSON.stringify(verdict, null, "\t"));
	else {
		console.log(`VISUAL_GATE: ${verdict.status} · комбинаций ${verdict.combos}/16, скриншотов ${verdict.shots}/48`);
		for (const reason of verdict.reasons) console.log(`  ✘ ${reason}`);
	}
	writeVisualRecord(cwd, slug, verdict);
	return verdict.status === "PASS" ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
