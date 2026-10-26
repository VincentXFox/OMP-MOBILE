#!/usr/bin/env bun
/**
 * quality-gate — автономная приёмка работы агента.
 *
 * Идея: агент не пишет «доказательства» руками, а объявляет контракт и проверки;
 * движок сам снимает состояние до, выполняет проверки, ловит нарушения инвариантов,
 * зовёт независимого ревьюера и складывает сертификат в файл. Текст финального
 * отчёта печатается из сертификата — подделать строку EVIDENCE, которой нет
 * в сертификате, значит рассинхронизировать отчёт и артефакт.
 *
 * Команды:
 *   init <slug> --task "…" --ac "AC-01: …" [--ac …] [--risk high|normal]
 *        [--check "имя::команда"] [--probe "url::ожидаемый-подстрока"]
 *   run <slug>            выполнить проверки, собрать сертификат
 *   review <slug> [--spawn] [--by reviewer] [--verdict PASS|FAIL] [--note "…"]
 *   verify <slug>         проверить полноту сертификата (код 1, если неполный)
 *   report <slug>         готовый блок отчёта для финального ответа
 *   list                  список сертификатов в .omp/gate
 *
 * Где лежит: ./.omp/gate/<slug>/ (contract.json, certificate.json, certificate.md, logs/)
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";

type Risk = "normal" | "high";

interface CheckSpec {
	name: string;
	cmd: string;
	blocking: boolean;
	timeoutMs: number;
	/** Ожидаемый код выхода: по умолчанию 0, для негативного сценария — ненулевой. */
	expectExit: number;
	/** Какие критерии приёмки эта проверка закрывает (AC-01…). */
	covers: string[];
}

interface Residual {
	text: string;
	reason: string;
	impact: string;
	exitCondition: string;
}

interface SecurityFinding {
	name: string;
	ok: boolean;
	detail: string;
}

interface Adversarial {
	hypothesis: string;
	method: string;
	outcome: string;
}

interface ArtifactHash {
	path: string;
	sha256: string;
}

interface Attestation {
	slug: string;
	at: string;
	certMac: string;
	exitCode: number;
	detail: string;
	by: string;
	mac: string;
}

interface Signature {
	alg: "hmac-sha256";
	keyPath: string;
	mac: string;
	signedAt: string;
}

interface Contract {
	slug: string;
	task: string;
	risk: Risk;
	criteria: { id: string; text: string }[];
	checks: CheckSpec[];
	probes: { name: string; url: string; expect: string }[];
	artifacts: string[];
	adversarial: Adversarial[];
	/** Явные исключения для фикстур/документации: путь + причина, попадают в сертификат. */
	secretExemptions: { path: string; reason: string }[];
	residual: Residual[];
	residualNone: string | null;
	createdAt: string;
	baseline: Record<string, string> | null;
}

interface CheckResult {
	name: string;
	cmd: string;
	blocking: boolean;
	exitCode: number | null;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
	ok: boolean;
	expectExit: number;
	covers: string[];
	logFile: string;
}

interface ProbeResult {
	name: string;
	url: string;
	expect: string;
	status: number | null;
	ok: boolean;
	detail: string;
}

interface Review {
	by: string;
	/** Хеш диффа на момент ревью: если код изменился, вердикт устарел. */
	diffHash?: string;
	independent: boolean;
	verdict: "PASS" | "FAIL" | "N/A";
	note: string;
	at: string;
	supersedesFail?: boolean;
}

interface Certificate {
	slug: string;
	task: string;
	risk: Risk;
	certifiedAt: string;
	criteria: { id: string; text: string }[];
	baseline: Record<string, string>;
	checks: CheckResult[];
	probes: ProbeResult[];
	invariants: { name: string; ok: boolean; detail: string }[];
	after: Record<string, string>;
	regression: { name: string; ok: boolean }[];
	review: Review | null;
	reviews: Review[];
	residual: Residual[];
	/** Заявлено ли «остаточных рисков нет» явно, с охватом проверок. */
	residualNone: string | null;
	security: SecurityFinding[];
	adversarial: Adversarial[];
	artifacts: ArtifactHash[];
	signature: Signature | null;
	status: "ГОТОВО" | "PARTIAL" | "FAILED";
}

const GATE_DIR = ".omp/gate";

/** Ключ подписи живёт ВНЕ проекта: правка сертификата в репозитории ломает MAC. */
const KEY_PATH = process.env.QUALITY_GATE_KEY ?? join(homedir(), ".omp", "gate-key");
/** Внешний журнал: хэш-цепочка прогонов, чтобы историю нельзя было переписать молча. */
const LOG_PATH = process.env.QUALITY_GATE_LOG ?? join(homedir(), ".omp", "gate-log.jsonl");

/** Ключ верификатора отделён от ключа исполнителя: аттестат нельзя подписать «как прогон». */
const VERIFIER_KEY_PATH = process.env.QUALITY_GATE_VERIFIER_KEY ?? join(homedir(), ".omp", "verifier-key");

async function verifierKey(): Promise<Buffer> {
	if (!existsSync(VERIFIER_KEY_PATH)) {
		await mkdir(join(VERIFIER_KEY_PATH, ".."), { recursive: true });
		await writeFile(VERIFIER_KEY_PATH, randomBytes(32).toString("hex"), { mode: 0o600 });
	}
	return Buffer.from((await readFile(VERIFIER_KEY_PATH, "utf8")).trim(), "hex");
}

async function signingKey(): Promise<Buffer> {
	if (!existsSync(KEY_PATH)) {
		await mkdir(join(KEY_PATH, ".."), { recursive: true });
		await writeFile(KEY_PATH, randomBytes(32).toString("hex"), { mode: 0o600 });
	}
	return Buffer.from((await readFile(KEY_PATH, "utf8")).trim(), "hex");
}

/** Стабильная сериализация: порядок ключей не должен менять подпись. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

/** Подписываем всё, что является доказательством, включая RESIDUAL. */
function signedPayload(cert: Certificate): Record<string, unknown> {
	return {
		slug: cert.slug,
		task: cert.task,
		risk: cert.risk,
		certifiedAt: cert.certifiedAt,
		criteria: cert.criteria,
		baseline: cert.baseline,
		checks: cert.checks,
		probes: cert.probes,
		invariants: cert.invariants,
		after: cert.after,
		regression: cert.regression,
		reviews: cert.reviews,
		review: cert.review,
		residual: cert.residual,
		residualNone: cert.residualNone,
		security: cert.security,
		adversarial: cert.adversarial,
		artifacts: cert.artifacts,
		status: cert.status,
	};
}

async function signCert(cert: Certificate): Promise<Signature> {
	const key = await signingKey();
	const mac = createHmac("sha256", key).update(canonical(signedPayload(cert))).digest("hex");
	return { alg: "hmac-sha256", keyPath: KEY_PATH, mac, signedAt: new Date().toISOString() };
}

