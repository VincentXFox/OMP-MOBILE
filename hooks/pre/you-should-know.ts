/**
 * you-should-know — наблюдатель «есть кое-что, что стоит знать».
 *
 * Порт поведения плагина Claude Code `cc-plugin-you-should-know` (2.1.292,
 * github.com/wassname/cc-plugin-you-should-know) на хуки OMP.
 *
 * Идея: раз в N шагов отдать компактную выжимку сессии отдельной модели с промптом
 * наблюдателя. Наблюдатель ищет ОДНУ вещь, которую человек мог упустить (торг,
 * необъяснённое решение, сомнительный результат), и почти всегда отвечает `learn: none`.
 * Наблюдатель не имеет инструментов, не меняет работу агента и не лезет в диалог:
 * заметка живёт в файле и попадает в систему только одной строкой на следующий ход.
 *
 * Настройки: ~/.omp/agent/you-should-know/config.json
 * Заметки: ~/.omp/agent/you-should-know/notes/<ключ>.md
 * Состояние: ~/.omp/agent/you-should-know/state/<ключ>.json
 * Диагностика: ~/.omp/agent/you-should-know/observer.log
 *
 * Ключ — рабочий каталог сессии: из событий tool_result и before_agent_start
 * идентификатор сессии не приходит вовсе, а session_stop его приносит. Ключи нельзя
 * смешивать — счётчики и очередь заметок расходятся (проверено зондом 03.11).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { withFileLock } from "../lib/lock.ts";

const ROOT = process.env.YSN_ROOT ?? join(homedir(), ".omp", "agent", "you-should-know");
const PROMPT_PATH = join(ROOT, "observer-prompt.md");
const CONFIG_PATH = join(ROOT, "config.json");

export interface YsnConfig {
	enabled: boolean;
	/** Проверять раз в столько шагов инструментов. */
	intervalSteps: number;
	/** Модель наблюдателя: дешёвая, без инструментов. */
	model: string;
	maxNotesPerHour: number;
	maxChars: number;
	timeoutMs: number;
}

export interface YsnNote {
	at: string;
	learn: string;
	tag: string;
	explain: string;
	hash: string;
	acknowledged: boolean;
}

export interface YsnState {
	steps: number;
	interval: number;
	notes: YsnNote[];
	pending: YsnNote[];
	suggested: number;
	ignored: number;
	/** Заметки, которые уже показаны, но по которым человек не отреагировал. */
	unsettled: number;
	lastCheckAt: string | null;
	/**
	 * Момент старта текущей проверки (мс). Хранится в состоянии и читается обратно:
	 * без этого дедупликация не работала и каждый шаг-триггер поднимал свой раннер.
	 */
	runningSince?: number;
}

const DEFAULTS: YsnConfig = {
	enabled: true,
	intervalSteps: 6,
	model: "deepseek-v4.1-flash",
	maxNotesPerHour: 3,
	maxChars: 8000,
	timeoutMs: 180_000,
};

export function loadConfig(): YsnConfig {
	if (!existsSync(CONFIG_PATH)) return DEFAULTS;
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<YsnConfig>;
		return { ...DEFAULTS, ...parsed };
	} catch {
		return DEFAULTS;
	}
}

