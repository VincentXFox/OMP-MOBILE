#!/usr/bin/env bun
/**
 * verifier-daemon — независимый верификатор OMP.
 *
 * Работает под отдельным системным пользователем `omp-verifier` и держит ключ подписи
 * аттестатов в своём каталоге: исполнитель (агент) не может ни прочитать ключ, ни
 * выдать PASS сам. Взаимодействие — через Unix-сокет, и только по разрешённым операциям.
 *
 * Что делает по запросу `verify`:
 *   1. читает контракт и сертификат проекта;
 *   2. проверяет подпись сертификата ключом верификатора (ключ исполнителя не подходит);
 *   3. заново выполняет объявленные проверки, но ТОЛЬКО из белого списка;
 *   4. сравнивает коды возврата с тем, что записал исполнитель;
 *   5. подписывает аттестат и возвращает его в ответе (файл пишет вызывающий).
 *
 * Произвольные команды не исполняются: не прошедшая белый список проверка — это FAIL.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const RUNTIME_DIR = process.env.OMP_VERIFIER_RUNTIME ?? "/run/omp-verifier";
const SOCKET_PATH = join(RUNTIME_DIR, "verify.sock");
const KEY_PATH = process.env.OMP_VERIFIER_KEY ?? "/var/lib/omp-verifier/verifier-key";
const WHITELIST_PATH = process.env.OMP_VERIFIER_WHITELIST ?? "/etc/omp-verifier/checks.json";

/** Белый список: только доверенные команды. Всё остальное — отказ, а не «на веру». */
const DEFAULT_ALLOWED = [
	"^(?:cd\\s+[^&;]+&&\\s*)?bun\\s+(?:test|run\\s+(?:check|build|test))\\b",
	"^(?:cd\\s+[^&;]+&&\\s*)?(?:npm|yarn)\\s+(?:test|run\\s+[\\w:-]+)\\b",
	"^(?:cd\\s+[^&;]+&&\\s*)?bash\\s+[^&;]*tests?/[\\w./-]+\\.sh\\b",
	"^test\\s+-[efd]\\s+[^;&|]+$",
	"^git\\s+(?:status|diff|log|rev-parse|show)\\b",
	"^curl\\s+-s[^;|&]*\\s+https?://(?:127\\.0\\.0\\.1|localhost)[^;|&]*$",
	"^systemctl\\s+(?:--user\\s+)?is-active\\s+[\\w@.-]+$",
	"^python3\\s+-m\\s+(?:pytest|unittest)\\b",
];

interface Whitelist {
	allowed: string[];
}

function loadWhitelist(): string[] {
	if (!existsSync(WHITELIST_PATH)) return DEFAULT_ALLOWED;
	try {
		const parsed = JSON.parse(readFileSync(WHITELIST_PATH, "utf8")) as Partial<Whitelist>;
		return Array.isArray(parsed.allowed) && parsed.allowed.length > 0 ? parsed.allowed : DEFAULT_ALLOWED;
	} catch {
		return DEFAULT_ALLOWED;
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function key(): Buffer {
	if (!existsSync(KEY_PATH)) throw new Error(`нет ключа верификатора: ${KEY_PATH}`);
	return Buffer.from(readFileSync(KEY_PATH, "utf8").trim(), "hex");
}

async function runCheck(cmd: string, cwd: string, timeoutMs: number): Promise<number | null> {
	const child = spawn("bash", ["-lc", cmd], { cwd, detached: true });
	const { promise, resolve } = Promise.withResolvers<number | null>();
	const killer = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		resolve(null);
	}, timeoutMs);
	child.on("close", (code) => {
		clearTimeout(killer);
		resolve(code ?? null);
	});
	child.on("error", () => {
		clearTimeout(killer);
		resolve(null);
	});
	return promise;
}

interface VerifyRequest {
	release?: string;
	commit?: string;
	env?: string;
	person?: string;
	ttlSec?: number;
	approval?: Record<string, unknown> | null;
	ownerToken?: string;
	consume?: boolean;
	action: "verify" | "check" | "ping" | "approve" | "check-approval";
	project?: string;
	slug?: string;
}

interface CertificateShape {
	slug?: string;
	risk?: string;
	status?: string;
	signature?: { mac?: string } | null;
	checks?: { name?: string; cmd?: string; exitCode?: number | null; expectExit?: number; blocking?: boolean; ok?: boolean }[];
	artifacts?: { path?: string; sha256?: string }[];
}

