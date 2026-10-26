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
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

type Risk = "normal" | "high";

interface CheckSpec {
	name: string;
	cmd: string;
	blocking: boolean;
	timeoutMs: number;
}

interface Contract {
	slug: string;
	task: string;
	risk: Risk;
	criteria: { id: string; text: string }[];
	checks: CheckSpec[];
	probes: { name: string; url: string; expect: string }[];
	/** Явные исключения для фикстур/документации: путь + причина, попадают в сертификат. */
	secretExemptions: { path: string; reason: string }[];
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
	residual: string[];
	status: "ГОТОВО" | "PARTIAL" | "FAILED";
}

const GATE_DIR = ".omp/gate";

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
		ok: result.code === 0,
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

async function invariants(
	checks: readonly CheckSpec[],
	exemptions: readonly { path: string; reason: string }[],
): Promise<{ name: string; ok: boolean; detail: string }[]> {
	const result: { name: string; ok: boolean; detail: string }[] = [];
	// 1. Секреты не попадают в изменения. Усечение по символам давало ложный PASS на больших файлах,
	// поэтому читаем файл целиком до 2 МиБ, а всё, что больше, честно помечаем как непроверенное.
	const diff = spawn("git", ["diff", "--unified=0", "HEAD"], { cwd: process.cwd() });
	let diffText = "";
	const { promise: diffPromise, resolve: resolveDiff } = Promise.withResolvers<void>();
	diff.stdout.on("data", (chunk: Buffer) => (diffText += chunk.toString()));
	diff.on("close", () => resolveDiff());
	diff.on("error", () => resolveDiff());
	await diffPromise;
	const scannedParts: string[] = diffText
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
	const untracked = gitOr(["ls-files", "--others", "--exclude-standard"], "")
		.split("\n")
		.filter(Boolean);
	const oversized: string[] = [];
	const readFailed: string[] = [];
	for (const file of untracked) {
		try {
			const path = join(process.cwd(), file);
			const info = await stat(path);
			if (info.size > 2 * 1024 * 1024) {
				oversized.push(file);
				continue;
			}
			const content = await readFile(path, "utf8");
			scannedParts.push(`+ ${file}`, ...content.split("\n").map((line) => `+${line}`));
		} catch {
			readFailed.push(file);
		}
	}
	const added = scannedParts.join("\n");
	// Исключения не вычищают строки молча: находки в них перечисляются в отчёте.
	const exemptHits: string[] = [];
	for (const exemption of exemptions) {
		const pattern = SECRET_PATTERNS.find((item) => item.re.test(added) && added.includes(exemption.path));
		if (pattern) exemptHits.push(`${exemption.path}: ${pattern.name}`);
	}
	const hits = SECRET_PATTERNS.filter((pattern) => pattern.re.test(added)).map((pattern) => pattern.name);
	result.push({
		name: "секреты не в диффе",
		ok: hits.length === 0 && oversized.length === 0 && readFailed.length === 0,
		detail:
			hits.length > 0
				? `найдено: ${hits.join(", ")}`
				: oversized.length > 0 || readFailed.length > 0
					? `не проверено полностью: ${[...oversized.map((f) => `${f} > 2 МиБ`), ...readFailed.map((f) => `${f} не прочитан`)].join(", ").slice(0, 200)}`
					: `строк ${scannedParts.length}, файлов ${untracked.length}, совпадений 0${exemptHits.length > 0 ? `; исключения: ${exemptHits.join("; ")}` : ""}`,
	});
	// 2. Необратимые git-команды. Наблюдать чужие вызовы мы не можем, поэтому проверяем ровно то,
	// что видим: команды объявленных проверок и наличие точки возврата для отката рабочего дерева.
	const destructive = checks.filter((check) =>
		/(?:push\s+(?:--force|-f)|reset\s+--hard|clean\s+-fdx)/u.test(check.cmd),
	);
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
	lines.push(`RESIDUAL: ${cert.residual.length > 0 ? cert.residual.join("; ") : "в охвате выполненных проверок дефектов не найдено"}`);
	lines.push(`СЕРТИФИКАТ: ${join(GATE_DIR, cert.slug, "certificate.json")} · статус ${cert.status}`);
	return lines.join("\n");
}