/** Ответ наблюдателя: learn:none или реплика + тег + объяснение. */
export function parseObserver(text: string): { learn: string | null; tag: string; explain: string } {
	const learnMatch = /^\s*learn:\s*(.*)$/im.exec(text);
	if (!learnMatch) return { learn: null, tag: "", explain: "" };
	const learn = (learnMatch[1] ?? "").trim();
	if (learn.length === 0 || /^none\b/i.test(learn)) return { learn: null, tag: "", explain: "" };
	const tagMatch = /^\s*tag:\s*(.*)$/im.exec(text);
	const explainMatch = /^\s*explain:\s*([\s\S]*)$/im.exec(text);
	const clean = (value: string): string => value.replace(/[`*_]+/g, "").replace(/\s+/g, " ").trim();
	return {
		learn: clean(learn).slice(0, 300),
		tag: clean(tagMatch?.[1] ?? "You should know").slice(0, 80) || "You should know",
		explain: (explainMatch?.[1] ?? "").trim().slice(0, 4000),
	};
}

export function normalizeLearn(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.slice(0, 160);
}

export function noteHash(learn: string): string {
	return createHash("sha256").update(normalizeLearn(learn)).digest("hex").slice(0, 16);
}

/** Дедупликация и частота: одно и то же не повторяем, больше лимита в час — молчим. */
export function shouldSuggest(state: YsnState, learn: string, config: YsnConfig, now = Date.now()): boolean {
	const hash = noteHash(learn);
	if (state.notes.some(note => note.hash === hash)) return false;
	const hourAgo = now - 60 * 60 * 1000;
	const recent = state.notes.filter(note => Date.parse(note.at) > hourAgo).length;
	return recent < config.maxNotesPerHour;
}

/** Порог срабатывания: каждый N-й шаг, с ростом интервала, если заметки игнорируют. */
export function shouldTrigger(state: YsnState, config: YsnConfig): boolean {
	if (!config.enabled) return false;
	if (state.steps === 0) return false;
	return state.steps % Math.max(1, state.interval) === 0;
}

/** Новый шаг: считаем и, если пора, говорим «пора проверить». */
export function step(state: YsnState, config: YsnConfig): boolean {
	state.steps += 1;
	return shouldTrigger(state, config);
}

/** Принять найденную заметку в состояние (история + очередь на показ). */
export function accept(state: YsnState, parsed: { learn: string; tag: string; explain: string }, config: YsnConfig, now = Date.now()): YsnNote | null {
	if (!shouldSuggest(state, parsed.learn, config, now)) return null;
	const note: YsnNote = {
		at: new Date(now).toISOString(),
		learn: parsed.learn.slice(0, 300),
		tag: parsed.tag || "You should know",
		explain: parsed.explain,
		hash: noteHash(parsed.learn),
		acknowledged: false,
	};
	state.notes.push(note);
	state.pending.push(note);
	state.suggested += 1;
	if (state.notes.length > 100) state.notes = state.notes.slice(-100);
	return note;
}

/** Строка для системного промпта: одна заметка, компактно, с файлом подробностей. */
export function noteBlock(note: YsnNote, notesPath: string): string {
	return [
		"## Наблюдатель «You should know» (порт cc-plugin-you-should-know)",
		`${note.tag}: ${note.learn}`,
		`Подробности: ${notesPath}. Это внешнее наблюдение, а не указание: обсуди с человеком, если он спросит, и не меняй план работы ради него.`,
	].join("\n");
}

/** Если показанную заметку проигнорировали — реже проверяем (как в оригинальном плагине). */
export function settleIgnored(state: YsnState): void {
	if (state.unsettled <= 0) return;
	state.ignored += 1;
	state.unsettled = 0;
	state.interval = Math.min(24, Math.max(2, state.interval * 2));
}

function statePath(session: string): string {
	return join(ROOT, "state", `${session.replace(/[^\w.-]+/g, "_")}.json`);
}

function notesPath(session: string): string {
	return join(ROOT, "notes", `${session.replace(/[^\w.-]+/g, "_")}.md`);
}

/** Один и тот же замок для хука и раннера: иначе они пишут состояние параллельно. */
export function lockPath(session: string): string {
	return join(ROOT, "state", `${session.replace(/[^\w.-]+/g, "_")}.lock`);
}

export function transcriptFile(session: string): string {
	return join(ROOT, "state", `${session.replace(/[^\w.-]+/g, "_")}.transcript.txt`);
}

export async function readState(session: string, config: YsnConfig): Promise<YsnState> {
	try {
		const parsed = JSON.parse(await readFile(statePath(session), "utf8")) as Partial<YsnState>;
		return {
			steps: parsed.steps ?? 0,
			interval: parsed.interval ?? config.intervalSteps,
			notes: parsed.notes ?? [],
			pending: parsed.pending ?? [],
			suggested: parsed.suggested ?? 0,
			ignored: parsed.ignored ?? 0,
			unsettled: parsed.unsettled ?? 0,
			lastCheckAt: parsed.lastCheckAt ?? null,
			runningSince: parsed.runningSince ?? 0,
		};
	} catch {
		return { steps: 0, interval: config.intervalSteps, notes: [], pending: [], suggested: 0, ignored: 0, unsettled: 0, lastCheckAt: null, runningSince: 0 };
	}
}

export async function saveState(session: string, state: YsnState): Promise<void> {
	await mkdir(join(ROOT, "state"), { recursive: true });
	const target = statePath(session);
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
	// Атомарно: читатели не увидят полузаписанный JSON, параллельные писатели не теряют
	// счётчики (аудит показал steps: 1 вместо 3 при трёх событиях).
	await writeFile(temp, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	await rename(temp, target);
}

/** Вырезает очевидные секреты из текста, который уходит в файл и в чужую модель. */
export function redactSecrets(text: string): string {
	return text
		.replace(/(?:sk|ci|pk|ghp|glpat|xoxb)-[A-Za-z0-9_-]{8,}/gu, "[скрыто]")
		.replace(/("(?:password|passwd|token|api[_-]?key|secret|authorization)"\s*:\s*")[^"]{4,}(")/giu, "$1[скрыто]$2")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gu, "[скрыто]")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[закрытый ключ скрыт]");
}

/** Заметка на диск: каталог создаётся здесь же — раннер писал файл в несуществующий каталог. */
export async function appendNote(session: string, note: YsnNote): Promise<void> {
	await mkdir(join(ROOT, "notes"), { recursive: true });
	const body = [`## ${note.at} · ${note.tag}`, note.learn, "", note.explain || "", ""].join("\n");
	await appendFile(notesPath(session), body, "utf8");
}

/** Выжимка сессии: только то, что нужно для суждения, без простыни. */
export function transcriptBlock(lines: readonly string[], maxChars: number): string {
	const text = lines.join("\n");
	return text.length <= maxChars ? text : `${text.slice(0, Math.floor(maxChars * 0.6))}\n…\n${text.slice(-Math.floor(maxChars * 0.35))}`;
}

export function observerPrompt(lastSuggestions: string[], transcript: string): string {
	const prompt = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, "utf8") : "Ищи одну вещь, которую человек мог упустить.";
	const skip = lastSuggestions.length > 0 ? `\n\nЭти темы уже предлагались — не повторяй:\n${lastSuggestions.map(item => `- ${item}`).join("\n")}` : "";
	return `${prompt}${skip}\n\n## Текущая сессия\n\n${transcript}\n`;
}

/** Запрос к модели-наблюдателю: без инструментов, ограничен по времени, не блокирует работу. */
export async function askObserver(prompt: string, config: YsnConfig, cwd: string): Promise<string> {
	// Модель передаётся АРГУМЕНТОМ, а не подставляется в строку shell: раньше
	// значение из config.json исполнялось как команда (найдено аудитом).
	const stub = process.env.YSN_OBSERVER_CMD;
	const child =
		stub !== undefined && stub.trim().length > 0
			? spawn("bash", ["-lc", stub], { cwd }) // тестовая подмена: только через переменную окружения процесса
			: spawn("omp", ["-p", "--model", config.model, "--no-session"], {
					cwd,
					env: { ...process.env, YSN_DISABLED: "1" },
				});
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr.on("data", () => {});
	child.stdin.write(prompt);
	child.stdin.end();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		resolve();
	}, config.timeoutMs);
	child.on("close", () => {
		clearTimeout(timer);
		resolve();
	});
	child.on("error", () => {
		clearTimeout(timer);
		resolve();
	});
	await promise;
	return out;
}