async function verifySignature(cert: Certificate): Promise<string | null> {
	if (!cert.signature) return "сертификат не подписан";
	const key = await signingKey();
	const expected = createHmac("sha256", key).update(canonical(signedPayload(cert))).digest("hex");
	if (expected !== cert.signature.mac) return "подпись не сходится: артефакт изменён после прогона";
	const chain = await readChain(cert.slug);
	if (chain.length === 0) return "нет записи во внешнем журнале прогонов";
	const last = chain[chain.length - 1];
	if (last?.mac !== cert.signature.mac) return "внешний журнал не подтверждает подпись (mac не совпадает)";
	return null;
}

interface ChainEntry {
	slug: string;
	at: string;
	status: string;
	mac: string;
	prev: string;
}

async function readChain(slug: string): Promise<ChainEntry[]> {
	if (!existsSync(LOG_PATH)) return [];
	const lines = (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean);
	const entries: ChainEntry[] = [];
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as ChainEntry;
			if (entry.slug === slug) entries.push(entry);
		} catch {
			// битая строка журнала не должна ломать проверку: она просто не подтверждает подпись
		}
	}
	return entries;
}

async function appendChain(cert: Certificate, mac: string): Promise<void> {
	const all = existsSync(LOG_PATH) ? (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean) : [];
	const prev = all.length > 0 ? (JSON.parse(all[all.length - 1] as string) as ChainEntry).mac : "";
	await mkdir(join(LOG_PATH, ".."), { recursive: true });
	await writeFile(LOG_PATH, `${all.concat(JSON.stringify({ slug: cert.slug, at: cert.certifiedAt, status: cert.status, mac, prev })).join("\n")}\n`, "utf8");
}

function dirOf(slug: string): string {
	return join(process.cwd(), GATE_DIR, slug);
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

function argValues(argv: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1] as string);
	return out;
}

function argValue(argv: string[], flag: string): string | null {
	const values = argValues(argv, flag);
	return values.length > 0 ? (values[values.length - 1] as string) : null;
}

function hasFlag(argv: string[], flag: string): boolean {
	return argv.includes(flag);
}

function tail(text: string, limit = 400): string {
	const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
	return clean.length <= limit ? clean : `…${clean.slice(-limit)}`;
}

async function execCheck(spec: CheckSpec, logDir: string): Promise<CheckResult> {
	const started = Date.now();
	// Имя лога уникально: две проверки с похожими именами не должны затирать доказательства друг друга.
	const safeName = spec.name.replace(/[^\w.-]+/gu, "_").slice(0, 40);
	const logFile = join(logDir, `${safeName}-${createHash("sha256").update(`${spec.name}\u0000${spec.cmd}`).digest("hex").slice(0, 8)}.log`);
	const { promise: resultPromise, resolve: resolveResult } = Promise.withResolvers<{ code: number | null; out: string; err: string }>();
	const child = spawn("bash", ["-lc", spec.cmd], { cwd: process.cwd(), env: process.env, detached: true });
	let out = "";
	let err = "";
	// Убиваем всю группу: `cmd | cat` держит пайп, обычный kill оставлял гейт висеть.
	const killGroup = (): void => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	const timer = setTimeout(() => {
		killGroup();
		clearTimeout(hardTimer);
		resolveResult({ code: null, out, err: `${err}\n[таймаут ${spec.timeoutMs} мс: процесс убит]` });
	}, spec.timeoutMs);
	// Жёсткая страховка: если внуки всё равно держат пайпы, не ждём их.
	const hardTimer = setTimeout(() => resolveResult({ code: null, out, err: `${err}\n[проверка не закрыла пайпы]` }), spec.timeoutMs + 3000);
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
		if (out.length > 400_000) out = out.slice(-200_000);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		err += chunk.toString();
		if (err.length > 400_000) err = err.slice(-200_000);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		clearTimeout(hardTimer);
		resolveResult({ code, out, err });
	});
	child.on("error", (error) => {
		clearTimeout(timer);
		clearTimeout(hardTimer);
		resolveResult({ code: null, out, err: `${err}\n${String(error)}` });
	});
	const result = await resultPromise;
	await writeFile(logFile, `$ ${spec.cmd}\n\n--- stdout ---\n${result.out}\n--- stderr ---\n${result.err}\n--- exit ${result.code} ---\n`, "utf8");
	return {
		name: spec.name,
		cmd: spec.cmd,
		blocking: spec.blocking,
		exitCode: result.code,
		durationMs: Date.now() - started,
		stdoutTail: tail(result.out),
		stderrTail: tail(result.err),
		// Негативный сценарий ожидает ненулевой код: успех — это совпадение с ожиданием.
		ok: result.code === spec.expectExit,
		expectExit: spec.expectExit,
		covers: spec.covers,
		logFile: logFile.replace(`${process.cwd()}/`, ""),
	};
}

function git(args: string[]): string {
	// Синхронно: снимок базовой линии и список файлов читаются сразу, а не по событию close.
	try {
		const result = Bun.spawnSync(["git", ...args], { cwd: process.cwd() });
		return result.stdout.toString().trim();
	} catch {
		return "";
	}
}

