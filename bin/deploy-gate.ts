#!/usr/bin/env bun
/**
 * Deployment Gate — технический запрет выкладки на production без приёмки.
 *
 * Восемь условий проверяются по артефактам, а не по словам: тесты, визуальная
 * приёмка, независимое ревью, аттестат верификатора, отсутствие провалов,
 * совпадение commit'а, пройденный staging QA и одноразовое разрешение владельца,
 * подписанное верификатором (ключ у него, не у исполнителя).
 *
 * Разрешение выдаёт только сервис omp-verifier (действие `approve`) и он же
 * подтверждает его при выкладке (`check-approval`), помечая использованным —
 * поэтому «владелец разрешил» текстом не работает, а повторное использование
 * невозможно даже при копировании файла.
 *
 * Команды:
 *   status  <slug> --release ID --commit SHA [--env prod] [--json]
 *   request <slug> --release ID --commit SHA [--ttl 3600] [--person ИМЯ]
 *   approve <slug> --release ID --commit SHA --person ИМЯ [--ttl 3600]   # только через верификатор
 *   check   <slug> --release ID --commit SHA --approval FILE [--consume]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkVisual } from "./visual-gate.ts";

/** Сокет читается на каждом вызове: тесты и смена окружения не должны «залипать». */
export function verifierSocket(): string {
	return process.env["OMP_VERIFIER_SOCKET"] ?? "/run/omp-verifier/verify.sock";
}

/**
 * Разрешения владельца могут выдаваться отдельным доверенным сервисом: адрес
 * берётся из OMP_DEPLOY_APPROVAL_SOCKET, иначе — тот же верификатор.
 */
export function approvalSocket(): string {
	return process.env["OMP_DEPLOY_APPROVAL_SOCKET"] ?? verifierSocket();
}

export type DeployStatus = "AUTHORIZED" | "DENIED" | "BLOCKED";

export interface Condition {
	id: string;
	ok: boolean;
	detail: string;
	/** BLOCK — доказательства подделаны/устарели; DENIED — условия просто не выполнены. */
	severity: "denied" | "blocked";
}

export interface DeployVerdict {
	status: DeployStatus;
	slug: string;
	release: string;
	commit: string;
	env: string;
	conditions: Condition[];
	checkedAt: string;
}

export interface OwnerApproval {
	version: number;
	release: string;
	slug: string;
	commit: string;
	env: string;
	person: string;
	issuedAt: string;
	expiresAt: string;
	nonce: string;
	by: string;
	mac: string;
}

export function approvalsDir(): string {
	return process.env["OMP_DEPLOY_APPROVALS"] ?? join(homedir(), ".omp", "deploy-approvals");
}

export function requestsDir(): string {
	return process.env["OMP_DEPLOY_REQUESTS"] ?? join(homedir(), ".omp", "deploy-requests");
}

