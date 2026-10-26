#!/usr/bin/env bun
/**
 * watchdog — независимый наблюдатель.
 *
 * Следит за живостью шлюза, реестром агентов, панелями рантайма и застрявшими
 * целями контроллера. Может сообщить о проблеме и (по флагу) перезапустить
 * исполнителя, но НЕ имеет права выдать PASS: он вообще не пишет в .omp/gate и
 * не трогает сертификаты. Это разделение полномочий, а не вежливость.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEWAY = process.env.OMP_GATEWAY ?? "http://127.0.0.1:8088";
const TOKEN_PATH = process.env.OMP_TOKEN_FILE ?? join(homedir(), "omp-mobile", "gateway", "config.json");
const LOG = process.env.OMP_WATCHDOG_LOG ?? join(homedir(), ".omp", "watchdog.log");
const STATE_ROOT = join(process.cwd(), ".omp", "autonomy");
const STALE_MINUTES = Number(process.env.OMP_WATCHDOG_STALE_MINUTES ?? 45);

interface Problem {
	name: string;
	detail: string;
}

function token(): string {
	try {
		const parsed: unknown = JSON.parse(require("node:fs").readFileSync(TOKEN_PATH, "utf8"));
		return parsed && typeof parsed === "object" && "token" in parsed && typeof parsed.token === "string" ? parsed.token : "";
	} catch {
		return "";
	}
}

async function probeGateway(problems: Problem[]): Promise<void> {
	const auth = { Authorization: `Bearer ${token()}` };
	try {
		const health = await fetch(`${GATEWAY}/api/health`, { headers: auth, signal: AbortSignal.timeout(8000) });
		if (!health.ok) {
			problems.push({ name: "шлюз", detail: `health ответил ${health.status}` });
			return;
		}
		const hosts = await fetch(`${GATEWAY}/api/hosts`, { headers: auth, signal: AbortSignal.timeout(15000) });
		if (!hosts.ok) {
			problems.push({ name: "реестр агентов", detail: `hosts ответил ${hosts.status}` });
			return;
		}
		const data = (await hosts.json()) as { hosts?: { relayConnected?: boolean }[] };
		const list = data.hosts ?? [];
		const connected = list.filter((item) => item.relayConnected).length;
		if (list.length === 0) problems.push({ name: "реестр агентов", detail: "агентов нет" });
		else if (connected < list.length) problems.push({ name: "связь агентов", detail: `${connected}/${list.length} на связи` });
	} catch (error) {
		problems.push({ name: "шлюз", detail: `недоступен: ${String(error).slice(0, 100)}` });
	}
}

/** Застрявшая цель: фаза EXECUTE/RECOVER без обновления дольше порога. */
async function probeGoals(problems: Problem[]): Promise<void> {
	if (!existsSync(STATE_ROOT)) return;
	for (const entry of await readdir(STATE_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(STATE_ROOT, entry.name, "state.json");
		if (!existsSync(path)) continue;
		try {
			const state = JSON.parse(await readFile(path, "utf8")) as { phase?: string; updatedAt?: string; goal?: string };
			if (state.phase !== "EXECUTE" && state.phase !== "RECOVER") continue;
			const updated = Date.parse(String(state.updatedAt ?? ""));
			if (!Number.isFinite(updated)) continue;
			const minutes = (Date.now() - updated) / 60000;
			if (minutes > STALE_MINUTES)
				problems.push({ name: "цель застряла", detail: `${entry.name}: ${state.phase} без движения ${Math.round(minutes)} мин — ${String(state.goal ?? "").slice(0, 60)}` });
		} catch {
			problems.push({ name: "состояние цели", detail: `${entry.name}: state.json не читается` });
		}
	}
}

const problems: Problem[] = [];
await probeGateway(problems);
await probeGoals(problems);

const line = `${new Date().toISOString()} ${problems.length === 0 ? "ok" : `проблем: ${problems.length}`}${problems.map((item) => ` | ${item.name}: ${item.detail}`).join("")}\n`;
await mkdir(join(LOG, ".."), { recursive: true });
await appendFile(LOG, line, "utf8");
process.stdout.write(line);

if (problems.length === 0) process.exit(0);
// Наблюдатель сообщает и (по флагу) может перезапустить исполнителя, но PASS не выдаёт никогда.
if (process.argv.includes("--heal")) {
	const restarted = Bun.spawnSync(["systemctl", "--user", "restart", "omp-pocket-runtime"]);
	process.stdout.write(`перезапуск исполнителя: код ${restarted.exitCode}\n`);
}
process.exit(1);
