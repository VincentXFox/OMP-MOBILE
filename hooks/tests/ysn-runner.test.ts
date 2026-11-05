/**
 * Регрессия раннера наблюдателя:
 * - второй запуск по той же сессии пропускается (метка runningSince читается из состояния);
 * - заметка ложится в notes/<ключ>.md, каталог создаётся сам.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `ysn-runner-${process.pid}`);
const RUNNER = join(import.meta.dir, "..", "bin", "you-should-know-runner.ts");
const SESSION = "test-session";
const CWD = join(ROOT, "cwd");
const STATE = join(ROOT, "state", `${SESSION}.json`);
const TRANSCRIPT = join(ROOT, "state", `${SESSION}.transcript.txt`);
const NOTES = join(ROOT, "notes", `${SESSION}.md`);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function seedTranscript(): void {
	mkdirSync(join(ROOT, "state"), { recursive: true });
	mkdirSync(CWD, { recursive: true });
	writeFileSync(TRANSCRIPT, "bash: {\"command\":\"echo ok\"}\n");
}

function runRunner(stub: string): Bun.Subprocess<"ignore", "pipe", "ignore"> {
	return Bun.spawn([process.execPath, RUNNER, SESSION, CWD], {
		env: { ...process.env, YSN_ROOT: ROOT, YSN_OBSERVER_CMD: stub },
		stdout: "ignore",
		stderr: "pipe",
	});
}

async function stderrOf(process_: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<string> {
	const text = await new Response(process_.stderr).text();
	await process_.exited;
	return text;
}

async function waitForRunning(timeoutMs = 8000): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (existsSync(STATE) && JSON.parse(readFileSync(STATE, "utf8")).runningSince > 0) return;
		if (Date.now() - started > timeoutMs) throw new Error("метка runningSince не появилась");
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 50);
		await promise;
	}
}

// Реальное время здесь неизбежно: тест поднимает отдельные процессы раннера и
// проверяет межпроцессный замок — подделать часы в чужом процессе нельзя.
test("второй запуск пропускается, пока идёт первый", async () => {
	rmSync(join(ROOT, "state"), { recursive: true, force: true });
	seedTranscript();
	const slow = runRunner("sleep 3; printf 'learn: none\\n'");
	await waitForRunning();
	const second = runRunner("printf 'learn: Проверка дедупликации\\n'");
	expect(await stderrOf(second)).toContain("уже идёт");
	expect(await stderrOf(slow)).toContain("замечаний нет");
	// Метка снята: следующий запуск снова возможен.
	expect(JSON.parse(readFileSync(STATE, "utf8")).runningSince ?? 0).toBe(0);
}, 30_000);

test("заметка сохраняется в notes и в состоянии", async () => {
	rmSync(join(ROOT, "state"), { recursive: true, force: true });
	rmSync(join(ROOT, "notes"), { recursive: true, force: true });
	seedTranscript();
	const runner = runRunner("printf 'learn: Индекс стал медленнее\\ntag: Heads up\\nexplain:\\nПервый пункт\\n'");
	expect(await stderrOf(runner)).toContain("заметка сохранена");
	const notes = readFileSync(NOTES, "utf8");
	expect(notes).toContain("Heads up");
	expect(notes).toContain("Индекс стал медленнее");
	expect(notes).toContain("Первый пункт");
	const state = JSON.parse(readFileSync(STATE, "utf8"));
	expect(state.notes).toHaveLength(1);
	expect(state.pending).toHaveLength(1);
	expect(state.suggested).toBe(1);
}, 30_000);

test("пустая выжимка не запускает наблюдателя", async () => {
	rmSync(join(ROOT, "state"), { recursive: true, force: true });
	mkdirSync(join(ROOT, "state"), { recursive: true });
	writeFileSync(TRANSCRIPT, "\n");
	const runner = runRunner("printf 'learn: что-то\\n'");
	expect(await stderrOf(runner)).toContain("выжимка пуста");
}, 20_000);