/** Дайджест содержимого сертификата: его подписывает верификатор, и любая правка ломает связь. */
function certificateDigest(cert: Record<string, unknown>): string {
	const fields = ["slug", "task", "risk", "certifiedAt", "criteria", "baseline", "checks", "probes", "invariants", "after", "regression", "reviews", "review", "residual", "residualNone", "security", "adversarial", "artifacts", "status"];
	const payload: Record<string, unknown> = {};
	for (const field of fields) payload[field] = cert[field];
	return createHash("sha256").update(canonical(payload)).digest("hex");
}

async function verifyProject(project: string, slug: string): Promise<{ verdict: "PASS" | "FAIL"; detail: string; certDigest: string | null }> {
	const gateDir = join(project, ".omp", "gate", slug);
	const certPath = join(gateDir, "certificate.json");
	const contractPath = join(gateDir, "contract.json");
	if (!existsSync(certPath)) return { verdict: "FAIL", detail: "нет сертификата", certMac: null };
	const cert = JSON.parse(await readFile(certPath, "utf8")) as CertificateShape;
	const digest = certificateDigest(cert as Record<string, unknown>);

	const checks = cert.checks ?? [];
	const whitelist = loadWhitelist();
	const problems: string[] = [];
	for (const check of checks) {
		const cmd = String(check.cmd ?? "");
		const allowed = whitelist.some((pattern) => {
			try {
				return new RegExp(pattern, "u").test(cmd);
			} catch {
				return false;
			}
		});
		if (!allowed) {
			problems.push(`проверка «${check.name ?? "?"}» вне белого списка`);
			continue;
		}
		const actual = await runCheck(cmd, project, 300_000);
		const expectedExit = check.expectExit ?? 0;
		if (actual !== expectedExit) problems.push(`«${check.name ?? "?"}»: повтор дал код ${actual}, в сертификате ${check.exitCode}`);
	}
	// Артефакты пересчитываются здесь же: подмена файла после прогона видна.
	for (const artifact of cert.artifacts ?? []) {
		const path = String(artifact.path ?? "");
		const full = join(project, path);
		if (!path || full.includes("..")) {
			problems.push(`артефакт вне проекта: ${path}`);
			continue;
		}
		try {
			const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
			if (digest !== artifact.sha256) problems.push(`артефакт изменён: ${path}`);
		} catch {
			problems.push(`артефакт не читается: ${path}`);
		}
	}
	if (cert.status === "FAILED") problems.push("статус сертификата FAILED");
	return {
		verdict: problems.length === 0 ? "PASS" : "FAIL",
		detail: problems.length === 0 ? "проверки воспроизведены верификатором" : problems.join("; ").slice(0, 400),
		certDigest: digest,
	};
}

async function signAttestation(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const mac = createHmac("sha256", key()).update(canonical(body)).digest("hex");
	return { ...body, mac };
}

/** `check` проверяет только подписи и свежесть: дорогие проверки не перезапускаются. */
async function checkAttestation(project: string, slug: string): Promise<{ ok: boolean; detail: string }> {
	const gateDir = join(project, ".omp", "gate", slug);
	const certPath = join(gateDir, "certificate.json");
	const attestationPath = join(gateDir, "attestation.json");
	if (!existsSync(certPath)) return { ok: false, detail: "нет сертификата" };
	if (!existsSync(attestationPath)) return { ok: false, detail: "нет аттестации" };
	// staging.json — часть доказательств: правка после аттестации ломает связь.
	const stagingPath = join(gateDir, "staging.json");
	if (existsSync(stagingPath)) {
		const stagingHash = createHash("sha256").update(readFileSync(stagingPath)).digest("hex").slice(0, 16);
		const recorded = String((JSON.parse(readFileSync(attestationPath, "utf8")) as { stagingHash?: unknown }).stagingHash ?? "");
		if (recorded !== "" && recorded !== stagingHash) return { ok: false, detail: "staging.json изменён после аттестации" };
	}
	const cert = JSON.parse(readFileSync(certPath, "utf8")) as Record<string, unknown>;
	const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as { mac?: string; certDigest?: string; exitCode?: number; [key: string]: unknown };
	if (!attestation.mac) return { ok: false, detail: "аттестат не подписан" };
	const { mac, ...rest } = attestation;
	const expected = createHmac("sha256", key()).update(canonical(rest)).digest("hex");
	if (expected !== mac) return { ok: false, detail: "подпись аттестата не сходится" };
	if (attestation.certDigest !== certificateDigest(cert)) return { ok: false, detail: "сертификат изменён после аттестации" };
	if (attestation.exitCode !== 0) return { ok: false, detail: "аттестат отрицательный" };
	return { ok: true, detail: "подпись верификатора верна, сертификат не менялся" };
}

