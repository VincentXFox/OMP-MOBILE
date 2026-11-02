#!/usr/bin/env bun
/**
 * Приводит все запущенные агенты OMP к одному набору инструкций.
 *
 * Зачем: omp читает хуки (`~/.omp/agent/hooks/pre/*.ts`) и постоянные инструкции
 * (`APPEND_SYSTEM.md`) при старте сессии. Сессия, запущенная до правки хуков,
 * продолжает жить на старом наборе — отсюда расхождение «у одних агентов
 * грандмастер есть, у других нет». Единственный способ выровнять уже
 * работающие сессии — перезапустить их: остановить инстанс и возобновить
 * ту же сессию из её .jsonl.
 *
 * Безопасность:
 *   - по одному агенту за раз: стоп → ждём освобождения памяти → старт;
 *   - живая проверка памяти (/proc/meminfo) перед каждым стартом: если свободно
 *     меньше порога, пауза и повторная проверка, при повторной неудаче — останов;
 *   - снимок состояния до начала пишется в файл (что было запущено);
 *   - `--dry-run` печатает план и ничего не делает.
 *
 * Запуск: bun bin/agents-unify.ts [--dry-run] [--api http://127.0.0.1:8088]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apiArg = args.indexOf("--api");
// Себя останавливать нельзя: текущая сессия указана в --except (подстрока
// sessionFile или instanceId). Иначе скрипт убил бы сам себя на середине.
const exceptArg = args.indexOf("--except");
const excepts = args.filter((a, i) => args[i - 1] === "--except");
const API = apiArg >= 0 ? (args[apiArg + 1] ?? "http://127.0.0.1:8088") : "http://127.0.0.1:8088";
const CONFIG = "/home/vincentfox/omp-mobile/gateway/config.json";
const STATE_DIR = "/home/vincentfox/OMP/omp";
/** Ниже этого порога свободной памяти старт не начинаем. */
const MIN_AVAILABLE_MB = 800;

const token = (JSON.parse(readFileSync(CONFIG, "utf8")) as { token: string }).token;

interface Host {
	instanceId: string;
	cwd?: string;
	sessionFile?: string | null;
	sessionId?: string;
	label?: string | null;
	sessionTitle?: string | null;
	busy?: boolean;
	alive?: boolean;
	startedAt?: number;
}

const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

async function listHosts(): Promise<Host[]> {
	const res = await fetch(`${API}/api/hosts`, { headers });
	if (!res.ok) throw new Error(`/api/hosts → ${res.status}`);
	return ((await res.json()) as { hosts: Host[] }).hosts;
}

function availableMb(): number {
	try {
		const info = readFileSync("/proc/meminfo", "utf8");
		const m = /MemAvailable:\s+(\d+) kB/.exec(info);
		return m ? Math.round(Number(m[1]) / 1024) : Number.POSITIVE_INFINITY;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Самый свежий из файлов инструкций: хуки и постоянные инструкции. */
function instructionsMtimeMs(): number {
	const files: string[] = [];
	for (const dir of ["/home/vincentfox/.omp/agent/hooks/pre", "/home/vincentfox/.omp/agent"]) {
		try {
			for (const name of readdirSync(dir)) {
				if (dir.endsWith("hooks/pre") ? name.endsWith(".ts") : name === "APPEND_SYSTEM.md" || name === "TASK_PROTOCOL.md") {
					files.push(join(dir, name));
				}
			}
		} catch {
			// каталога нет — пропускаем
		}
	}
	let newest = 0;
	for (const f of files) {
		try {
			newest = Math.max(newest, statSync(f).mtimeMs);
		} catch {
			// файл исчез — не важно
		}
	}
	return newest;
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
	const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	return { status: res.status, text: await res.text() };
}

/** Ждём, пока инстанс исчезнет из реестра. */
async function waitGone(instanceId: string, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hosts = await listHosts().catch(() => [] as Host[]);
		if (!hosts.some(h => h.instanceId === instanceId)) return true;
		await sleep(700);
	}
	return false;
}

/** Ждём, пока у сессии появится новый живой инстанс. */
async function waitNewInstance(sessionId: string, oldInstance: string, timeoutMs = 240_000): Promise<Host | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const hosts = await listHosts().catch(() => [] as Host[]);
		const hit = hosts.find(h => h.sessionId === sessionId && h.instanceId !== oldInstance);
		if (hit) return hit;
		await sleep(900);
	}
	return null;
}

