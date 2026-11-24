#!/usr/bin/env bun
/**
 * Перезапуск сессий, застрявших на устаревшем маршруте моделей.
 *
 * Причина: baseUrl провайдера читается при старте процесса. Если релей переехал
 * (de5 умер, релей ушёл на srv78), уже запущенные сессии продолжают ходить на
 * мёртвый адрес — каждый вызов модели падает по таймауту, агент «зависает».
 *
 * Скрипт находит такие сессии (провайдер cheaperinference, процесс старше
 * models.yml) и по флагу `--apply` перезапускает через штатный путь:
 * SIGTERM → ожидание выхода → `omp --restore <session.jsonl>` в той же панели.
 * Без `--apply` только показывает список (безопасный режим по умолчанию).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEWAY = process.env["OMP_GATEWAY"] ?? "http://127.0.0.1:8088";
const CONFIG = join(homedir(), "omp-mobile", "gateway", "config.json");
const MODELS = join(homedir(), ".omp", "agent", "models.yml");
const RUNTIME_SOCKET = process.env["OMP_RUNTIME_SOCKET"] ?? `/run/user/${process.getuid?.() ?? 1000}/omp-pocket-runtime.sock`;

interface HostRecord {
	sessionId: string;
	instanceId: string;
	pid: number;
	busy: boolean;
	alive: boolean;
	model: { provider?: string; id?: string } | null;
	sessionFile?: string | null;
	sessionName?: string | null;
}

function token(): string {
	const parsed = JSON.parse(readFileSync(CONFIG, "utf8")) as { token?: unknown };
	if (typeof parsed.token !== "string") throw new Error(`нет токена в ${CONFIG}`);
	return parsed.token;
}

async function hosts(): Promise<HostRecord[]> {
	const response = await fetch(`${GATEWAY}/api/hosts`, { headers: { authorization: `Bearer ${token()}` } });
	if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
	return ((await response.json()) as { hosts?: HostRecord[] }).hosts ?? [];
}

function processAgeSeconds(pid: number): number | null {
	const proc = Bun.spawnSync(["ps", "-o", "etimes=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	const value = Number(proc.stdout.toString().trim());
	return Number.isFinite(value) ? value : null;
}

function configAgeSeconds(): number {
	try {
		return Math.floor((Date.now() - statSync(MODELS).mtimeMs) / 1000);
	} catch {
		return 0;
	}
}

/**
 * Рантайм говорит собственным протоколом (NDJSON), а не HTTP: используем
 * штатный клиент, иначе fetch рвёт соединение (ECONNRESET).
 */