/**
 * Разрешение владельца на выкладку: выдаётся только этим сервисом (ключ у него),
 * привязано к release/commit/env/сроку и гасится при первом использовании.
 * Ledger погашенных nonce живёт рядом с сокетом — вне досягаемости исполнителя.
 */
const APPROVAL_LEDGER = join(RUNTIME_DIR, "approvals-used.json");
/**
 * Токен владельца: файл, который создаёт сам владелец (0600, вне рабочего
 * каталога исполнителя). Без него `approve` не выдаётся — иначе разрешение
 * владельца выписывалось бы самому себе любым, кто дотянулся до сокета.
 */
const OWNER_TOKEN_PATH = process.env.OMP_OWNER_TOKEN_FILE ?? "/etc/omp-verifier/owner-token";

function canonicalApproval(value: Record<string, unknown>): string {
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

const USED_DIR = join(RUNTIME_DIR, "approvals-used");

/**
 * Атомарное погашение: эксклюзивное создание файла-nonce. Проверка «прочитал —
 * записал» не годится: параллельные вызовы все видят пустой ledger и все
 * получают ok (найдено состязательным разбором 27.10).
 */
async function consumeNonce(nonce: string, release: string): Promise<boolean> {
	await mkdir(USED_DIR, { recursive: true }).catch(() => undefined);
	try {
		const handle = await open(join(USED_DIR, nonce), "wx");
		await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), release }), "utf8");
		await handle.close();
		return true;
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") return false;
		throw error;
	}
}

async function nonceUsed(nonce: string): Promise<boolean> {
	return existsSync(join(USED_DIR, nonce));
}

