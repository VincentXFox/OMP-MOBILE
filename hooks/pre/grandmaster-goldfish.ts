/**
 * GRANDMASTER 10.x — Goldfish: требование независимой проверки.
 *
 * Зачем: финальный ответ может быть красивым, а работа — непроверенной. Строка
 * «ADVERSARIAL: PASS» в тексте ничего не доказывает. Здесь проверяется наличие
 * РЕАЛЬНОГО прогона проверяющего (запись в `~/.omp/goldfish/runs/` + копия в
 * `.omp/gate/<slug>/goldfish/`), свежего по хешу предмета проверки.
 *
 * Что делает хук:
 *   - считает по событиям, что сессия реально делала (инструменты, пути, шаги);
 *   - на `session_stop` применяет политику соразмерности (`goldfish-policy.ts`);
 *   - для уровней standard/enhanced требует свежий PASS нужной стадии;
 *   - напоминает ОДИН раз за сессию и называет точную команду запуска;
 *   - внутри проверяющего (`GOLDFISH=1`) не работает вообще — рекурсии нет.
 *
 * Чего хук НЕ делает: не запускает проверяющего сам (долгая работа внутри хука
 * остановила бы обработку событий) и не считает PASS-ом текст без записи прогона.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readAcceptance, recordAttempt, recordVerified } from "../lib/gate-state.ts";
import { verifyAcceptance } from "../lib/trusted-verification.ts";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const RUNS_DIR = join(homedir(), ".omp", "goldfish", "runs");
/** Одно напоминание за сессию: это обучение порядку работы, а не гейт-ловушка. */
const MAX_BLOCKS_PER_SESSION = 1;

interface SessionState {
	prompt: string;
	tools: string[];
	paths: string[];
	steps: number;
	blocks: number;
	/** Задача, к которой относится состояние: смена задачи сбрасывает ожидания. */
	taskId: string | null;
	/** Идентификаторы уже учтённых вызовов: повторная доставка не считается дважды. */
	seenCalls: string[];
}

const STATE = new Map<string, SessionState>();
/** Ключ сессии на конкретный ctx: вычисляется один раз, чтобы состояние не
 * разъезжалось между событиями (tool_call без session_id и session_stop с ним). */
const KEY_BY_CTX = new WeakMap<object, string>();
function keyOf(ctx: unknown, event?: unknown): string {
	// Стабильный идентификатор: сначала из события, затем из реального API сессии.
	const fromEvent = (event as { session_id?: unknown } | undefined)?.session_id;
	if (typeof fromEvent === "string" && fromEvent !== "") return fromEvent.slice(0, 96);
	if (ctx !== null && typeof ctx === "object") {
		const known = KEY_BY_CTX.get(ctx);
		if (known !== undefined) return known;
		const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
		const fromManager = manager?.getSessionId?.();
		const key =
			typeof fromManager === "string" && fromManager !== ""
				? fromManager
				: typeof (ctx as { sessionId?: unknown }).sessionId === "string"
					? String((ctx as { sessionId?: string }).sessionId)
					: `cwd:${String((ctx as { cwd?: unknown }).cwd ?? "unknown")}`;
		KEY_BY_CTX.set(ctx, key.slice(0, 96));
		return key.slice(0, 96);
	}
	return "no-context";
}
function stateOf(ctx: unknown, event?: unknown): SessionState {
	const key = keyOf(ctx, event);
	let state = STATE.get(key);
	if (state === undefined) {
		state = { prompt: "", tools: [], paths: [], steps: 0, blocks: 0, taskId: null, seenCalls: [] };
		STATE.set(key, state);
	}
	return state;
}

/** Рабочая зона владельца — как у стоп-гейта: стол, git-проект или каталог с .omp. */
function isWorkArea(cwd: string): boolean {
	return (
		existsSync(join(cwd, ".omp")) ||
		existsSync(join(cwd, ".git")) ||
		cwd === join(homedir(), "OMP") ||
		cwd.startsWith(join(homedir(), "OMP") + "/")
	);
}

/**
 * Соразмерность: считается по фактам сессии. Тривиальные ответы проверку не
 * требуют, изменения кода и конфигурации — требуют, прод и доступы — усиленно.
 * Копия правил политики здесь намеренно минимальна: полная живёт в
 * `~/omp-mobile/bin/goldfish-policy.ts` и используется CLI.
 */
