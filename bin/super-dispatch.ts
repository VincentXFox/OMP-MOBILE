#!/usr/bin/env bun
// super-dispatch — CLI-мост к gateway API для раздачи задач воркерам.
// Только стандартная библиотека Bun/Node.

import { readFileSync } from "node:fs";
import { statSync, openSync, readSync, closeSync } from "node:fs";

interface GatewayConfig {
	token: string;
	port: number;
	host: string;
}

interface DispatchItemResult {
	target: string;
	ok: boolean;
	error?: string;
}

function usage(): void {
	process.stdout.write(`super-dispatch — раздача задач воркерам через gateway

Usage:
  super-dispatch board                 показать таблицу агентов и orphans
  super-dispatch send <target> <file|->  отправить текст задачи (файл или stdin)
  super-dispatch activity <target>     показать активность агента
  super-dispatch -h | (без аргументов)  эта справка

Exit codes:
  0 успех; 1 ошибка API; 2 нет/битый конфиг; 3 gateway недоступен;
  4 неавторизован (401); 5 плохой ввод.
`);
}

function fail(msg: string, code: number): never {
	process.stderr.write(`${msg}\n`);
	process.exit(code);
}

function loadConfig(): GatewayConfig {
	const path = process.env.SUPER_GATEWAY_CONFIG ?? `${import.meta.dir}/../gateway/config.json`;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		fail(`config: cannot read/parse ${path}: ${(e as Error).message}`, 2);
	}
	if (typeof raw !== "object" || raw === null) fail(`config: ${path} is not an object`, 2);
	const cfg = raw as Record<string, unknown>;
	if (typeof cfg.token !== "string" || cfg.token === "") fail(`config: missing "token" in ${path}`, 2);
	if (typeof cfg.port !== "number" || !Number.isFinite(cfg.port)) fail(`config: missing "port" in ${path}`, 2);
	if (typeof cfg.host !== "string" || cfg.host === "") fail(`config: missing "host" in ${path}`, 2);
	// bind-адрес: для запросов ходим на loopback, если host не явный IP
	const reqHost = /^[\d.]+$/.test(cfg.host) ? cfg.host : "127.0.0.1";
	return { token: cfg.token, port: cfg.port, host: reqHost };
}

function baseUrl(cfg: GatewayConfig): string {
	return `http://${cfg.host}:${cfg.port}`;
}

async function apiFetch(cfg: GatewayConfig, path: string, init?: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`${baseUrl(cfg)}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${cfg.token}`, ...(init?.headers ?? {}) },
			signal: AbortSignal.timeout(20_000),
		});
	} catch (e) {
		fail(`gateway unreachable at ${baseUrl(cfg)}: ${(e as Error).message}`, 3);
	}
	if (res.status === 401) fail("gateway: unauthorized (bad token?)", 4);
	return res;
}

