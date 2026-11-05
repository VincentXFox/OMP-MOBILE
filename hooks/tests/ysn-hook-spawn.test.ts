/**
 * Регрессия корня инцидента 03.11: хук наблюдателя поднимал раннер интерпретатором
 * process.execPath. Внутри агентской сессии это сам omp, для которого путь к скрипту —
 * первое сообщение новой сессии: она снова грузит хуки, те снова поднимают процесс —
 * за минуты десятки лишних сессий (21 сессия и 4.8 МБ транскриптов за 22 минуты).
 *
 * Проверяется два звена:
 * 1. runtimeForScript под именем «omp» всё равно выбирает bun (жёсткая ссылка на
 *    текущий интерпретатор даёт ровно тот случай, что был в бою).
 * 2. Шестой шаг инструментов поднимает раннер теми же аргументами и с той же
 *    выжимкой — через подставной интерпретатор, который записывает argv.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ROOT = join(tmpdir(), `ysn-spawn-${process.pid}`);
const HOOKS = join(import.meta.dir, "..");
const RUNNER = join(HOOKS, "bin", "you-should-know-runner.ts");
const CWD = join(ROOT, "cwd");
/** Ключ сессии считает сам хук: идентификатора сессии нет, значит рабочий каталог. */
const KEY = CWD.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
const RECORD = join(ROOT, "argv.txt");
const RECORDER = join(ROOT, "recorder.sh");

type Handler = (event: unknown, ctx: { cwd: string }) => unknown;

// Ожидание внешнего процесса: хук поднимает раннер отсоединённым и промиса не отдаёт,
// а подставной интерпретатор — отдельный процесс, чей файл появляется на диске.
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (check()) return;
		if (Date.now() - started > timeoutMs) throw new Error("условие не наступило за отведённое время");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 25);
		await promise;
	}
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(CWD, { recursive: true });
	writeFileSync(RECORDER, `#!/bin/sh\nprintf '%s\\n' "$@" > ${RECORD}\n`);
	chmodSync(RECORDER, 0o755);
});

// Тестовые файлы bun исполняет в одном процессе: без возврата переменных подставной
// интерпретатор утекает в соседние файлы и ломает их проверки.
const SAVED = { YSN_ROOT: process.env.YSN_ROOT, YSN_RUNTIME: process.env.YSN_RUNTIME, PI_SESSION_ID: process.env.PI_SESSION_ID };

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	for (const [name, value] of Object.entries(SAVED)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

test("под именем omp выбирается bun, а не текущий бинарь", async () => {
	const fake = join(ROOT, "omp");
	linkSync(process.execPath, fake);
	const probe = join(ROOT, "probe.ts");
	writeFileSync(
		probe,
		`import { runtimeForScript } from ${JSON.stringify(join(HOOKS, "pre", "you-should-know.ts"))};\nconsole.log(runtimeForScript() ?? "null");\n`,
	);
	const child = Bun.spawn([fake, probe], { env: { ...process.env, YSN_RUNTIME: "" }, stdout: "pipe", stderr: "ignore" });
	const out = (await new Response(child.stdout).text()).trim();
	await child.exited;
	expect(basename(out)).toBe("bun");
	expect(out).not.toBe(fake);
}, 30_000);

test("шестой шаг поднимает раннер с выжимкой и правильными аргументами", async () => {
	process.env.YSN_ROOT = ROOT;
	process.env.YSN_RUNTIME = RECORDER;
	delete process.env.PI_SESSION_ID;
	delete process.env.YSN_DISABLED;

	const handlers = new Map<string, Handler>();
	// Динамический импорт обязателен: модуль читает YSN_ROOT и config.json на верхнем
	// уровне, а статический импорт выполнился бы до beforeAll — тест писал бы состояние
	// наблюдателя в живой каталог владельца.
	const { default: hook } = await import("../pre/you-should-know.ts");
	hook({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);

	const toolResult = handlers.get("tool_result");
	expect(toolResult).toBeDefined();
	for (let i = 1; i <= 6; i += 1) {
		toolResult?.({ toolName: "bash", input: { command: `echo шаг ${i}` } }, { cwd: CWD });
	}
	await waitFor(() => existsSync(RECORD));

	const argv = readFileSync(RECORD, "utf8").trim().split("\n");
	expect(argv[0]).toBe(RUNNER);
	expect(argv[1]).toBe(KEY);
	expect(argv[2]).toBe(CWD);

	const transcript = join(ROOT, "state", `${KEY}.transcript.txt`);
	await waitFor(() => existsSync(transcript));
	expect(readFileSync(transcript, "utf8")).toContain("echo шаг 6");
}, 30_000);
