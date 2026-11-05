/**
 * Отдельный процесс проверки: хук только запускает его и не ждёт.
 * Так наблюдатель доживает до конца короткой сессии (omp -p), где процесс агента
 * завершается сразу после ответа.
 *
 * Использование: bun you-should-know-runner.ts <ключ сессии> <cwd>
 *
 * ВАЖНО: файл лежит в hooks/bin, и omp импортирует как хуки только hooks/pre/*.ts.
 * Запускать его обязан интерпретатор bun (см. runtimeForScript в pre/you-should-know.ts):
 * запуск через бинарь omp превращал путь к скрипту в промпт новой агентской сессии,
 * а та снова грузила хуки и поднимала следующий раннер — каскад процессов (инцидент 03.11).
 */
import {
	accept,
	appendNote,
	askObserver,
	loadConfig,
	lockPath,
	observerLog,
	observerPrompt,
	parseObserver,
	readState,
	saveState,
	transcriptFile,
} from "../pre/you-should-know.ts";
import { withFileLock } from "../lib/lock.ts";
import { readFile, unlink } from "node:fs/promises";

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
	const [session, cwd] = process.argv.slice(2);
	if (!session || !cwd) {
		process.stderr.write("нужны ключ сессии и cwd\n");
		process.exit(2);
	}

	const config = loadConfig();

	// Выжимка: её отсутствие — это «нет данных», а не успех и не ошибка.
	let transcript = "";
	try {
		transcript = await readFile(transcriptFile(session), "utf8");
	} catch (error) {
		process.stderr.write(`выжимка недоступна: ${reason(error)}\n`);
		process.exit(3);
	}
	if (transcript.trim().length === 0) {
		process.stderr.write("выжимка пуста — наблюдать нечего\n");
		process.exit(3);
	}

	// Дедупликация запусков: второй процесс по той же сессии не должен дублировать
	// проверку. Метка читается из состояния (runningSince) и снимается ниже; запас
	// на устаревшую метку — собственный таймаут наблюдателя плюс минута.
	const staleMs = config.timeoutMs + 60_000;
	const claimed = await withFileLock(lockPath(session), async () => {
		const current = await readState(session, config);
		const now = Date.now();
		if ((current.runningSince ?? 0) > 0 && now - (current.runningSince ?? 0) < staleMs) return null;
		current.runningSince = now;
		await saveState(session, current);
		return current;
	});
	if (claimed === null) {
		process.stderr.write("проверка уже идёт — второй запуск пропущен\n");
		process.exit(0);
	}

	let answer = "";
	try {
		answer = await askObserver(observerPrompt(claimed.notes.slice(-5).map((note) => note.learn), transcript), config, cwd);
	} catch (error) {
		// Техническая ошибка наблюдателя: снимаем метку, код возврата ненулевой.
		await withFileLock(lockPath(session), async () => {
			const fresh = await readState(session, config);
			delete fresh.runningSince;
			await saveState(session, fresh);
		});
		await observerLog(`наблюдатель не ответил: ${reason(error)}`);
		process.stderr.write(`наблюдатель не ответил: ${reason(error)}\n`);
		process.exit(4);
	}

	const parsed = parseObserver(answer);
	// Ответ разобран и применён к состоянию, ПЕРЕЧИТАННОМУ после обращения к модели:
	// счётчики, накопленные хук за это время, не затираются старым снимком.
	const applied = await withFileLock(lockPath(session), async () => {
		const fresh = await readState(session, config);
		delete fresh.runningSince;
		fresh.lastCheckAt = new Date().toISOString();
		const note = parsed.learn ? accept(fresh, { learn: parsed.learn, tag: parsed.tag, explain: parsed.explain }, config) : null;
		await saveState(session, fresh);
		return note;
	});
	if (applied) await appendNote(session, applied);
	await unlink(transcriptFile(session)).catch(() => undefined);
	process.stderr.write(applied ? "наблюдение выполнено: заметка сохранена\n" : "наблюдение выполнено: замечаний нет\n");
	process.exit(0);
}

if (import.meta.main) await main();
