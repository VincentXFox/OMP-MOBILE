/**
 * Заслонка «скрипт вместо промпта» (инцидент 03.11).
 *
 * Как ломается: хук, поднимающий отдельный процесс, берёт в качестве интерпретатора
 * бинарь omp. Для omp путь к скрипту — это не файл, а первое сообщение новой
 * агентской сессии: сессия снова грузит хуки, те снова поднимают процесс — за минуты
 * десятки лишних агентских сессий. Корень починен (runtimeForScript в
 * pre/you-should-know.ts), но сессии, стартовавшие до правки, держат старый код хука
 * в памяти и продолжают плодить такие сессии, пока живут.
 *
 * Что делает заслонка: гасит процесс сессии, чей промпт — путь к скрипту внутри
 * каталога хуков, до первого запроса к модели и без инструментов. `ctx.abort()`
 * для этого не годится: ход прерывается, а цикл агента продолжается (прогон 03.11:
 * 13 ходов и 13 запросов за 4 минуты после abort). Всё остальное — обычная работа,
 * заслонка в неё не вмешивается (fail-open). Интерактивную сессию (stdin — терминал)
 * она не гасит, а только пишет в журнал: там человек за клавиатурой.
 *
 * Журнал: ~/.omp/logs/script-prompt-guard.log
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HOOKS_DIR = resolve(import.meta.dir, "..");
const LOG = join(homedir(), ".omp", "logs", "script-prompt-guard.log");
const SCRIPT_RE = /\.(?:[cm]?[jt]s)$/i;

interface GuardApi {
	on(
		event: "before_agent_start",
		handler: (event: unknown, ctx: { cwd?: string }) => unknown,
	): void;
}

async function log(line: string): Promise<void> {
	try {
		await mkdir(dirname(LOG), { recursive: true });
		await appendFile(LOG, `${new Date().toISOString()} ${line}\n`, "utf8");
	} catch {
		// журнал не должен ломать заслонку
	}
}

/**
 * Путь к скрипту хука в промпте — или null.
 *
 * Берётся только первая строка и только одно слово: прозаический текст с путём
 * внутри (например, это описание инцидента) заслонку не поднимает.
 */
export function scriptPromptPath(prompt: unknown, cwd: string): string | null {
	if (typeof prompt !== "string") return null;
	const candidate = (prompt.split(/\r?\n/, 1)[0] ?? "").trim().replace(/^["'`]|["'`]$/g, "");
	if (candidate.length === 0 || /\s/.test(candidate) || !SCRIPT_RE.test(candidate)) return null;
	const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
	return abs.startsWith(`${HOOKS_DIR}/`) ? abs : null;
}

export default function (pi: GuardApi): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
			const hit = scriptPromptPath((event as { prompt?: unknown } | undefined)?.prompt, cwd);
			if (hit === null) return;
			// ctx.abort() здесь недостаточно: прогон 03.11 показал, что ход
			// прерывается, а цикл агента продолжается — за 4 минуты 13 ходов
			// и столько же запросов к модели. Поэтому процесс гасится.
			// Интерактивную сессию не трогаем: там человек, ему виднее.
			const interactive = process.stdin.isTTY === true;
			// Журнал пишется до выхода: без await строка терялась вместе с процессом.
			await log(`заслонка: промпт — путь к скрипту хука ${hit} (cwd ${cwd}, pid ${process.pid}, интерактив ${interactive})`);
			if (interactive) return;
			process.exit(1);
		} catch {
			// fail-open: заслонка не имеет права мешать обычной работе
		}
	});
}