async function writeCertificate(cert: Certificate): Promise<void> {
	const dir = dirOf(cert.slug);
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
	const checks = argValues(argv, "--check").map((raw) => {
		const [name, ...rest] = raw.split("::");
		if (rest.length === 0) throw new Error(`проверка должна быть «имя::команда»: ${raw}`);
		const cmd = rest.join("::");
		return {
			name: (name ?? "check").trim(),
			cmd,
			blocking: !cmd.includes("# nonblocking"),
			timeoutMs: Number(argValue(argv, "--timeout") ?? 300) * 1000,
		};
	});
	const secretExemptions = argValues(argv, "--allow-secret-path").map((raw) => {
		const [path, ...rest] = raw.split("::");
		return { path: (path ?? "").trim(), reason: rest.join("::").trim() || "без пояснения" };
	});
	const probes = argValues(argv, "--probe").map((raw) => {
		const [url, ...rest] = raw.split("::");
		if (rest.length === 0) throw new Error(`проба должна быть «url::ожидаемая-подстрока»: ${raw}`);
		return { name: `проба ${url}`, url: url as string, expect: rest.join("::") };
	});
	const risk = (argValue(argv, "--risk") ?? "normal") === "high" ? "high" : "normal";
	const contract: Contract = {
		slug,
		task: argValue(argv, "--task") ?? slug,
		risk,
		criteria,
		checks,
		probes,
		secretExemptions,
		createdAt: new Date().toISOString(),
		baseline: null,
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
	const after = await snapshotBaseline(contract.risk, false);
	const blockingFailed = checks.filter((check) => check.blocking && !check.ok).map((check) => check.name);
	const probesFailed = probes.filter((item) => !item.ok).map((item) => item.name);
	const invariantsFailed = inv.filter((item) => !item.ok).map((item) => item.name);
	const failed = [...blockingFailed, ...probesFailed, ...invariantsFailed];
	const residual: string[] = [];
	if (failed.length > 0) residual.push(`не прошли проверки: ${failed.join(", ")}`);
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
		after,
		regression: checks.map((check) => ({ name: check.name, ok: check.ok })),
		review: prevReview,
		reviews: reviewHistory,
		residual,
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
		review = { by: "omp -p ревьюер", independent: verdict !== undefined, verdict: verdict ?? "N/A", note, at: new Date().toISOString() };
	} else {
		const by = argValue(argv, "--by") ?? "reviewer";
		const verdict = (argValue(argv, "--verdict") ?? "N/A") as Review["verdict"];
		review = {
			by,
			independent: !["builder", "self"].includes(by.toLowerCase()),
			verdict,
			note: argValue(argv, "--note") ?? "без пояснения",
			at: new Date().toISOString(),
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
				: cert.status;
	await writeCertificate(cert);
	console.log(`REVIEW: ${review.by} → ${review.verdict} (${review.note}); статус сертификата ${cert.status}`);
	return review.verdict === "FAIL" ? 1 : 0;
}

async function missingParts(cert: Certificate): Promise<string[]> {
	const missing: string[] = [];
	if (!Array.isArray(cert.checks) || !Array.isArray(cert.criteria) || !Array.isArray(cert.invariants))
		return ["сертификат повреждён: нет обязательных массивов criteria/checks/invariants"];
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
		const text = await readFile(full, "utf8");
		if (!text.includes(`$ ${check.cmd}`) || !text.includes(`--- exit ${check.exitCode ?? "нет"} ---`))
			badLogs.push(`${check.name}: лог не соответствует команде и коду выхода`);
	}
	if (badLogs.length > 0) missing.push(`логи проверок: ${badLogs.join("; ")}`);
	if (cert.checks.some((check) => !check.ok && check.blocking)) missing.push("проваленные блокирующие проверки");
	if (cert.invariants.length === 0 || cert.invariants.some((item) => !item.ok)) missing.push("инварианты (INVARIANTS)");
	const stale = Date.now() - Date.parse(cert.certifiedAt) > 24 * 60 * 60 * 1000;
	if (Number.isFinite(stale) && stale) missing.push("сертификат старше суток");
	if (cert.review !== null && cert.review.verdict === "FAIL") missing.push("вердикт ревьюера FAIL");
	// История ревью — не декорация: стоящий FAIL закрывается только записью с supersedesFail.
	const history = cert.reviews ?? [];
	const lastHistory = history[history.length - 1];
	const sameReview = (a?: Review | null, b?: Review | null): boolean =>
		Boolean(a && b && a.by === b.by && a.at === b.at && a.verdict === b.verdict);
	if (history.length > 0 && !sameReview(lastHistory, cert.review)) missing.push("cert.review не совпадает с последней записью reviews[]");
	const failing = history.some((item) => item.verdict === "FAIL");
	const superseded = history.some((item) => item.verdict === "PASS" && item.supersedesFail === true);
	if (failing && !superseded) missing.push("в истории ревью есть FAIL без явного --supersede");
	// Сертификат обязан быть самосогласованным: ok = (exitCode === 0).
	const inconsistent = cert.checks.filter((check) => check.ok !== (check.exitCode === 0));
	if (inconsistent.length > 0) missing.push(`ok не совпадает с кодом выхода: ${inconsistent.map((check) => check.name).join(", ")}`);
	if (cert.risk === "high" && cert.review === null) missing.push("независимая проверка (REVIEW) для рискованной работы");
	if (cert.risk === "high" && cert.review !== null && cert.review.verdict !== "PASS") missing.push("вердикт ревьюера не PASS");
	if (cert.risk === "high" && cert.review !== null && cert.review.independent !== true)
		missing.push("ревьюер не независим (independent=false)");
	if (cert.status === "FAILED") missing.push("статус сертификата FAILED");
	return missing;
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
		case "report":
			return cmdReport(argv);
		case "list":
			return cmdList();
		default:
			console.error("команды: init | run | review | verify | report | list");
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		console.error(`ошибка приёмки: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	});