async function askVerifier(payload: Record<string, unknown>, socket = verifierSocket()): Promise<Record<string, unknown> | null> {
	if (!existsSync(socket)) return null;
	try {
		const response = await fetch("http://verifier/", {
			method: "POST",
			unix: socket,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(120_000),
		});
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

interface CertificateShape {
	slug?: string;
	status?: string;
	risk?: string;
	review?: { by?: string; verdict?: string; evidence?: { kind?: string } } | null;
	checks?: Array<{ name?: string; ok?: boolean; blocking?: boolean }>;
	criteria?: Array<{ id?: string; text?: string }>;
	visual?: { required?: boolean; url?: string } | null;
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function git(cwd: string, args: string[]): string {
	try {
		const proc = Bun.spawnSync(["git", ...args], { cwd, timeout: 20_000, stderr: "ignore" });
		return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
	} catch {
		return "";
	}
}

export interface DeployCheckOptions {
	cwd: string;
	slug: string;
	release: string;
	commit: string;
	env: string;
	approvalFile?: string;
	/** Проверить и сразу погасить разрешение (делает deploy.ts, а не статус). */
	consume?: boolean;
	/** Отключить проверку визуальной приёмки (для проектов без интерфейса). */
	requireVisual?: boolean;
}

/**
 * Восемь условий выкладки. Порядок проверок — от доказательств к полномочиям:
 * сначала то, что можно проверить по артефактам, потом разрешение владельца.
 */
export async function evaluateDeploy(options: DeployCheckOptions): Promise<DeployVerdict> {
	const conditions: Condition[] = [];
	const certPath = join(options.cwd, ".omp", "gate", options.slug, "certificate.json");
	const cert = readJson<CertificateShape>(certPath);

	// 1. Тесты: все объявленные проверки пройдены.
	const checks = Array.isArray(cert?.checks) ? cert.checks : [];
	const failedChecks = checks.filter((check) => check?.ok !== true);
	conditions.push({
		id: "tests",
		ok: cert !== null && checks.length > 0 && failedChecks.length === 0,
		detail:
			cert === null
				? `нет сертификата ${certPath}`
				: checks.length === 0
					? "в сертификате нет выполненных проверок"
					: failedChecks.length === 0
						? `проверок ${checks.length}, все пройдены`
						: `провалены: ${failedChecks.map((c) => c.name ?? "?").join(", ")}`,
		severity: "denied",
	});

	// 2. Визуальная приёмка.
	const requireVisual = options.requireVisual ?? cert?.visual?.required === true;
	const visual = checkVisual({ cwd: options.cwd, slug: options.slug, expectedCommit: options.commit });
	if (!requireVisual) {
		conditions.push({ id: "visual", ok: true, detail: "визуальная приёмка для этого проекта не требуется контрактом", severity: "denied" });
	} else {
		conditions.push({
			id: "visual",
			ok: visual.status === "PASS",
			detail: `VISUAL_GATE: ${visual.status} · комбинаций ${visual.combos}/16, скриншотов ${visual.shots}/48${visual.reasons.length > 0 ? ` · ${visual.reasons[0]}` : ""}`,
			severity: visual.status === "BLOCK" ? "blocked" : "denied",
		});
	}

	// 3. Независимое ревью с провенансом.
	const review = cert?.review ?? null;
	// Провенанс — только из белого списка: «какая-то строка» не считается (найдено 27.10).
	const reviewKind = typeof review?.evidence?.kind === "string" ? review.evidence.kind : "";
	const reviewOk = review?.verdict === "PASS" && (reviewKind === "spawn" || reviewKind === "attestation");
	conditions.push({
		id: "review",
		ok: reviewOk,
		detail: review === null ? "ревью не проводилось" : `вердикт ${review.verdict ?? "—"} от ${review.by ?? "?"}${reviewOk ? ` (${review.evidence?.kind})` : " без провенанса"}`,
		severity: "denied",
	});

	// 4. Аттестат верификатора: подтверждает только сам верификатор.
	const attestation = await askVerifier({ action: "check", project: options.cwd, slug: options.slug });
	conditions.push({
		id: "attestation",
		ok: attestation !== null && attestation["ok"] === true,
		detail:
			attestation === null
				? `верификатор недоступен (${verifierSocket()})`
				: `${String(attestation["ok"])}: ${String(attestation["detail"] ?? "")}`.slice(0, 200),
		severity: "denied",
	});

	// 5. Нет обязательных FAIL/UNVERIFIED.
	const status = String(cert?.status ?? "нет");
	conditions.push({
		id: "noFail",
		ok: status === "ГОТОВО",
		detail: `статус сертификата: ${status}${status === "FAILED" ? " (есть FAIL)" : ""}`,
		severity: status === "FAILED" ? "blocked" : "denied",
	});

	// 6. Проверенный commit совпадает с выкладываемым.
	const head = git(options.cwd, ["rev-parse", "HEAD"]);
	const commitOk = options.commit !== "" && head !== "" && options.commit === head;
	conditions.push({
		id: "commitMatch",
		ok: commitOk,
		detail: commitOk ? `commit ${options.commit.slice(0, 8)} совпадает с HEAD` : `выкладывается ${options.commit.slice(0, 8) || "—"}, а в дереве ${head.slice(0, 8) || "—"}`,
		severity: "blocked",
	});

	// 7. Staging QA пройден на том же commit.
	const staging = readJson<{ commit?: string; ok?: boolean; detail?: string }>(join(options.cwd, ".omp", "gate", options.slug, "staging.json"));
	const stagingOk = staging !== null && staging.ok === true && staging.commit === options.commit;
	conditions.push({
		id: "stagingQa",
		ok: stagingOk,
		detail:
			staging === null
				? "нет staging.json: QA на стенде не проводился"
				: stagingOk
					? "staging QA пройден на этом commit"
					: `staging от commit ${String(staging.commit ?? "—").slice(0, 8)}, ok=${String(staging.ok)}`,
		severity: "denied",
	});

	// 8. Одноразовое разрешение владельца, подписанное верификатором.
	const approvalFile = options.approvalFile ?? join(approvalsDir(), `${options.release}.json`);
	const approval = readJson<OwnerApproval>(approvalFile);
	let approvalOk = false;
	let approvalDetail = "разрешения владельца нет";
	// Отсутствие разрешения — это DENIED (условие не выполнено), подделка или
	// повторное использование — BLOCKED (попытка обойти контроль).
	let approvalSeverity: "denied" | "blocked" = "denied";
	if (approval !== null) {
		const answer = await askVerifier(
			{
				action: "check-approval",
				approval,
				consume: options.consume === true,
				// Привязка проверяется в демоне: разрешение на один релиз не годится для другого.
				release: options.release,
				commit: options.commit,
				env: options.env,
			},
			approvalSocket(),
		);
		approvalOk = answer !== null && answer["ok"] === true;
		approvalDetail =
			answer === null
				? "верификатор недоступен: разрешение проверить нечем"
				: `${String(answer["detail"] ?? "")}${options.consume === true && approvalOk ? " (разрешение погашено)" : ""}`;
		if (!approvalOk && /подпись разрешения не верна|уже использовано|истекло/u.test(approvalDetail)) approvalSeverity = "blocked";
	}
	conditions.push({ id: "ownerApproval", ok: approvalOk, detail: approvalDetail, severity: approvalSeverity });

	const blocked = conditions.some((c) => !c.ok && c.severity === "blocked");
	const denied = conditions.some((c) => !c.ok);
	const verdict: DeployVerdict = {
		status: blocked ? "BLOCKED" : denied ? "DENIED" : "AUTHORIZED",
		slug: options.slug,
		release: options.release,
		commit: options.commit,
		env: options.env,
		conditions,
		checkedAt: new Date().toISOString(),
	};
	return verdict;
}

/** Требование к разрешению: что именно владелец подтверждает и чем оно ограничено. */
export function buildRequest(options: { slug: string; release: string; commit: string; env: string; ttlSec: number; person: string }): Record<string, unknown> {
	const issuedAt = new Date();
	const expiresAt = new Date(issuedAt.getTime() + options.ttlSec * 1000);
	return {
		version: 1,
		release: options.release,
		slug: options.slug,
		commit: options.commit,
		env: options.env,
		person: options.person,
		ttlSec: options.ttlSec,
		requestedAt: issuedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		nonce: createHash("sha256").update(`${options.release}:${options.commit}:${issuedAt.toISOString()}`).digest("hex").slice(0, 24),
	};
}

export function writeRequest(request: Record<string, unknown>): string {
	const dir = requestsDir();
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${String(request["release"])}.json`);
	writeFileSync(path, `${JSON.stringify(request, null, "\t")}\n`, "utf8");
	return path;
}

function argValue(argv: readonly string[], flag: string): string | null {
	for (let i = argv.length - 1; i >= 0; i -= 1) if (argv[i] === flag && argv[i + 1] !== undefined) return argv[i + 1] as string;
	return null;
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0] ?? "help";
	const slug = argv[1] ?? "";
	const release = argValue(argv, "--release") ?? "";
	const commit = argValue(argv, "--commit") ?? "";
	const env = argValue(argv, "--env") ?? "prod";
	const json = argv.includes("--json");
	if (command === "help" || slug === "" || release === "") {
		console.log(`deploy-gate — восемь условий выкладки

  status  <slug> --release ID --commit SHA [--env prod] [--json]
  request <slug> --release ID --commit SHA [--ttl 3600] [--person ИМЯ]
  approve <slug> --release ID --commit SHA --person ИМЯ [--ttl 3600]   # подписывает верификатор
  check   <slug> --release ID --commit SHA --approval FILE [--consume]

Сокет верификатора: ${verifierSocket()}
Разрешения: ${approvalsDir()}`);
		return command === "help" ? 0 : 2;
	}
	const cwd = argValue(argv, "--cwd") ?? process.cwd();

	if (command === "request") {
		const request = buildRequest({
			slug,
			release,
			commit,
			env,
			ttlSec: Number(argValue(argv, "--ttl") ?? 3600),
			person: argValue(argv, "--person") ?? "владелец",
		});
		const path = writeRequest(request);
		console.log(`ЗАПРОС РАЗРЕШЕНИЯ: ${path}`);
		console.log(`Подтверждает: ${request["person"]} · release ${release} · commit ${commit.slice(0, 8)} · env ${env} · до ${request["expiresAt"]}`);
		console.log("Подписать может только верификатор: deploy-gate approve … (текст агента разрешением не считается).");
		return 0;
	}

	if (command === "approve") {
		const answer = await askVerifier({
			action: "approve",
			ownerToken: process.env["OMP_OWNER_TOKEN"] ?? "",
			project: cwd,
			slug,
			release,
			commit,
			env,
			person: argValue(argv, "--person") ?? "владелец",
			ttlSec: Number(argValue(argv, "--ttl") ?? 3600),
		});
		if (answer === null) {
			console.error("верификатор недоступен: разрешение выдаёт только он (ключ у него)");
			return 1;
		}
		const approval = answer["approval"] as OwnerApproval | undefined;
		if (approval === undefined) {
			console.error(`верификатор отказал: ${String(answer["detail"] ?? "без пояснения")}`);
			return 1;
		}
		mkdirSync(approvalsDir(), { recursive: true });
		const path = join(approvalsDir(), `${release}.json`);
		writeFileSync(path, `${JSON.stringify(approval, null, "\t")}\n`, "utf8");
		console.log(`РАЗРЕШЕНИЕ ВЫДАНО: ${path} · ${approval.person} · до ${approval.expiresAt}`);
		return 0;
	}

	const verdict = await evaluateDeploy({
		cwd,
		slug,
		release,
		commit,
		env,
		approvalFile: argValue(argv, "--approval") ?? undefined,
		consume: argv.includes("--consume"),
	});
	if (json) console.log(JSON.stringify(verdict, null, "\t"));
	else {
		console.log(`DEPLOYMENT_GATE: ${verdict.status} · ${slug} · release ${release} · commit ${commit.slice(0, 8)} · env ${env}`);
		for (const condition of verdict.conditions) console.log(`  ${condition.ok ? "✔" : "✘"} ${condition.id}: ${condition.detail}`);
	}
	if (command === "check") return verdict.status === "AUTHORIZED" ? 0 : 1;
	return verdict.status === "AUTHORIZED" ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