function padEnd(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Ячейка фиксированной ширины: длинные значения обрезаются с «…», колонки не едут. */
function cell(s: string, n: number): string {
	return padEnd(s.length > n ? s.slice(0, n - 1) + "…" : s, n);
}

async function cmdBoard(cfg: GatewayConfig): Promise<void> {
	const res = await apiFetch(cfg, "/api/super/board");
	if (!res.ok) fail(`gateway: /board ${res.status}: ${await res.text()}`, 1);
	const board = (await res.json()) as {
		agents: Array<{
			target: string;
			name: string;
			agentStatus: string;
			cwd: string;
			host: { model?: { provider?: string; id?: string } } | null;
		}>;
		orphans: Array<{ instanceId: string; cwd: string; sessionName: string; busy: boolean }>;
	};
	process.stdout.write(
		[
			"TARGET    NAME              STATUS    MODEL                   CWD",
			...board.agents.map((a) =>
				cell(a.target, 10) +
				cell(a.name, 18) +
				cell(a.agentStatus, 10) +
				cell(a.host?.model ? `${a.host.model.provider}/${a.host.model.id}` : "-", 24) +
				a.cwd,
			),
		].join("\n") + "\n",
	);
	if (board.orphans.length > 0) {
		process.stdout.write("\nOrphans:\n");
		for (const o of board.orphans) {
			process.stdout.write(`  ${o.instanceId}  ${o.sessionName}${o.busy ? " (busy)" : ""}  ${o.cwd}\n`);
		}
	}
}

function readStdinSync(): string {
	const fd = openSync("/dev/stdin", "r");
	const chunks: Buffer[] = [];
	const buf = Buffer.alloc(65536);
	try {
		for (;;) {
			const n = readSync(fd, buf);
			if (n <= 0) break;
			chunks.push(Buffer.from(buf.subarray(0, n)));
		}
	} finally {
		closeSync(fd);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function cmdSend(cfg: GatewayConfig, target: string, src: string): Promise<void> {
	if (!target) fail("send: missing <target>", 5);
	if (!src) fail("send: missing <file|->", 5);
	let text: string;
	if (src === "-") {
		text = readStdinSync();
	} else {
		try {
			if (statSync(src).isDirectory()) fail(`send: ${src} is a directory`, 5);
			text = readFileSync(src, "utf8");
		} catch (e) {
			fail(`send: cannot read ${src}: ${(e as Error).message}`, 5);
		}
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > 65536) fail(`send: task text is ${bytes} bytes, limit 65536`, 5);
	if (text.trim() === "") fail("send: task text is empty", 5);
	const res = await apiFetch(cfg, "/api/super/dispatch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ items: [{ target, text }] }),
	});
	if (!res.ok) fail(`gateway: /dispatch ${res.status}: ${await res.text()}`, 1);
	const data = (await res.json()) as { results: DispatchItemResult[] };
	const r = data.results.find((x) => x.target === target) ?? data.results[0];
	if (!r) fail("gateway: /dispatch returned no results", 1);
	if (r.ok) {
		process.stdout.write(`✓ ${r.target}\n`);
		process.exit(0);
	}
	process.stdout.write(`✗ ${r.target}: ${r.error ?? "unknown error"}\n`);
	process.exit(1);
}

interface SuperActivity {
	status?: string;
	title?: string;
	cwd?: string;
	model?: { provider?: string; id?: string } | null;
	tail?: string;
	subagents?: Array<{ name: string; state?: string; activity?: string; active?: boolean }>;
	[key: string]: unknown;
}

async function cmdActivity(cfg: GatewayConfig, target: string): Promise<void> {
	if (!target) fail("activity: missing <target>", 5);
	const res = await apiFetch(cfg, `/api/super/agent/${encodeURIComponent(target)}/activity`);
	if (res.status === 404) fail(`activity: no activity for ${target}`, 1);
	if (!res.ok) fail(`gateway: /activity ${res.status}: ${await res.text()}`, 1);
	const a = (await res.json()) as SuperActivity | null;
	if (!a) fail(`activity: no activity for ${target}`, 1);
	const model = a.model ? `${a.model.provider}/${a.model.id}` : "-";
	const lines: string[] = [
		`target:  ${target}`,
		`status:  ${a.status ?? "-"}`,
		`title:   ${a.title ?? "-"}`,
		`cwd:     ${a.cwd ?? "-"}`,
		`model:   ${model}`,
	];
	if (a.tail) {
		const tail = a.tail.length > 2000 ? a.tail.slice(-2000) : a.tail;
		lines.push("", "--- tail ---", tail);
	}
	if (a.subagents && a.subagents.length > 0) {
		lines.push("", "Subagents:");
		for (const s of a.subagents) {
			const mark = s.active ? " [active]" : "";
			lines.push(`  ${s.name} — ${s.state ?? "-"} — ${s.activity ?? "-"}${mark}`);
		}
	}
	process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		usage();
		process.exit(args.length === 0 ? 0 : 0);
	}
	const cmd = args[0];
	if (cmd === "board") {
		await cmdBoard(loadConfig());
		return;
	}
	if (cmd === "send") {
		await cmdSend(loadConfig(), args[1] ?? "", args[2] ?? "");
		return;
	}
	if (cmd === "activity") {
		await cmdActivity(loadConfig(), args[1] ?? "");
		return;
	}
	usage();
	process.exit(5);
}

await main();
