#!/usr/bin/env bun
/**
 * deploy — единственный санкционированный путь выкладки.
 *
 * Никакой роли, кроме DEPLOYER, не нужно трогать production напрямую: команда
 * сначала прогоняет Deployment Gate (восемь условий), затем гасит одноразовое
 * разрешение владельца через верификатор и только после этого запускает
 * выкладывающую команду, переданную DEPLOYER'ом.
 *
 * Исполнитель не может ни выдать разрешение (ключ у верификатора), ни
 * переиспользовать его (nonce гасится в ledger сервиса), ни обойти commit-привязку.
 *
 * Запуск:
 *   bun bin/deploy.ts --slug <slug> --release ID --commit SHA [--env prod] \
 *     --approval ~/.omp/deploy-approvals/ID.json --deployer-cmd '<команда выкладки>' [--dry-run]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateDeploy, type DeployVerdict } from "./deploy-gate.ts";

function argValue(argv: readonly string[], flag: string): string | null {
	for (let i = argv.length - 1; i >= 0; i -= 1) if (argv[i] === flag && argv[i + 1] !== undefined) return argv[i + 1] as string;
	return null;
}

function writeAudit(cwd: string, slug: string, record: Record<string, unknown>): string {
	const dir = join(cwd, ".omp", "gate", slug);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "deploy.json");
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`, "utf8");
	return path;
}

async function main(argv: string[]): Promise<number> {
	const slug = argValue(argv, "--slug") ?? argv[1] ?? "";
	const release = argValue(argv, "--release") ?? "";
	const commit = argValue(argv, "--commit") ?? "";
	const env = argValue(argv, "--env") ?? "prod";
	const approval = argValue(argv, "--approval") ?? undefined;
	const deployerCmd = argValue(argv, "--deployer-cmd") ?? "";
	const dryRun = argv.includes("--dry-run");
	const cwd = argValue(argv, "--cwd") ?? process.cwd();

	if (slug === "" || release === "" || commit === "") {
		console.error("нужны --slug, --release и --commit (см. bin/deploy.ts --help)");
		return 2;
	}

	// Первый проход: без гашения — чтобы отказ не сжигал разрешение.
	const probe: DeployVerdict = await evaluateDeploy({ cwd, slug, release, commit, env, approvalFile: approval });
	if (probe.status !== "AUTHORIZED") {
		writeAudit(cwd, slug, { status: probe.status, release, commit, env, at: new Date().toISOString(), conditions: probe.conditions, executed: false });
		console.error(`DEPLOYMENT_GATE: ${probe.status} — выкладка запрещена`);
		for (const condition of probe.conditions) console.error(`  ${condition.ok ? "✔" : "✘"} ${condition.id}: ${condition.detail}`);
		return 1;
	}

	// Предпросмотр ничего не гасит: иначе «показать, что будет» делает выкладку невозможной.
	if (dryRun) {
		writeAudit(cwd, slug, { status: "AUTHORIZED", release, commit, env, at: new Date().toISOString(), executed: false, dryRun: true, deployerCmd });
		console.log(`DEPLOYMENT_GATE: AUTHORIZED · dry-run, разрешение не погашено, команда не запускалась: ${deployerCmd || "—"}`);
		return 0;
	}
	// Второй проход: гасим разрешение (одноразовое) и фиксируем факт.
	const consumed = await evaluateDeploy({ cwd, slug, release, commit, env, approvalFile: approval, consume: true });
	if (consumed.status !== "AUTHORIZED") {
		writeAudit(cwd, slug, { status: consumed.status, release, commit, env, at: new Date().toISOString(), conditions: consumed.conditions, executed: false });
		console.error(`DEPLOYMENT_GATE: ${consumed.status} при погашении разрешения — выкладка отменена`);
		return 1;
	}

	if (deployerCmd === "") {
		writeAudit(cwd, slug, { status: "AUTHORIZED", release, commit, env, at: new Date().toISOString(), executed: false, detail: "команда выкладки не передана" });
		console.log("DEPLOYMENT_GATE: AUTHORIZED · разрешение погашено, но команда выкладки не передана (--deployer-cmd)");
		return 0;
	}
	// Выкладку выполняет роль DEPLOYER: команда приходит извне, не из сессии исполнителя.
	const started = Date.now();
	const proc = Bun.spawn(["bash", "-lc", deployerCmd], {
		cwd,
		env: { ...process.env, OMP_DEPLOY_AUTH: release, OMP_DEPLOY_COMMIT: commit },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const audit = writeAudit(cwd, slug, {
		status: code === 0 ? "DEPLOYED" : "FAILED",
		release,
		commit,
		env,
		at: new Date().toISOString(),
		executed: true,
		deployerCmd,
		exitCode: code,
		tookMs: Date.now() - started,
		tail: `${out}\n${err}`.trim().slice(-2000),
	});
	console.log(`ВЫКЛАДКА ${code === 0 ? "ВЫПОЛНЕНА" : "ПРОВАЛЕНА"}: exit ${code} · аудит ${audit}`);
	return code === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