async function runtime(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
	const mod = (await import("../gateway/runtime/client.ts")) as {
		runtimeRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
	};
	return (await mod.runtimeRequest(method, params, timeoutMs)) as Record<string, unknown>;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Файл сессии по её id: каталоги вида ~/.omp/agent/sessions/<проект>/**.jsonl. */
function findSessionFile(sessionId: string): string {
	if (sessionId === "") return "";
	const root = join(homedir(), ".omp", "agent", "sessions");
	const found = Bun.spawnSync(["bash", "-c", `find ${JSON.stringify(root)} -maxdepth 2 -name "*${sessionId.replace(/[^a-z0-9-]/gu, "")}*.jsonl" -print -quit`], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return found.stdout.toString().trim();
}

async function main(argv: string[]): Promise<number> {
	const apply = argv.includes("--apply");
	const includeBusy = argv.includes("--include-busy");
	// --since-hooks: перезапустить сессии, поднятые до последней правки хуков —
	// они держат в памяти старый код (хуки загружаются при старте процесса).
	const sinceHooks = argv.includes("--since-hooks");
	// --restart-fresh: сессии без файла истории (транскрипт не писался) поднимаем
	// заново с тем же cwd — иначе они навсегда остаются на старом коде хуков.
	const restartFresh = argv.includes("--restart-fresh");
	// Партия: 24 процесса разом поднимают нагрузку на машину, иду порциями.
	const limitRaw = argv.indexOf("--limit");
	const limit = limitRaw >= 0 && argv[limitRaw + 1] !== undefined ? Math.max(1, Number(argv[limitRaw + 1]) || 0) : 0;
	const hooksMtime = (() => {
		try {
			const out = Bun.spawnSync(["bash", "-c", "find " + JSON.stringify(join(homedir(), ".omp", "agent", "hooks")) + " -name '*.ts' -printf '%T@\\n' | sort -rn | head -1"], { stdout: "pipe", stderr: "ignore" });
			const value = Number(out.stdout.toString().trim());
			return Number.isFinite(value) ? Math.floor(value) : 0;
		} catch {
			return 0;
		}
	})();
	const age = sinceHooks && hooksMtime > 0 ? Math.floor(Date.now() / 1000) - hooksMtime : configAgeSeconds();
	const all = await hosts();
	// --since-hooks: перезапускаем все сессии со старым кодом хуков, любого провайдера.
	const stale = all
		.filter((host) => host.alive && (sinceHooks || host.model?.provider === "cheaperinference"))
		.filter((host) => {
			const etimes = processAgeSeconds(host.pid);
			return etimes !== null && etimes > age;
		});
	// Часть записей — зомби: панель есть, транскрипта нет. Их не восстановить
	// (нечего запускать) — считаем отдельно, чтобы не смешивать с перезапуском.
	const withTranscript = stale.map((host) => ({ host, file: host.sessionFile ?? findSessionFile(host.sessionId) }));
	const zombies = withTranscript.filter((item) => item.file === "" && !restartFresh);
	const freshTargets = restartFresh ? withTranscript.filter((item) => item.file === "").map((item) => item.host).filter((host) => includeBusy || host.busy !== true) : [];
	const restorable = withTranscript
		.filter((item) => item.file !== "")
		.map((item) => item.host)
		.filter((host) => includeBusy || host.busy !== true);
	const targets = restorable.slice(0, limit > 0 ? limit : undefined);
	const fresh = freshTargets.slice(0, limit > 0 ? limit : undefined);
	console.log(
		`${sinceHooks ? "хуки" : "models.yml"} обновлены ${Math.round(age / 3600)} ч назад; застрявших: ${stale.length} (зомби без транскрипта: ${zombies.length}), к перезапуску: ${targets.length}` +
			`${includeBusy ? " (включая занятые)" : " (только простаивающие)"}`,
	);
	for (const host of targets) console.log(`  ${host.sessionId.slice(0, 8)} · busy=${host.busy} · pid ${host.pid} · ${host.sessionName ?? host.sessionFile ?? host.instanceId}`);
	if (restartFresh) for (const host of fresh) console.log(`  ${host.sessionId.slice(0, 8)} · busy=${host.busy} · pid ${host.pid} · БЕЗ ИСТОРИИ · ${host.cwd}`);
	if (!apply) {
		console.log("Сухой прогон: для перезапуска добавь --apply [--limit N] (занятые пропускаются, если не указать --include-busy).");
		return 0;
	}
	if (targets.length === 0 && fresh.length === 0) return 0;

	const panes =
		((await runtime("pane.list", {})) as { panes?: Array<{ id: string; instanceId?: string | null; sessionId?: string | null; sessionFile?: string | null }> })
			.panes ?? [];
	let done = 0;
	let failed = 0;
	for (const host of targets) {
		const pane = panes.find((item) => item.instanceId === host.instanceId) ?? panes.find((item) => item.sessionId === host.sessionId);
		// Файл сессии: из записи хоста, из панели или поиском по каталогам сессий.
		const sessionFile = host.sessionFile ?? pane?.sessionFile ?? findSessionFile(host.sessionId);
		if (pane === undefined || !sessionFile.endsWith(".jsonl")) {
			console.log(`  ${host.sessionId.slice(0, 8)}: панель или файл сессии не найдены, пропускаю`);
			failed += 1;
			continue;
		}
		try {
			process.kill(host.pid, "SIGTERM");
		} catch (error) {
			console.log(`  ${host.sessionId.slice(0, 8)}: SIGTERM не доставлен (${error instanceof Error ? error.message : String(error)})`);
		}
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && isAlive(host.pid)) await Bun.sleep(500);
		if (isAlive(host.pid)) {
			console.log(`  ${host.sessionId.slice(0, 8)}: не завершился за 30 с, оставляю как есть`);
			failed += 1;
			continue;
		}
		try {
			// Форма запуска — как у штатных панелей: --cwd проекта + восстановление сессии.
			await runtime("pane.run", { paneId: pane.id, argv: ["omp", "--cwd", host.cwd, "--allow-home", "--restore", sessionFile], sessionFile }, 120_000);
			done += 1;
			console.log(`  ${host.sessionId.slice(0, 8)}: перезапущен (--restore)`);
		} catch (error) {
			failed += 1;
			console.log(`  ${host.sessionId.slice(0, 8)}: перезапуск не удался (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	let freshDone = 0;
	for (const host of fresh) {
		const pane = panes.find((item) => item.instanceId === host.instanceId) ?? panes.find((item) => item.sessionId === host.sessionId);
		if (pane === undefined) {
			failed += 1;
			continue;
		}
		try {
			process.kill(host.pid, "SIGTERM");
		} catch {
			// уже завершился
		}
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && isAlive(host.pid)) await Bun.sleep(500);
		if (isAlive(host.pid)) {
			failed += 1;
			console.log(`  ${host.sessionId.slice(0, 8)}: не завершился за 30 с`);
			continue;
		}
		try {
			// Истории нет — поднимаем свежий агент в том же каталоге.
			await runtime("pane.run", { paneId: pane.id, argv: ["omp", "--cwd", host.cwd, "--allow-home"], sessionFile: null }, 120_000);
			freshDone += 1;
			console.log(`  ${host.sessionId.slice(0, 8)}: перезапущен без истории (${host.cwd})`);
		} catch (error) {
			failed += 1;
			console.log(`  ${host.sessionId.slice(0, 8)}: свежий запуск не удался (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	console.log(`Итог: перезапущено ${done}, без истории ${freshDone}, не удалось ${failed}`);
	return failed === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