/**
 * Интерпретатор для скрипта-раннера.
 *
 * Раньше брался process.execPath. Когда хук работает внутри omp, это сам omp:
 * `omp <скрипт> _tmp /tmp` — для omp это позиционный аргумент MESSAGES, то есть
 * новая агентская сессия с путём к скрипту вместо промпта. Такая сессия снова
 * грузила хуки и поднимала следующий раннер — за минуты выросли десятки процессов
 * и лишних сессий (инцидент 03.11).
 */
export function runtimeForScript(): string | null {
	if (process.env.YSN_RUNTIME) return existsSync(process.env.YSN_RUNTIME) ? process.env.YSN_RUNTIME : null;
	if (/^(bun|bunx|node)$/.test(basename(process.execPath))) return process.execPath;
	const candidates = [
		join(homedir(), ".bun", "bin", "bun"),
		"/opt/omp-exec-launcher/bun",
		"/usr/local/bin/bun",
		"/usr/bin/bun",
		...(process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "bun")),
	];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return null;
}

/** Диагностика наблюдателя: без неё сбой запуска раннера был полностью молчаливым. */
export async function observerLog(message: string): Promise<void> {
	await mkdir(ROOT, { recursive: true });
	await appendFile(join(ROOT, "observer.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
}

interface HookApi {
	on(event: "tool_result", handler: (event: unknown, ctx: { cwd: string; sessionId?: string }) => unknown): void;
	on(event: "before_agent_start", handler: (event: { systemPrompt?: string[] }, ctx: { cwd: string; sessionId?: string }) => unknown): void;
	on(event: "session_stop", handler: (event: unknown, ctx: { cwd: string; sessionId?: string }) => unknown): void;
}

/**
 * Ключ состояния — идентификатор сессии из окружения процесса, а при его отсутствии
 * рабочий каталог.
 *
 * В событиях идентификатора нет: tool_result и before_agent_start его не приносят
 * вовсе, session_stop приносит — ключевать по событию нельзя, счётчик шагов и очередь
 * заметок разъедутся по разным файлам (проверено зондом 03.11). omp публикует
 * PI_SESSION_ID для процесса сессии, поэтому хук читает его из окружения. Запасной
 * вариант — каталог: он стабилен, но общий для нескольких сессий в одном каталоге.
 */
function sessionOf(_event: unknown, ctx: { cwd: string }): string {
	const id = process.env.PI_SESSION_ID;
	return (id !== undefined && id.length > 0 ? id : ctx.cwd).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
}

export default function (pi: HookApi): void {
	const buffers = new Map<string, string[]>();
	/** Очередь операций на сессию: read→step→save не должны переплетаться. */
	const chains = new Map<string, Promise<void>>();
	const serialize = (session: string, run: () => Promise<void>): Promise<void> => {
		const previous = chains.get(session) ?? Promise.resolve();
		const next = previous.then(run, run);
		chains.set(session, next.catch(() => undefined));
		return next;
	};
	const config = loadConfig();
	/** Изменение состояния под межпроцессным замком: очередь в памяти не видит runner. */
	const mutateState = <T>(session: string, fn: (state: YsnState) => Promise<T> | T): Promise<T> =>
		withFileLock(lockPath(session), async () => {
			const state = await readState(session, config);
			return await fn(state);
		});
	// Наблюдатель запускает `omp -p` для самого себя: рекурсию отсекаем флагом.
	if (!config.enabled || process.env.YSN_DISABLED === "1") return;

	pi.on("tool_result", (event, ctx) => {
		const session = sessionOf(event, ctx);
		const e = event as { toolName?: unknown; input?: unknown; isError?: unknown };
		const tool = typeof e.toolName === "string" ? e.toolName : "tool";
		const summary = `${tool}: ${redactSecrets(JSON.stringify(e.input ?? {})).slice(0, 600)}${e.isError === true ? " → ошибка" : ""}`;
		const buffer = buffers.get(session) ?? [];
		buffer.push(summary);
		if (buffer.length > 80) buffer.splice(0, buffer.length - 80);
		buffers.set(session, buffer);
		void serialize(session, async () => {
			const state = await mutateState(session, async (current) => {
				if (!step(current, config)) {
					await saveState(session, current);
					return null;
				}
				current.lastCheckAt = new Date().toISOString();
				await saveState(session, current);
				return current;
			});
			if (state === null) return;
			// Проверку делает отдельный процесс: он переживает конец короткой сессии.
			await mkdir(join(ROOT, "state"), { recursive: true });
			await writeFile(transcriptFile(session), transcriptBlock(buffer, config.maxChars), "utf8");
			// Раннер — отдельный процесс, а не хук: лежит в hooks/bin, иначе omp пытается
			// загрузить его как расширение и падает (инцидент 31.10).
			const runner = join(import.meta.dir, "..", "bin", "you-should-know-runner.ts");
			const runtime = runtimeForScript();
			if (runtime === null) {
				await observerLog(`нет интерпретатора bun для ${runner} — проверка пропущена`);
				return;
			}
			const child = spawn(runtime, [runner, session, ctx.cwd], {
				cwd: ctx.cwd,
				detached: true,
				stdio: "ignore",
				env: { ...process.env, YSN_ROOT: ROOT },
			});
			child.on("error", (error) => void observerLog(`раннер не запустился: ${error.message}`));
			child.unref();
		}).catch((error) => {
			// наблюдатель не должен ломать работу агента
			void observerLog(`сбой проверки: ${error instanceof Error ? error.message : String(error)}`);
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const session = sessionOf(event, ctx);
		const base = Array.isArray(event?.systemPrompt) ? [...event.systemPrompt] : [];
		const note = await mutateState(session, async (state) => {
			const taken = state.pending.shift();
			if (!taken) return null;
			state.unsettled += 1;
			await saveState(session, state);
			return taken;
		});
		if (!note) return { systemPrompt: base };
		base.push(noteBlock(note, notesPath(session)));
		return { systemPrompt: base };
	});

	pi.on("session_stop", (event, ctx) => {
		const session = sessionOf(event, ctx);
		void (async () => {
			const state = await readState(session, config);
			settleIgnored(state);
			await saveState(session, state);
		})();
		return undefined;
	});
}

export { DEFAULTS, ROOT, CONFIG_PATH, notesPath, statePath };
