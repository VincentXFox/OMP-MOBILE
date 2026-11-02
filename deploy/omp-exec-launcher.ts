/**
 * Лаунчер исполнителя OMP: единственная точка, откуда агенты запускаются
 * от ограниченной учётки `omp-exec`.
 *
 * Почему отдельный сервис: правило sudoers на учётке владельца меняло бы его
 * административные права, а прямой запуск от другого uid требует root. Сервис
 * работает под root и **жёстко** понижает права до `omp-exec`; параметра
 * «от какого пользователя запускать» в API нет вообще — повысить права через
 * лаунчер нельзя.
 *
 * Границы доверия:
 *   - запросы принимаются только с unix-сокета, доступного владельцу (ACL) и root;
 *   - рабочий каталог должен лежать внутри разрешённого корня и принадлежать
 *     `omp-exec` — иначе запрос отклоняется;
 *   - команда запуска фиксирована (omp из фиксированного пути), аргументы
 *     передаются массивом, без shell;
 *   - лог запросов пишется в /var/log/omp-exec-launcher.log.
 *
 * Запуск: /opt/omp-exec-launcher/bun /opt/omp-exec-launcher/launcher.ts
 */
import { appendFileSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

const SOCKET = "/run/omp-exec-launcher/launch.sock";
const LOG = "/var/log/omp-exec-launcher.log";
const RUN_AS = "omp-exec";
/** Единственный разрешённый корень для рабочих каталогов исполнителя. */
const ROOT = "/srv/omp-exec";
const OMP = "/opt/omp-exec-launcher/omp";

function log(line: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// лог не должен ломать запуск
	}
}

function allowedCwd(cwd: string): string | null {
	if (typeof cwd !== "string" || !cwd.startsWith(`${ROOT}/`)) return `${cwd}: вне разрешённого корня ${ROOT}`;
	if (!existsSync(cwd)) return `${cwd}: каталога нет`;
	try {
		const stat = statSync(cwd);
		if (!stat.isDirectory()) return `${cwd}: не каталог`;
	} catch (error) {
		return `${cwd}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return null;
}

interface LaunchRequest {
	cwd?: unknown;
	label?: unknown;
	prompt?: unknown;
	model?: unknown;
	resume?: unknown;
}

function launch(body: LaunchRequest): { ok: boolean; pid?: number; error?: string } {
	const cwd = typeof body.cwd === "string" ? body.cwd : "";
	const problem = allowedCwd(cwd);
	if (problem !== null) return { ok: false, error: problem };

	// Аргументы собираются массивом: shell не участвует, инъекция невозможна.
	const args = [
		"--reuid=" + RUN_AS,
		"--regid=" + RUN_AS,
		"--clear-groups",
		"--inh-caps=-all",
		"--",
		OMP,
		"--cwd",
		cwd,
	];
	// Метка сессии: флага --label у omp нет (проверено запуском), поэтому она идёт
	// переменной окружения и в лог, а не аргументом командной строки.
	if (typeof body.model === "string" && body.model !== "") args.push("--model", body.model.slice(0, 128));
	if (typeof body.resume === "string" && body.resume.endsWith(".jsonl")) args.push("--resume", body.resume);
	if (typeof body.prompt === "string" && body.prompt !== "") args.push("-p", body.prompt.slice(0, 4000));

	// stderr ребёнка пишем в файл: без него причина падения запуска не видна.
	const errFile = openSync("/var/log/omp-exec-launcher-child.log", "a");
	const child = spawn("/usr/bin/setpriv", args, {
		cwd,
		env: {
			HOME: `/var/lib/${RUN_AS}`,
			PATH: "/usr/local/bin:/usr/bin:/bin",
			OMP_EXEC_LAUNCHED: "1",
			OMP_EXEC_LABEL: typeof body.label === "string" ? body.label.slice(0, 64) : "",
		},
		detached: true,
		stdio: ["ignore", errFile, errFile],
	});
	child.unref();
	log(`launch cwd=${cwd} pid=${child.pid ?? "?"} label=${String(body.label ?? "")}`);
	return { ok: true, pid: child.pid ?? undefined };
}

mkdirSync("/run/omp-exec-launcher", { recursive: true });
Bun.serve({
	unix: SOCKET,
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/ping") return Response.json({ ok: true, runAs: RUN_AS, root: ROOT });
		// Реестр collab исполнителя: состояние у каждого пользователя своё, поэтому
		// без этого шлюз не видит агентов, поднятых от omp-exec.
		if (url.pathname === "/collab-list") {
			const proc = Bun.spawnSync(
				["/usr/bin/setpriv", "--reuid=" + RUN_AS, "--regid=" + RUN_AS, "--clear-groups", "--inh-caps=-all", "--", OMP, "collab", "list", "--json"],
				{ env: { HOME: `/var/lib/${RUN_AS}`, PATH: "/usr/local/bin:/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/omp-exec-runtime/user` }, timeout: 8000 },
			);
			const out = proc.stdout.toString();
			return new Response(out === "" ? JSON.stringify({ version: 1, hosts: [] }) : out, { headers: { "content-type": "application/json" } });
		}
		if (url.pathname !== "/launch" || req.method !== "POST") return Response.json({ ok: false, error: "not found" }, { status: 404 });
		let body: LaunchRequest;
		try {
			body = (await req.json()) as LaunchRequest;
		} catch {
			return Response.json({ ok: false, error: "битый JSON" }, { status: 400 });
		}
		const result = launch(body);
		return Response.json(result, { status: result.ok ? 200 : 400 });
	},
});
log(`launcher started, socket ${SOCKET}, run as ${RUN_AS}, root ${ROOT}`);
console.log(`omp-exec-launcher: ${SOCKET} → ${RUN_AS}`);