async function main(): Promise<void> {
	const before = await listHosts();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const snapshot = `${STATE_DIR}/agent-restart-${stamp}.json`;
	const log = `${STATE_DIR}/agent-restart-${stamp}.log`;
	const lines: string[] = [];
	const say = (line: string): void => {
		lines.push(line);
		console.log(line);
	};

	if (!dryRun) writeFileSync(snapshot, JSON.stringify({ at: new Date().toISOString(), hosts: before }, null, 1));
	say(`агентов в реестре: ${before.length}; свободно памяти: ${availableMb()} МБ`);
	if (!dryRun) say(`снимок состояния: ${snapshot}`);

	// Сначала простаивающие, потом работающие: занятые агенты прерываются последними.
	// Перезапускаем только устаревшие сессии: те, что стартовали до последней
	// правки хуков или постоянных инструкций. Свежие не трогаем — им это не нужно.
	const cut = instructionsMtimeMs();
	const targets = [...before]
		.filter(h => typeof h.sessionFile === "string" && h.sessionFile.endsWith(".jsonl") && typeof h.cwd === "string")
		.filter(h => (h.startedAt ?? 0) / 1000 < cut)
		.filter(h => !excepts.some(x => (h.sessionFile ?? "").includes(x) || h.instanceId.includes(x)))
		// Работающий агент не прерываем: он подхватит текущий набор, когда
		// сам закончит ход (или при следующем перезапуске).
		.filter(h => h.busy !== true)
		.sort((a, b) => Number(a.busy ?? false) - Number(b.busy ?? false));
	const skipped = before.filter(h => !targets.includes(h));
	const busy = before.filter(h => h.busy === true);
	say(`инструкции обновлены: ${new Date(cut).toISOString()}`);
	say(`к перезапуску (устаревшие): ${targets.length}; пропущено (нет файла сессии): ${skipped.length - busy.length}; занятых не трогаем: ${busy.length}; свежих не трогаем: ${before.length - targets.length - (skipped.length - busy.length) - busy.length - excepts.length}`);

	if (dryRun) {
		for (const t of targets.slice(0, 50)) say(`  ${t.busy ? "занят    " : "свободен"} ${t.instanceId} ${(t.label ?? t.sessionTitle ?? "").slice(0, 40)}`);
		return;
	}

	let restarted = 0;
	let failed = 0;
	for (const [index, host] of targets.entries()) {
		const name = (host.label ?? host.sessionTitle ?? host.sessionId ?? host.instanceId).slice(0, 40);
		const stop = await post("/api/agents/stop", { instanceId: host.instanceId, force: true }).catch(err => ({ status: 0, text: String(err) }));
		const gone = await waitGone(host.instanceId);
		if (!gone) {
			say(`[${index + 1}/${targets.length}] НЕ остановился ${host.instanceId} (${name}); ответ: ${stop.status}`);
			failed++;
			continue;
		}

		// Память проверяем после остановки: старый инстанс уже отпустил память.
		let freed = availableMb() >= MIN_AVAILABLE_MB;
		for (let attempt = 0; !freed && attempt < 6; attempt++) {
			say(`пауза: свободно ${availableMb()} МБ < ${MIN_AVAILABLE_MB} МБ, ждём освобождения (попытка ${attempt + 1}/6)`);
			await sleep(30_000);
			freed = availableMb() >= MIN_AVAILABLE_MB;
		}
		if (!freed) {
			say(`СТОП: памяти мало (${availableMb()} МБ) — дальше не идём, перезапущено ${restarted}, осталось ${targets.length - index}`);
			break;
		}

		const mode = "resume";
		const started = await post("/api/agents/resume", {
			cwd: host.cwd,
			session: host.sessionFile,
			label: host.label ?? undefined,
			mode,
		}).catch(err => ({ status: 0, text: String(err) }));
		// 502 «не зарегистрировался за 45 с» бывает ложным: процесс стартует и
		// регистрируется позже. Ждём появления в реестре, а не верим ответу.
		const fresh = await waitNewInstance(host.sessionId ?? "", host.instanceId);
		if (fresh === null) {
			say(`[${index + 1}/${targets.length}] не появился в реестре за 4 мин: ${name}; ответ старта: ${started.status} ${started.text.slice(0, 90)}`);
			failed++;
			continue;
		}
		restarted++;
		say(`[${index + 1}/${targets.length}] ${mode} → ${fresh.instanceId} (${name}); памяти ${availableMb()} МБ`);
		await sleep(600);
	}

	const after = await listHosts();
	say(`итог: перезапущено ${restarted}, неудач ${failed}; в реестре ${after.length} (было ${before.length}); свободно ${availableMb()} МБ`);
	writeFileSync(log, lines.join("\n") + "\n");
	console.log(`журнал: ${log}`);
}

await main();