async function readLedger(): Promise<Record<string, string>> {
	try {
		return JSON.parse(await readFile(APPROVAL_LEDGER, "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

async function writeLedger(ledger: Record<string, string>): Promise<void> {
	await mkdir(RUNTIME_DIR, { recursive: true }).catch(() => undefined);
	await writeFile(APPROVAL_LEDGER, JSON.stringify(ledger, null, "\t"), { mode: 0o600 });
}

async function issueApproval(request: VerifyRequest): Promise<Record<string, unknown>> {
	// Согласие владельца подтверждается его токеном, а не именем в поле person.
	let expectedToken = "";
	try {
		expectedToken = readFileSync(OWNER_TOKEN_PATH, "utf8").trim();
	} catch {
		return { ok: false, detail: `нет токена владельца (${OWNER_TOKEN_PATH}): разрешение выдаётся только владельцу` };
	}
	const given = String(request.ownerToken ?? "");
	if (expectedToken === "" || given === "" || given !== expectedToken) return { ok: false, detail: "токен владельца не совпал" };
	const release = String(request.release ?? "");
	const commit = String(request.commit ?? "");
	const env = String(request.env ?? "prod");
	const person = String(request.person ?? "владелец");
	const ttlSec = Math.max(60, Math.min(24 * 3600, Number(request.ttlSec ?? 3600)));
	if (release === "" || commit === "" || person === "") return { ok: false, detail: "нужны release, commit и person" };
	const issuedAt = new Date();
	const body: Record<string, unknown> = {
		version: 1,
		release,
		slug: String(request.slug ?? ""),
		commit,
		env,
		person,
		issuedAt: issuedAt.toISOString(),
		expiresAt: new Date(issuedAt.getTime() + ttlSec * 1000).toISOString(),
		nonce: randomBytes(12).toString("hex"),
		by: `omp-verifier (uid ${process.getuid?.() ?? "?"})`,
	};
	const mac = createHmac("sha256", key()).update(canonicalApproval(body)).digest("hex");
	return { ok: true, approval: { ...body, mac }, detail: `разрешение на ${release} до ${String(body["expiresAt"])}` };
}

async function checkApproval(request: VerifyRequest): Promise<Record<string, unknown>> {
	const approval = (request.approval ?? null) as Record<string, unknown> | null;
	if (approval === null || typeof approval !== "object") return { ok: false, detail: "разрешение не передано" };
	const mac = String(approval["mac"] ?? "");
	const body: Record<string, unknown> = { ...approval };
	delete body["mac"];
	const expected = createHmac("sha256", key()).update(canonicalApproval(body)).digest("hex");
	if (mac === "" || mac !== expected) return { ok: false, detail: "подпись разрешения не верна: выдать его может только верификатор" };
	const expiresAt = Date.parse(String(approval["expiresAt"] ?? ""));
	if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return { ok: false, detail: `разрешение истекло (${String(approval["expiresAt"] ?? "—")})` };
	if (request.release !== undefined && String(request.release) !== String(approval["release"] ?? "")) return { ok: false, detail: "разрешение выдано на другой release" };
	if (request.commit !== undefined && String(request.commit) !== String(approval["commit"] ?? "")) return { ok: false, detail: "разрешение выдано на другой commit" };
	if (request.env !== undefined && String(request.env) !== String(approval["env"] ?? "")) return { ok: false, detail: "разрешение выдано на другое окружение" };
	const ledger = await readLedger();
	const nonce = String(approval["nonce"] ?? "");
	if (nonce === "") return { ok: false, detail: "в разрешении нет nonce" };
	if (ledger[nonce] !== undefined) return { ok: false, detail: `разрешение уже использовано (${ledger[nonce]})` };
	if (request.consume === true) {
		const consumed = await consumeNonce(nonce, String(approval["release"] ?? ""));
		if (!consumed) return { ok: false, detail: `разрешение уже использовано (${String(ledger[nonce] ?? "ранее")})` };
		ledger[nonce] = new Date().toISOString();
		await writeLedger(ledger);
		return { ok: true, detail: "подпись верна, разрешение погашено (повторно не сработает)" };
	}
	if (await nonceUsed(nonce)) return { ok: false, detail: "разрешение уже использовано" };
	return { ok: true, detail: "подпись верна, разрешение действительно и не использовано" };
}

async function handle(request: VerifyRequest): Promise<Record<string, unknown>> {
	if (request.action === "ping") return { ok: true, service: "omp-verifier", pid: process.pid };
	if (request.action === "approve") return await issueApproval(request);
	if (request.action === "check-approval") return await checkApproval(request);
	if (request.action !== "verify" && request.action !== "check")
		return { ok: false, detail: "разрешены операции ping, verify, check, approve, check-approval" };
	if (!request.project || !request.slug) return { ok: false, detail: "нужны project и slug" };
	if (request.action === "check") {
		const checked = await checkAttestation(request.project, request.slug);
		return { ok: checked.ok, detail: checked.detail };
	}
	if (!request.project.startsWith("/")) return { ok: false, detail: "project должен быть абсолютным путём" };
	const result = await verifyProject(request.project, request.slug);
	const body = {
		slug: request.slug,
		at: new Date().toISOString(),
		certDigest: result.certDigest,
		exitCode: result.verdict === "PASS" ? 0 : 1,
		detail: result.detail,
		by: "omp-verifier (uid omp-verifier)",
	};
	return { ok: true, verdict: result.verdict, detail: result.detail, attestation: await signAttestation(body) };
}

await mkdir(RUNTIME_DIR, { recursive: true }).catch(() => undefined);
const server = Bun.serve({
	unix: SOCKET_PATH,
	async fetch(req) {
		try {
			const text = await req.text();
			const request = JSON.parse(text) as VerifyRequest;
			const response = await handle(request);
			return Response.json(response);
		} catch (error) {
			return Response.json({ ok: false, detail: String(error).slice(0, 200) }, { status: 400 });
		}
	},
});
// Сокет доступен группе omp-verifier: исполнителю нужно только подключение, не файлы ключа.
try {
	chmodSync(SOCKET_PATH, 0o660);
} catch {
	// права выставит systemd через RuntimeDirectoryMode/UMask
}
await writeFile("/var/lib/omp-verifier/daemon.pid", String(process.pid)).catch(() => undefined);
console.log(`omp-verifier слушает ${SOCKET_PATH} (uid ${process.getuid?.() ?? "?"})`);
void server;