export function tierOf(state: SessionState): "none" | "light" | "standard" | "enhanced" {
	const text = `${state.prompt}\n${state.paths.join("\n")}`;
	if (state.steps <= 2 && state.tools.length === 0) return "none";
	if (/\b(?:srv78|de5|thor1|vpn|wireguard|firewall|ufw|prod|прод|миграц|deploy|деплой)\w*/iu.test(text) || state.paths.some(p => /\/(?:etc|srv|opt)\//.test(p)))
		return "enhanced";
	if (state.tools.includes("edit") || state.tools.includes("write") || state.steps >= 8) return "standard";
	return "light";
}

/** Совпадение путей только по каноническому виду, без сравнения окончаний. */
function sameFile(a: string, b: string): boolean {
	try {
		return normalize(isAbsolute(a) ? a : resolve(a)) === normalize(isAbsolute(b) ? b : resolve(b));
	} catch {
		return false;
	}
}

/**
 * Свежий PASS по стадии ДЛЯ ЭТОЙ работы: недостаточно «где-то был PASS».
 * Запись должна быть свежей и её пакет — содержать хотя бы один из путей,
 * которые меняла сессия. Иначе чужой прогон закрывал бы проверку.
 */
export function hasFreshPass(stage: "plan" | "result", paths: readonly string[] = [], maxAgeMs = 12 * 60 * 60 * 1000): boolean {
	try {
		const names = readdirSync(RUNS_DIR).sort().reverse().slice(0, 60);
		for (const name of names) {
			try {
				const record = JSON.parse(readFileSync(join(RUNS_DIR, name, "result.json"), "utf8")) as {
					stage?: string;
					verdict?: string;
					finishedAt?: string;
				};
				if (record.stage !== stage || record.verdict !== "PASS") continue;
				const at = Date.parse(record.finishedAt ?? "");
				if (!Number.isFinite(at) || Date.now() - at >= maxAgeMs) continue;
				if (paths.length === 0) return true;
				const packet = JSON.parse(readFileSync(join(RUNS_DIR, name, "packet.json"), "utf8")) as { materials?: unknown };
				const materials = Array.isArray(packet.materials) ? packet.materials.filter((m): m is string => typeof m === "string") : [];
				// Только точное совпадение канонических путей: сравнение по окончанию
				// строки пропускало чужой файл с тем же именем (запись для
				// /different-project/app.ts закрывала правку app.ts).
				if (materials.some(material => paths.some(path => sameFile(material, path)))) return true;
			} catch {
				continue;
			}
		}
	} catch {
		return false;
	}
	return false;
}

export default function (pi: HookApi): void {
	// Внутри проверяющего хук не работает: иначе Goldfish требовал бы Goldfish.
	if (process.env.GOLDFISH === "1") return;

	pi.on("session_start", (_event, ctx) => {
		try {
			STATE.delete(keyOf(ctx));
		} catch {
			// fail-open
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		try {
			const prompt = (event as { prompt?: unknown }).prompt;
			if (typeof prompt === "string" && prompt.trim() !== "") stateOf(ctx).prompt = prompt;
		} catch {
			// fail-open
		}
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		try {
			const e = event as { toolName?: unknown; input?: unknown };
			const tool = typeof e.toolName === "string" ? e.toolName : "";
			if (tool === "") return undefined;
			const state = stateOf(ctx);
			state.steps += 1;
			if (!state.tools.includes(tool)) state.tools.push(tool);
			const input = e.input as { path?: unknown; file_path?: unknown; command?: unknown } | undefined;
			const path = typeof input?.path === "string" ? input.path : typeof input?.file_path === "string" ? input.file_path : "";
			if (path !== "" && !state.paths.includes(path)) state.paths.push(path);
		} catch {
			// fail-open
		}
		return undefined;
	});

	pi.on("session_stop", async (event, ctx) => {
		try {
			const cwd = String((ctx as { cwd?: string } | undefined)?.cwd ?? "");
			if (cwd === "" || !isWorkArea(cwd)) return undefined;
			const state = stateOf(ctx, event);
			const tier = tierOf(state);
			if (tier !== "standard" && tier !== "enhanced") return undefined;
			// Подтверждение принимается только от демона и только для ТЕКУЩЕГО предмета.
			const project = cwd;
			const verified = await verifyAcceptance(project, "result", state.paths);
			if (verified.ok && verified.slug !== null) {
				recordVerified(project, verified.slug, {
					stage: "result",
					runId: verified.runId,
					subjectHash: verified.subjectHash,
					taskHash: state.taskId,
				}, verified.reason);
				return undefined;
			}
			if (state.blocks >= MAX_BLOCKS_PER_SESSION) {
				// Бюджет исчерпан: дальше не давим повторами, но состояние приёмки
				// остаётся неподтверждённым, и слово ГОТОВО не принимается стоп-гейтом.
				return undefined;
			}
			state.blocks += 1;
			const plan = tier === "enhanced" ? " Проверка плана обязательна (усиленный уровень)." : "";
			return {
				decision: "block",
				reason:
					"GOLDFISH · независимая проверка: работа уровня «" +
					tier +
					"» завершается без реального прогона проверяющего." +
					plan +
					" Запусти: `bun ~/omp-mobile/bin/goldfish.ts run --stage result --task <файл с задачей> --material <изменённые пути>` " +
					"(при необходимости `--plan <файл плана>`). Прогон идёт отдельным процессом с чистым контекстом, " +
					"вердикт ложится в журнал; строки «ADVERSARIAL: PASS» в тексте недостаточно. Это единственное напоминание.",
			};
		} catch {
			return undefined; // fail-open: хук не должен ломать работу агента
		}
	});
}