function gitOr(args: string[], fallback = "нет git"): string {
	try {
		const value = git(args);
		return value.length > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

async function snapshotBaseline(risk: Risk, pre = true): Promise<Record<string, string>> {
	const baseline: Record<string, string> = {
		"git HEAD": gitOr(["rev-parse", "--short", "HEAD"]),
		"git изменений": gitOr(["status", "--porcelain"]).split("\n").filter(Boolean).length.toString(),
		"снято": new Date().toISOString(),
	};
	if (risk === "high") {
		const units = ["omp-pocket-gateway", "omp-pocket-runtime", "omp-local-relay"];
		const states: string[] = [];
		for (const unit of units) {
			let state = "недоступно";
			try {
				const child = spawn("systemctl", ["--user", "is-active", unit]);
				const { promise: unitPromise, resolve: resolveUnit } = Promise.withResolvers<number>();
				child.on("close", (code) => resolveUnit(code ?? 1));
				child.on("error", () => resolveUnit(1));
				state = (await unitPromise) === 0 ? "active" : "inactive";
			} catch {
				// на хосте без systemctl состояние просто не наблюдается
			}
			states.push(`${unit}=${state}`);
		}
		baseline[risk === "high" ? (pre ? "юниты до" : "юниты после") : "юниты"] = states.join(", ");
	}
	return baseline;
}

/** Секреты в рабочем диффе — нарушение инварианта, а не «мелочь». */
const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
	{ name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
	{ name: "aws key", re: /AKIA[0-9A-Z]{16}/ },
	{ name: "bearer token", re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
	{ name: "password literal", re: /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}["']/i },
	{ name: "telegram bot token", re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
];

/** Уровень Security: классы уязвимостей, а не стиль. */
const SECURITY_PATTERNS: readonly { name: string; re: RegExp }[] = [
	{ name: "TLS-проверка отключена", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|verify\s*=\s*False|curl[^\n]*-k\b/u },
	{ name: "eval / new Function", re: /\beval\s*\(|new\s+Function\s*\(/u },
	{ name: "shell с интерполяцией", re: /(?:exec|execSync|spawnSync|system)\s*\([^\n]*(?:\$\{|\+\s*\w)|shell\s*=\s*True/u },
	{ name: "SQL из конкатенации", re: /(?:SELECT|INSERT|UPDATE|DELETE)[^\n]{0,80}["'`]\s*\+/iu },
	{ name: "XSS-сток", re: /dangerouslySetInnerHTML|innerHTML\s*=|document\.write\s*\(/u },
	{ name: "расширенные права", re: /chmod\s+777|sudo\s+\S/u },
	{ name: "недоверенный десериализатор", re: /pickle\.loads|yaml\.load\s*\(|unserialize\s*\(/u },
	{ name: "инструкции внутри данных", re: /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions|ты\s+теперь\s+(?:другой|систем)|system\s+prompt\s*:/iu },
];

/** Изменённые строки по файлам: отслеженные (diff) и новые (untracked), без исключённых путей. */
async function collectChanges(exemptPaths: readonly string[]): Promise<Map<string, string[]>> {
	const exempt = new Set(exemptPaths.map((item) => item.trim()).filter(Boolean));
	const changes = new Map<string, string[]>();
	const diff = spawn("git", ["diff", "--unified=0", "HEAD"], { cwd: process.cwd() });
	let diffText = "";
	const { promise, resolve: resolveDiff } = Promise.withResolvers<void>();
	diff.stdout.on("data", (chunk: Buffer) => (diffText += chunk.toString()));
	diff.on("close", () => resolveDiff());
	diff.on("error", () => resolveDiff());
	await promise;
	let file = "";
	for (const line of diffText.split("\n")) {
		const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
		if (header) {
			file = (header[2] ?? header[1] ?? "").trim();
			if (!changes.has(file)) changes.set(file, []);
			continue;
		}
		if (file && line.startsWith("+") && !line.startsWith("+++")) changes.get(file)?.push(line.slice(1));
	}
	const untracked = gitOr(["ls-files", "--others", "--exclude-standard"], "")
		.split("\n")
		.filter(Boolean);
	for (const path of untracked) {
		try {
			const info = await stat(join(process.cwd(), path));
			if (info.size > 2 * 1024 * 1024) {
				changes.set(path, [`[файл ${info.size} байт не прочитан: слишком большой]`]);
				continue;
			}
			changes.set(path, (await readFile(join(process.cwd(), path), "utf8")).split("\n"));
		} catch {
			changes.set(path, ["[файл не прочитан]"]);
		}
	}
	for (const path of exempt) changes.delete(path);
	return changes;
}

/** Секреты и опасные конструкции: ищем по файлам, чтобы исключения работали адресно. */
function scanChanges(changes: Map<string, string[]>): {
	secrets: { file: string; name: string }[];
	security: { file: string; name: string; sample: string }[];
	oversized: string[];
	unreadable: string[];
} {
	const secrets: { file: string; name: string }[] = [];
	const security: { file: string; name: string; sample: string }[] = [];
	const oversized: string[] = [];
	const unreadable: string[] = [];
	for (const [file, lines] of changes) {
		const text = lines.join("\n");
		if (text.startsWith("[файл ") && text.includes("слишком большой]")) oversized.push(file);
		if (text === "[файл не прочитан]") unreadable.push(file);
		for (const pattern of SECRET_PATTERNS) if (pattern.re.test(text)) secrets.push({ file, name: pattern.name });
		for (const pattern of SECURITY_PATTERNS) {
			const match = pattern.re.exec(text);
			if (match) security.push({ file, name: pattern.name, sample: match[0].slice(0, 80) });
		}
	}
	return { secrets, security, oversized, unreadable };
}

async function invariants(
	checks: readonly CheckSpec[],
	exemptions: readonly { path: string; reason: string }[],
): Promise<{ name: string; ok: boolean; detail: string }[]> {
	const result: { name: string; ok: boolean; detail: string }[] = [];
	const changes = await collectChanges(exemptions.map((item) => item.path));
	const scanned = scanChanges(changes);
	const files = [...changes.keys()];
	result.push({
		name: "секреты не в диффе",
		ok: scanned.secrets.length === 0 && scanned.oversized.length === 0 && scanned.unreadable.length === 0,
		detail:
			scanned.secrets.length > 0
				? `найдено: ${scanned.secrets.map((item) => `${item.name} в ${item.file}`).join(", ")}`
				: scanned.oversized.length > 0 || scanned.unreadable.length > 0
					? `не проверено полностью: ${[...scanned.oversized.map((f) => `${f} > 2 МиБ`), ...scanned.unreadable.map((f) => `${f} не прочитан`)].join(", ").slice(0, 200)}`
					: `файлов ${files.length}, совпадений 0${exemptions.length > 0 ? `; исключения: ${exemptions.map((item) => item.path).join(", ")}` : ""}`,
	});
	const destructive = checks.filter((check) => /(?:push\s+(?:--force|-f)|reset\s+--hard|clean\s+-fdx)/u.test(check.cmd));
	result.push({
		name: "в проверках нет необратимых git-команд",
		ok: destructive.length === 0,
		detail:
			destructive.length === 0
				? `проверено объявленных команд: ${checks.length}`
				: `найдено в проверках: ${destructive.map((check) => check.name).join(", ")}`,
	});
	return result;
}

/** Уровень Security: классы уязвимостей в изменённых файлах (включая новые). */
async function securityScan(exemptPaths: readonly string[]): Promise<SecurityFinding[]> {
	const changes = await collectChanges(exemptPaths);
	const scanned = scanChanges(changes);
	return SECURITY_PATTERNS.map((pattern) => {
		const hits = scanned.security.filter((item) => item.name === pattern.name);
		return {
			name: pattern.name,
			ok: hits.length === 0,
			detail: hits.length > 0 ? hits.map((item) => `${item.file}: ${item.sample}`).join("; ").slice(0, 200) : "не найдено",
		};
	});
}

async function probe(spec: Contract["probes"][number]): Promise<ProbeResult> {
	try {
		const res = await fetch(spec.url, { signal: AbortSignal.timeout(10_000) });
		const body = await res.text();
		const ok = res.ok && body.includes(spec.expect);
		return { ...spec, status: res.status, ok, detail: ok ? `HTTP ${res.status}, ожидаемое найдено` : `HTTP ${res.status}, ожидаемое «${spec.expect}» не найдено` };
	} catch (error) {
		return { ...spec, status: null, ok: false, detail: `запрос не выполнен: ${String(error).slice(0, 120)}` };
	}
}

async function loadContract(slug: string): Promise<Contract> {
	const path = join(dirOf(slug), "contract.json");
	if (!existsSync(path)) throw new Error(`нет контракта: ${path} — сначала quality-gate init ${slug}`);
	return JSON.parse(await readFile(path, "utf8")) as Contract;
}

async function loadCertificate(slug: string): Promise<Certificate> {
	const path = join(dirOf(slug), "certificate.json");
	if (!existsSync(path)) throw new Error(`нет сертификата: ${path} — сначала quality-gate run ${slug}`);
	return JSON.parse(await readFile(path, "utf8")) as Certificate;
}

function formatReport(cert: Certificate): string {
	const lines: string[] = [];
	lines.push(`CONTRACT: ${cert.criteria.map((c) => `${c.id} ${c.text}`).join("; ")}`);
	const baseline = Object.entries(cert.baseline)
		.map(([k, v]) => `${k} = ${v}`)
		.join(", ");
	lines.push(`BASELINE: ${baseline}`);
	for (const check of cert.checks) {
		lines.push(`EVIDENCE [${check.name}]: ${check.cmd} → код ${check.exitCode ?? "нет"} за ${check.durationMs} мс${check.ok ? "" : `; stderr: ${check.stderrTail || "пусто"}`}`);
	}
	for (const item of cert.probes) lines.push(`EVIDENCE [${item.name}]: ${item.url} → ${item.status ?? "нет ответа"}, ${item.detail}`);
	lines.push(`REGRESSION: ${cert.regression.map((r) => `${r.name} → ${r.ok ? "PASS" : "FAIL"}`).join("; ") || "проверок не объявлено"}`);
	lines.push(`INVARIANTS: ${cert.invariants.map((i) => `${i.name} → ${i.ok ? "соблюдён" : "НАРУШЕН"} (${i.detail})`).join("; ")}`);
	if (cert.risk === "high") {
		lines.push(`OBSERVABILITY: юниты после = ${cert.after["юниты после"] ?? "не снимались"}; git после = ${cert.after["git HEAD"] ?? "?"}`);
		lines.push(`ROLLBACK: git ${cert.baseline["git HEAD"] ?? "?"} → откат рабочего дерева, PLANNED (не проверялся)`);
	}
	lines.push(`INDEPENDENT REVIEW: ${cert.review ? `${cert.review.by} → ${cert.review.verdict} (${cert.review.note})` : "не проводилась"}`);
	lines.push(
		`RESIDUAL: ${
			cert.residual.length > 0
				? cert.residual.map((item) => `${item.text} (причина: ${item.reason}; влияние: ${item.impact}; снимается: ${item.exitCondition})`).join("; ")
				: cert.residualNone
					? `явных рисков не заявлено: ${cert.residualNone}`
					: "НЕ ЗАЯВЛЕН — это не доказательство отсутствия рисков"
		}`,
	);
	lines.push(`SECURITY: ${cert.security.length > 0 ? cert.security.map((item) => `${item.name} → ${item.ok ? "чисто" : "НАЙДЕНО"}`).join("; ") : "сканер не запускался"}`);
	lines.push(`ADVERSARIAL: ${cert.adversarial.length > 0 ? cert.adversarial.map((item) => `${item.hypothesis} → ${item.method} → ${item.outcome}`).join("; ") : "состязательных записей нет"}`);
	lines.push(`INTEGRITY: ${cert.artifacts.length > 0 ? cert.artifacts.map((item) => `${item.path} ${item.sha256.slice(0, 12)}…`).join("; ") : "артефакты не закреплялись"}`);
	lines.push(`SIGNATURE: ${cert.signature ? `${cert.signature.alg} ${cert.signature.mac.slice(0, 16)}… (ключ вне проекта: ${cert.signature.keyPath})` : "ОТСУТСТВУЕТ"}`);
	lines.push(`СЕРТИФИКАТ: ${join(GATE_DIR, cert.slug, "certificate.json")} · статус ${cert.status}`);
	return lines.join("\n");
}

async function writeCertificate(cert: Certificate): Promise<void> {
	const dir = dirOf(cert.slug);
	cert.signature = await signCert(cert);
	await appendChain(cert, cert.signature.mac);
	await writeFile(join(dir, "certificate.json"), `${JSON.stringify(cert, null, "\t")}\n`, "utf8");
	const md = ["# Сертификат приёмки", "", `Задача: ${cert.task}`, `Риск: ${cert.risk}`, `Статус: ${cert.status}`, "", "```text", formatReport(cert), "```", ""].join("\n");
	await writeFile(join(dir, "certificate.md"), md, "utf8");
}

async function cmdInit(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate init <slug> --task … --ac …");
	const dir = dirOf(slug);
	await ensureDir(join(dir, "logs"));
	const criteria = argValues(argv, "--ac").map((text, index) => ({
		id: /^AC-\d+/i.test(text) ? (text.match(/^AC-\d+/i)?.[0] as string) : `AC-0${index + 1}`,
		text: text.replace(/^AC-\d+[:.\s]*/i, ""),
	}));
	if (criteria.length === 0) throw new Error("нужен хотя бы один --ac \"AC-01: <проверяемое требование>\"");
	const expectMap = new Map<string, number>();
	for (const raw of argValues(argv, "--expect")) {
		const [name, code] = raw.split("=");
		if (!name || code === undefined) throw new Error(`ожидаемый код задаётся как «имя=код»: ${raw}`);
		expectMap.set(name.trim(), Number(code));
	}
	const coversMap = new Map<string, string[]>();
	for (const raw of argValues(argv, "--covers")) {
		const [name, list] = raw.split("=");
		if (!name || !list) throw new Error(`покрытие задаётся как «имя=AC-01,AC-02»: ${raw}`);
		coversMap.set(
			name.trim(),
			list.split(",").map((item) => item.trim().toUpperCase()),
		);
	}
	const checks = argValues(argv, "--check").map((raw) => {
		const [name, ...rest] = raw.split("::");
		if (rest.length === 0) throw new Error(`проверка должна быть «имя::команда»: ${raw}`);
		const cmd = rest.join("::");
		const trimmed = (name ?? "check").trim();
		return {
			name: trimmed,
			cmd,
			blocking: !cmd.includes("# nonblocking"),
			timeoutMs: Number(argValue(argv, "--timeout") ?? 300) * 1000,
			expectExit: expectMap.get(trimmed) ?? 0,
			covers: coversMap.get(trimmed) ?? [],
		};
	});
	// Остаток обязан нести причину, влияние и условие снятия — иначе это не риск, а отговорка.
	const residual = argValues(argv, "--residual").map((raw) => {
		const [text, reason, impact, exitCondition] = raw.split("::");
		if (!text || !reason || !impact || !exitCondition)
			throw new Error(`остаточный риск задаётся как «текст::причина::влияние::условие снятия»: ${raw}`);
		return { text: text.trim(), reason: reason.trim(), impact: impact.trim(), exitCondition: exitCondition.trim() };
	});
	const residualNone = argValue(argv, "--residual-none");
	const secretExemptions = argValues(argv, "--allow-secret-path").map((raw) => {
		const [path, ...rest] = raw.split("::");
		return { path: (path ?? "").trim(), reason: rest.join("::").trim() || "без пояснения" };
	});
	const probes = argValues(argv, "--probe").map((raw) => {
		const [url, ...rest] = raw.split("::");
		if (rest.length === 0) throw new Error(`проба должна быть «url::ожидаемая-подстрока»: ${raw}`);
		return { name: `проба ${url}`, url: url as string, expect: rest.join("::") };
	});
	const adversarial = argValues(argv, "--adversarial").map((raw) => {
		const [hypothesis, method, outcome] = raw.split("::");
		if (!hypothesis || !method || !outcome)
			throw new Error(`состязательная запись — «гипотеза::метод::исход»: ${raw}`);
		const placeholders = new Set(["x", "y", "z", "test", "todo", "n/a", "na", "нет", "ok", "-"]);
		if ([hypothesis, method, outcome].some((part) => part.trim().length < 4 || placeholders.has(part.trim().toLowerCase())))
			throw new Error(`состязательная запись — заглушка, нужна настоящая гипотеза и исход: ${raw}`);
		return { hypothesis: hypothesis.trim(), method: method.trim(), outcome: outcome.trim() };
	});
	const risk = (argValue(argv, "--risk") ?? "normal") === "high" ? "high" : "normal";
	const contract: Contract = {
		slug,
		task: argValue(argv, "--task") ?? slug,
		risk,
		criteria,
		checks,
		probes,
		artifacts: argValues(argv, "--artifact"),
		adversarial,
		secretExemptions,
		residual,
		residualNone,
		createdAt: new Date().toISOString(),
		// «До» снимается здесь, на старте контракта: иначе правка успевает попасть в базовую линию.
		baseline: await snapshotBaseline(risk),
	};
	await writeFile(join(dir, "contract.json"), `${JSON.stringify(contract, null, "\t")}\n`, "utf8");
	console.log(`контракт: ${join(GATE_DIR, slug, "contract.json")} · критериев ${criteria.length}, проверок ${checks.length}, проб ${probes.length}, риск ${risk}`);
	return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate run <slug>");
	const contract = await loadContract(slug);
	const dir = dirOf(slug);
	// Каталог логов мог быть удалён между прогонами: не падаем, а создаём заново.
	await ensureDir(join(dir, "logs"));
	const baseline = contract.baseline ?? (await snapshotBaseline(contract.risk));
	const checks: CheckResult[] = [];
	for (const spec of contract.checks) checks.push(await execCheck(spec, join(dir, "logs")));
	const probes: ProbeResult[] = [];
	for (const spec of contract.probes) probes.push(await probe(spec));
	const inv = await invariants(contract.checks, contract.secretExemptions);
	const security = await securityScan(contract.secretExemptions.map((item) => item.path));
	const artifacts = contract.artifacts.map((path) => hashFile(path)).filter((item): item is ArtifactHash => item !== null);
	const after = await snapshotBaseline(contract.risk, false);
	const blockingFailed = checks.filter((check) => check.blocking && !check.ok).map((check) => check.name);
	const probesFailed = probes.filter((item) => !item.ok).map((item) => item.name);
	const invariantsFailed = inv.filter((item) => !item.ok).map((item) => item.name);
	const securityFailed = security.filter((item) => !item.ok).map((item) => item.name);
	const failed = [...blockingFailed, ...probesFailed, ...invariantsFailed, ...securityFailed];
	const residual: Residual[] = [...contract.residual];
	for (const name of failed) {
		residual.push({
			text: `проверка «${name}» не прошла`,
			reason: "код выхода не совпал с ожидаемым",
			impact: "критерий приёмки не доказан",
			exitCondition: "починить причину и повторить прогон",
		});
	}
	const prevCert = existsSync(join(dir, "certificate.json"))
		? (JSON.parse(await readFile(join(dir, "certificate.json"), "utf8")) as Certificate)
		: null;
	const prevReview = prevCert?.review ?? null;
	const reviewHistory = prevCert?.reviews ?? (prevReview ? [prevReview] : []);
	const failStanding = reviewHistory.some((item) => item.verdict === "FAIL") && prevReview?.verdict !== "PASS";
	// Провал ревьюера не стирается повторным прогоном: иначе FAIL отмывается обычным `run`.
	const cert: Certificate = {
		slug,
		task: contract.task,
		risk: contract.risk,
		certifiedAt: new Date().toISOString(),
		criteria: contract.criteria,
		baseline,
		checks,
		probes,
		invariants: inv,
		security,
		adversarial: contract.adversarial,
		artifacts,
		after,
		regression: checks.map((check) => ({ name: check.name, ok: check.ok })),
		review: prevReview,
		reviews: reviewHistory,
		residual,
		residualNone: contract.residualNone,
		signature: null,
		status: failed.length > 0 || failStanding || prevReview?.verdict === "FAIL" ? "FAILED" : "PARTIAL",
	};
	await writeCertificate(cert);
	console.log(formatReport(cert));
	// Провал ревьюера — тоже провал прогона, иначе код выхода маскирует FAILED.
	return failed.length > 0 || cert.status === "FAILED" ? 1 : 0;
}

async function cmdReview(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate review <slug>");
	const cert = await loadCertificate(slug);
	const dir = dirOf(slug);
	const by = (argValue(argv, "--by") ?? "reviewer").trim();
	// Независимость — белый список, а не чёрный: иначе автор называет себя любым словом и проходит.
	const INDEPENDENT_BY = /^(?:reviewer|security-reviewer|revьюер|review|subagent:[\w.-]+|agent:[\w.-]+)$/iu;
	// Имя, которым автор называет самого себя, не делает проверку независимой даже в форме subagent:<имя>.
	const AUTHOR_WORDS = /^(?:self|builder|author|me|я|сам|автор|кодер|разработчик)$/iu;
	const innerName = /^(?:subagent|agent):(.+)$/iu.exec(by)?.[1] ?? by;
	if (!hasFlag(argv, "--spawn") && (!INDEPENDENT_BY.test(by) || AUTHOR_WORDS.test(innerName))) {
		console.error(`«${by}» не считается независимым ревьюером: укажи --by reviewer|security-reviewer|subagent:<имя> или запусти --spawn`);
		return 2;
	}
	let review: Review;
	if (hasFlag(argv, "--spawn")) {
		const diff = gitOr(["diff", "HEAD"], "");
		const prompt =
			"Ты независимый ревьюер. Ниже дифф изменений и критерии приёмки. Найди контрпримеры: что могло сломаться, " +
			"что не доказано, где доказательство подменяет поведение. Ответь ровно двумя строками: " +
			"`VERDICT: PASS|FAIL` и `NOTE: <одна строка>`. Не верь утверждениям автора — только тому, что видно.\n\n" +
			`Критерии: ${cert.criteria.map((c) => `${c.id} ${c.text}`).join("; ")}\n\nДифф:\n${diff.slice(0, 60_000)}`;
		const child = spawn("omp", ["-p", prompt], { cwd: process.cwd(), env: { ...process.env, OMP_NO_HOOKS: "1" }, detached: true });
		let out = "";
		const timeoutMs = Number(argValue(argv, "--review-timeout") ?? 240) * 1000;
		const { promise: reviewPromise, resolve: resolveReview } = Promise.withResolvers<void>();
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", () => {});
		child.on("close", () => resolveReview());
		child.on("error", () => resolveReview());
		// Ревьюер может промолчать (провайдер, лимит): тогда это N/A, а не зависание и не PASS.
		const killer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			out += "\n[ревьюер не ответил за отведённое время]";
			resolveReview();
		}, timeoutMs);
		await reviewPromise;
		clearTimeout(killer);
		await writeFile(join(dir, "review.log"), out, "utf8");
		const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(out)?.[1]?.toUpperCase() as "PASS" | "FAIL" | undefined;
		const note = /NOTE:\s*(.+)/i.exec(out)?.[1]?.trim() ?? "ревьюер не дал строку NOTE";
		review = { by: "omp -p ревьюер", independent: verdict !== undefined, verdict: verdict ?? "N/A", note, at: new Date().toISOString(), diffHash: await diffHashNow() };
	} else {
		const by = argValue(argv, "--by") ?? "reviewer";
		const verdict = (argValue(argv, "--verdict") ?? "N/A") as Review["verdict"];
		review = {
			by,
			independent: !["builder", "self"].includes(by.toLowerCase()),
			verdict,
			note: argValue(argv, "--note") ?? "без пояснения",
			at: new Date().toISOString(),
			diffHash: await diffHashNow(),
		};
	}
	const history = cert.reviews ?? (cert.review ? [cert.review] : []);
	const hadFail = history.some((item) => item.verdict === "FAIL");
	if (review.verdict === "PASS" && hadFail && !hasFlag(argv, "--supersede")) {
		console.error("в истории есть FAIL: перекрыть его можно только явно — добавь --supersede и причину в --note");
		return 2;
	}
	if (review.verdict === "PASS" && hadFail) review.supersedesFail = true;
	cert.reviews = [...history, review];
	cert.review = review;
	cert.status =
		review.verdict === "FAIL"
			? "FAILED"
			: review.verdict === "PASS" && cert.status === "PARTIAL"
				? "ГОТОВО"
				: review.verdict === "N/A"
					? cert.status === "ГОТОВО"
						? "PARTIAL"
						: cert.status
					: cert.status;
	await writeCertificate(cert);
	console.log(`REVIEW: ${review.by} → ${review.verdict} (${review.note}); статус сертификата ${cert.status}`);
	return review.verdict === "FAIL" ? 1 : 0;
}

/** Заглушка вместо проверки: код выхода ничего не доказывает. */
const TRIVIAL_RE = /^(?:true|:|echo\b.*|printf\b.*|sleep\s+\d+s?|\/bin\/true)$/u;

async function missingParts(cert: Certificate): Promise<string[]> {
	const missing: string[] = [];
	if (!Array.isArray(cert.checks) || !Array.isArray(cert.criteria) || !Array.isArray(cert.invariants))
		return ["сертификат повреждён: нет обязательных массивов criteria/checks/invariants"];
	const integrity = await verifySignature(cert);
	if (integrity) missing.push(integrity);
	// Уровень Integrity: файлы должны остаться теми же, что проверялись.
	const changedArtifacts = (cert.artifacts ?? []).filter((item) => hashFile(item.path)?.sha256 !== item.sha256);
	if (changedArtifacts.length > 0)
		missing.push(`артефакты изменились после проверки: ${changedArtifacts.map((item) => item.path).join(", ")}`);
	// Уровень Security: найденная уязвимость — не «мелочь стиля».
	const securityFailed = (cert.security ?? []).filter((item) => !item.ok);
	if (securityFailed.length > 0) missing.push(`безопасность: ${securityFailed.map((item) => item.name).join(", ")}`);
	// Уровень Adversarial: для рискованной работы нужна хотя бы одна запись «гипотеза → метод → исход».
	if (cert.risk === "high" && (cert.adversarial ?? []).length === 0)
		missing.push("нет состязательной проверки (гипотеза → метод → исход)");
	// Аттестация независимым процессом: сертификат должен быть подтверждён аттестатом.
	const attestation = await readAttestation(cert.slug);
	// Аттестация проверяет всё, кроме самой себя: иначе верификатор не может стартовать.
	if (cert.risk === "high" && !attestation && process.env.QUALITY_GATE_ATTESTING !== "1")
		missing.push("нет аттестации независимым верификатором (quality-gate attest)");
	if (process.env.QUALITY_GATE_ATTESTING !== "1" && attestation) {
		if (attestation.certMac !== cert.signature?.mac) missing.push("аттестат относится к другой версии сертификата");
		if (attestation.exitCode !== 0) missing.push("аттестат отрицательный: верификатор не подтвердил результат");
	}
	// Заглушки и проверки без ожидаемого результата не считаются доказательством.
	const trivial = cert.checks.filter((check) => TRIVIAL_RE.test(check.cmd.trim()));
	if (trivial.length > 0) missing.push(`проверки-заглушки: ${trivial.map((check) => check.name).join(", ")}`);
	const covered = new Set(cert.checks.filter((check) => check.ok).flatMap((check) => check.covers ?? []));
	const uncovered = cert.criteria.map((item) => item.id).filter((id) => !covered.has(id));
	if (uncovered.length > 0) missing.push(`критерии без доказательства (N/A): ${uncovered.join(", ")}`);
	if (cert.risk === "high" && !cert.checks.some((check) => (check.expectExit ?? 0) !== 0))
		missing.push("нет негативного сценария (ожидаемый ненулевой код)");
	// Ревью N/A — это «заключения нет», а не пройденная проверка.
	if (cert.review !== null && cert.review.verdict === "N/A") missing.push("ревью не состоялось (N/A): заключения нет");
	if (cert.risk === "high" && (cert.review === null || cert.review.verdict === "N/A"))
		missing.push("для рискованной работы нужен состоявшийся независимый вердикт");
	// Остаток: каждая запись обязана объяснять причину, влияние и условие снятия.
	const badResidual = cert.residual.filter(
		(item) => [item.text, item.reason, item.impact, item.exitCondition].some((value) => !value || !value.trim()),
	);
	if (badResidual.length > 0) missing.push(`остаточные риски без причины/влияния/условия: ${badResidual.map((item) => item.text).join(", ")}`);
	if (cert.residual.length === 0 && !cert.residualNone)
		missing.push("RESIDUAL не заявлен (отсутствие записи не доказывает отсутствие рисков)");
	if (cert.criteria.length === 0) missing.push("критерии приёмки (CONTRACT)");
	if (cert.criteria.some((item) => item.text.trim().length === 0)) missing.push("пустой текст критерия (CONTRACT)");
	if (cert.checks.length === 0 && cert.probes.length === 0) missing.push("ни одной выполненной проверки (EVIDENCE)");
	// Сертификат — артефакт: лог каждой проверки должен существовать, лежать внутри .omp/gate и
	// содержать именно свою команду и код выхода, иначе «доказательство» подменяется пустым файлом.
	const badLogs: string[] = [];
	for (const check of cert.checks) {
		const rel = String(check.logFile ?? "").replaceAll("\\", "/");
		const inside = rel.startsWith(`${GATE_DIR}/`) && !rel.includes("..");
		const full = join(process.cwd(), rel);
		if (!inside || !existsSync(full)) {
			badLogs.push(`${check.name}: ${inside ? "лог отсутствует" : "лог вне .omp/gate"}`);
			continue;
		}
		let text = "";
		try {
			text = await readFile(full, "utf8");
		} catch {
			badLogs.push(`${check.name}: лог не читается`);
			continue;
		}
		if (!text.includes(`$ ${check.cmd}`) || !text.includes(`--- exit ${check.exitCode ?? "нет"} ---`))
			badLogs.push(`${check.name}: лог не соответствует команде и коду выхода`);
	}
	if (badLogs.length > 0) missing.push(`логи проверок: ${badLogs.join("; ")}`);
	if (cert.checks.some((check) => !check.ok && check.blocking)) missing.push("проваленные блокирующие проверки");
	if (cert.invariants.length === 0 || cert.invariants.some((item) => !item.ok)) missing.push("инварианты (INVARIANTS)");
	const certifiedAt = Date.parse(String(cert.certifiedAt ?? ""));
	if (!Number.isFinite(certifiedAt) || Date.now() - certifiedAt > 24 * 60 * 60 * 1000) missing.push("сертификат старше суток");
	if (cert.review !== null && cert.review.verdict === "FAIL") missing.push("вердикт ревьюера FAIL");
	// Ревью, выданное до последних правок, ничего не подтверждает.
	if (cert.review !== null && cert.review.diffHash && cert.review.diffHash !== (await diffHashNow()))
		missing.push("ревью устарело: код менялся после вердикта");
	// История ревью — не декорация: стоящий FAIL закрывается только записью с supersedesFail.
	// Массив reviews — часть артефакта: его отсутствие означает, что либо ревью не было,
	// либо историю подчистили, чтобы спрятать FAIL. И то и другое не приёмка.
	if ((cert.risk === "high" || cert.review !== null) && (!Array.isArray(cert.reviews) || cert.reviews.length === 0))
		missing.push("нет истории ревью (reviews[])");
	const history = Array.isArray(cert.reviews) ? cert.reviews : [];
	const lastHistory = history[history.length - 1];
	const sameReview = (a?: Review | null, b?: Review | null): boolean =>
		Boolean(a && b && a.by === b.by && a.at === b.at && a.verdict === b.verdict);
	if (history.length > 0 && !sameReview(lastHistory, cert.review)) missing.push("cert.review не совпадает с последней записью reviews[]");
	const failing = history.some((item) => item.verdict === "FAIL");
	const superseded = history.some((item) => item.verdict === "PASS" && item.supersedesFail === true);
	if (failing && !superseded) missing.push("в истории ревью есть FAIL без явного --supersede");
	// Сертификат обязан быть самосогласованным: ok = (exitCode === 0).
	const inconsistent = cert.checks.filter((check) => check.ok !== (check.exitCode === (check.expectExit ?? 0)));
	if (inconsistent.length > 0) missing.push(`ok не совпадает с кодом выхода: ${inconsistent.map((check) => check.name).join(", ")}`);
	if (cert.risk === "high" && cert.review === null) missing.push("независимая проверка (REVIEW) для рискованной работы");
	if (cert.risk === "high" && cert.review !== null && cert.review.verdict !== "PASS") missing.push("вердикт ревьюера не PASS");
	if (cert.review !== null && cert.review.independent !== true) missing.push("ревьюер не независим (independent=false)");
	const by = String(cert.review?.by ?? "").trim();
	const INDEPENDENT_BY = /^(?:reviewer|security-reviewer|revьюер|review|subagent:[\w.-]+|agent:[\w.-]+)$/iu;
	const AUTHOR_WORDS = /^(?:self|builder|author|me|я|сам|автор|кодер|разработчик)$/iu;
	const innerName = /^(?:subagent|agent):(.+)$/iu.exec(by)?.[1] ?? by;
	if (cert.review !== null && (!INDEPENDENT_BY.test(by) || AUTHOR_WORDS.test(innerName)))
		missing.push(`ревьюер «${by}» не независим`);
	if (cert.status === "FAILED") missing.push("статус сертификата FAILED");
	return missing;
}

/** Отпечаток рабочего дерева: ревью, выданное на другой дифф, недействительно. */
async function diffHashNow(): Promise<string> {
	const diff = spawn("git", ["diff", "HEAD"], { cwd: process.cwd() });
	let text = "";
	const { promise, resolve: resolveDiff } = Promise.withResolvers<void>();
	diff.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
	diff.on("close", () => resolveDiff());
	diff.on("error", () => resolveDiff());
	await promise;
	// Собственные артефакты приёмки не считаются правкой кода.
	const status = gitOr(["status", "--porcelain"], "")
		.split("\n")
		.filter((line) => line.length > 0 && !line.includes(".omp/gate"))
		.sort()
		.join("\n");
	return createHash("sha256").update(`${text}\n${status}`).digest("hex").slice(0, 16);
}

function attestationPath(slug: string): string {
	return join(process.cwd(), ".omp", "gate", slug, "attestation.json");
}

async function readAttestation(slug: string): Promise<Attestation | null> {
	const path = attestationPath(slug);
	if (!existsSync(path)) return null;
	try {
		const data = JSON.parse(await readFile(path, "utf8")) as Attestation;
		const key = await verifierKey();
		const { mac, ...rest } = data;
		const expected = createHmac("sha256", key).update(canonical(rest)).digest("hex");
		return expected === mac ? data : null;
	} catch {
		return null;
	}
}

/**
 * Независимый верификатор: проверка выполняется отдельным процессом (systemd scope),
 * и её результат подписывается отдельно от прогона. Агент-исполнитель не пишет «PASS»
 * сам — он лишь может запустить верификатор, а тот решает.
 */
async function cmdAttest(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate attest <slug>");
	const cert = await loadCertificate(slug);
	if (!cert.signature) {
		console.error("сертификат не подписан — аттестация невозможна");
		return 1;
	}
	const engine = join(import.meta.dir, "quality-gate.ts");
	// Старый аттестат не должен влиять на новую проверку.
	try {
		await rm(attestationPath(slug), { force: true });
	} catch {
		// файла нет — и хорошо
	}
	// Отдельный процесс вне окружения исполнителя: systemd scope, если он есть.
	const command = existsSync("/usr/bin/systemd-run")
		? ["systemd-run", "--user", "--scope", "--quiet", "--", "bun", engine, "verify", slug]
		: ["bun", engine, "verify", slug];
	const child = spawn(command[0] as string, command.slice(1), {
		cwd: process.cwd(),
		env: { ...process.env, QUALITY_GATE_ATTESTING: "1" },
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
	const { promise, resolve } = Promise.withResolvers<number>();
	child.on("close", (code) => resolve(code ?? 1));
	child.on("error", () => resolve(1));
	const code = await promise;
	const key = await verifierKey();
	const body = {
		slug,
		at: new Date().toISOString(),
		certMac: cert.signature.mac,
		exitCode: code,
		detail: (code === 0 ? out : err || out).trim().slice(0, 400),
		by: "systemd-verify",
	};
	const mac = createHmac("sha256", key).update(canonical(body)).digest("hex");
	await writeFile(attestationPath(slug), `${JSON.stringify({ ...body, mac }, null, "\t")}\n`, "utf8");
	console.log(`АТТЕСТАЦИЯ: ${code === 0 ? "PASS" : "FAIL"} · ${body.detail}`);
	return code === 0 ? 0 : 1;
}

/** Контрольная точка: слепок рабочего дерева для отката неудачного изменения. */
async function cmdSnapshot(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate snapshot <slug>");
	const dir = dirOf(slug);
	await ensureDir(dir);
	const patch = await new Promise<string>((resolvePromise) => {
		const child = spawn("git", ["diff", "HEAD"], { cwd: process.cwd() });
		let out = "";
		const { promise, resolve } = Promise.withResolvers<void>();
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.on("close", () => resolve());
		child.on("error", () => resolve());
		promise.then(() => resolvePromise(out));
	});
	await writeFile(join(dir, "rollback.patch"), patch, "utf8");
	// Неотслеженные файлы в патч не попадают: фиксируем их отдельно, иначе откат оставит мусор.
	const untracked = gitOr(["ls-files", "--others", "--exclude-standard"], "")
		.split("\n")
		.filter(Boolean)
		.map((path) => ({ path, sha256: hashFile(path)?.sha256 ?? "" }));
	await writeFile(join(dir, "rollback-untracked.json"), `${JSON.stringify(untracked, null, "\t")}\n`, "utf8");
	const head = gitOr(["rev-parse", "HEAD"], "");
	await writeFile(join(dir, "rollback.json"), `${JSON.stringify({ head, files: patch.split("\n").filter((line) => line.startsWith("diff --git")).length, at: new Date().toISOString() }, null, "\t")}\n`, "utf8");
	console.log(`контрольная точка: ${join(GATE_DIR, slug, "rollback.patch")} · файлов ${patch.split("\n").filter((line) => line.startsWith("diff --git")).length}, HEAD ${head.slice(0, 8)}`);
	return 0;
}

async function cmdRollback(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate rollback <slug>");
	if (!hasFlag(argv, "--approve")) {
		console.error("откат меняет рабочее дерево: это требует --approve \"причина\" (граница, а не препятствие)");
		return 3;
	}
	const patchPath = join(dirOf(slug), "rollback.patch");
	if (!existsSync(patchPath)) {
		console.error(`нет контрольной точки: сначала quality-gate snapshot ${slug}`);
		return 1;
	}
	// Сначала убираем новые файлы, появившиеся после контрольной точки.
	const untrackedPath = join(dirOf(slug), "rollback-untracked.json");
	if (existsSync(untrackedPath)) {
		const recorded = JSON.parse(await readFile(untrackedPath, "utf8")) as { path: string; sha256: string }[];
		const current = new Set(
			gitOr(["ls-files", "--others", "--exclude-standard"], "")
				.split("\n")
				.filter(Boolean),
		);
		for (const item of recorded) {
			if (!current.has(item.path)) continue;
			// Удаляем только то, что не изменилось с момента снимка: чужие правки не трогаем.
			if (item.sha256 && hashFile(item.path)?.sha256 !== item.sha256) continue;
			try {
				await rm(join(process.cwd(), item.path), { force: true });
			} catch {
				// файл уже удалён — откат продолжается
			}
		}
	}
	const child = spawn("git", ["apply", "--reverse", patchPath], { cwd: process.cwd() });
	let err = "";
	child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
	const { promise, resolve } = Promise.withResolvers<number>();
	child.on("close", (code) => resolve(code ?? 1));
	child.on("error", () => resolve(1));
	const code = await promise;
	if (code !== 0) {
		console.error(`откат не применился: ${err.trim().slice(0, 200)}`);
		return 1;
	}
	console.log("откат применён: рабочее дерево вернулось к контрольной точке");
	return 0;
}

async function cmdVerify(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate verify <slug>");
	const cert = await loadCertificate(slug);
	const missing = await missingParts(cert);
	if (missing.length > 0) {
		console.error(`сертификат неполный: ${missing.join("; ")}`);
		return 1;
	}
	console.log(`сертификат полный: ${join(GATE_DIR, slug, "certificate.json")} · статус ${cert.status}`);
	return 0;
}

async function cmdReport(argv: string[]): Promise<number> {
	const slug = argv[1];
	if (!slug) throw new Error("нужен slug: quality-gate report <slug>");
	const cert = await loadCertificate(slug);
	console.log(formatReport(cert));
	return 0;
}

async function cmdList(): Promise<number> {
	const root = join(process.cwd(), GATE_DIR);
	if (!existsSync(root)) {
		console.log("сертификатов нет");
		return 0;
	}
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const certPath = join(root, entry.name, "certificate.json");
		if (!existsSync(certPath)) {
			console.log(`${entry.name}: контракт без прогона`);
			continue;
		}
		const cert = JSON.parse(await readFile(certPath, "utf8")) as Certificate;
		console.log(`${entry.name}: ${cert.status} · проверок ${cert.checks.length} · риск ${cert.risk} · ${cert.certifiedAt}`);
	}
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0];
	switch (command) {
		case "init":
			return cmdInit(argv);
		case "run":
			return cmdRun(argv);
		case "review":
			return cmdReview(argv);
		case "verify":
			return cmdVerify(argv);
		case "attest":
			return cmdAttest(argv);
		case "snapshot":
			return cmdSnapshot(argv);
		case "rollback":
			return cmdRollback(argv);
		case "report":
			return cmdReport(argv);
		case "list":
			return cmdList();
		default:
			console.error("команды: init | run | review | verify | attest | snapshot | rollback | report | list");
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(`ошибка приёмки: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	});
