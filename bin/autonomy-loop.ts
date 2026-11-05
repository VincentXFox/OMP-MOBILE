/**
 * Управляющий цикл доведения задачи до проверенного результата.
 *
 * Задача живёт в `.omp/task-state.json` (hooks/lib/task-state.ts): окончание ответа
 * исполнителя задачу не закрывает. Цикл:
 *   задача → выполнение → проверка → замечания → исправление → повторная проверка.
 *
 * Правила:
 *  - продолжаем, пока состояние требует работы (open/needs-fix) и не исчерпан бюджет;
 *  - замечания и открытые пункты из состояния уходят в следующий запрос — это и есть
 *    возврат задачи исполнителю с фактическим выводом проверок;
 *  - PARTIAL не закрывает задачу;
 *  - внешний ресурс исчерпан → состояние awaiting-external с условием продолжения,
 *    без изображения фоновой работы;
 *  - отмена владельца (status=cancelled) останавливает цикл немедленно.
 *
 * Использование: bun autonomy-loop.ts <проект> "<цель>" [--max-rounds N] [--model M]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mutateTaskState, readTaskState, requiresWork, type TaskState } from "/home/vincentfox/.omp/agent/hooks/lib/task-state.ts";

const LAUNCHER = "/run/omp-exec-launcher/launch.sock";
const JOURNAL = join(process.env.HOME ?? "", ".omp/agent/harness/autonomy.log");

const args = process.argv.slice(2);
const project = args[0];
const goal = args[1];
const maxRounds = Number(args[args.indexOf("--max-rounds") + 1] || 6);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "cheaperinference/deepseek-v4.1-flash";
if (!project || !goal) {
	console.error("нужны: <проект> \"<цель>\" [--max-rounds N] [--model M]");
	process.exit(2);
}

const log = (line: string): void => {
	const text = `${new Date().toISOString()} ${line}\n`;
	process.stderr.write(text);
	try {
		const prev = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf8") : "";
		require("node:fs").writeFileSync(JOURNAL, prev + text, "utf8");
	} catch {
		// журнал вспомогательный
	}
};

const promptFor = (state: TaskState, round: number): string => {
	const parts = [
		`ЦЕЛЬ ЗАДАЧИ: ${state.goal}`,
		state.criteria.length > 0 ? `КРИТЕРИИ: ${state.criteria.join("; ")}` : "",
		state.open.length > 0 ? `НЕЗАКРЫТЫЕ ПУНКТЫ И ЗАМЕЧАНИЯ ПРОВЕРОК:\n- ${state.open.join("\n- ")}` : "",
		state.findings.length > 0 ? `ФАКТИЧЕСКИЕ ЗАМЕЧАНИЯ: ${state.findings.join(" | ")}` : "",
		round > 1 ? `Это автоматический повтор №${round}: предыдущая попытка не подтверждена. Исправь причины выше и доведи до проверенного результата.` : "",
		"Работай до проверенного результата: исправляй, запускай проверки, доводи до приёмки. PARTIAL не закрывает задачу.",
	];
	return parts.filter((p) => p !== "").join("\n\n");
};

const runOnce = async (state: TaskState, round: number): Promise<number> => {
	const response = await fetch("http://launcher/", {
		method: "POST",
		body: JSON.stringify({ cwd: project, model, prompt: promptFor(state, round) }),
		...(typeof Bun !== "undefined" ? { unix: LAUNCHER } : {}),
	} as RequestInit & { unix?: string });
	const body = (await response.json()) as { ok?: boolean; pid?: number };
	if (body.ok !== true) {
		log(`round=${round} launcher_refused`);
		return 2;
	}
	const pid = body.pid ?? 0;
	log(`round=${round} pid=${pid} started`);
	for (let waited = 0; waited < 900_000; waited += 3000) {
		try {
			process.kill(pid, 0);
		} catch {
			log(`round=${round} pid=${pid} finished`);
			return 0;
		}
		await Bun.sleep(3000);
	}
	log(`round=${round} pid=${pid} timeout`);
	return 3;
};

await mutateTaskState(project, (state) => {
	if (state.goal === "") state.goal = goal;
	if (state.status === "verified") return;
	state.status = "open";
});

let round = 0;
let final: TaskState | null = null;
while (round < maxRounds) {
	round += 1;
	const state = readTaskState(project);
	if (state === null) break;
	if (state.status === "cancelled") {
		log(`stop: задача отменена владельцем`);
		final = state;
		break;
	}
	if (state.status === "verified") {
		log(`stop: приёмка подтверждена (round=${round})`);
		final = state;
		break;
	}
	if (!requiresWork(state)) {
		log(`stop: состояние ${state.status}${state.waitingFor ? ` (ждём: ${state.waitingFor})` : ""}`);
		final = state;
		break;
	}
	await runOnce(state, round);
}

const end = final ?? readTaskState(project);
log(`итог: статус=${end?.status ?? "нет"} попыток=${end?.attempts ?? 0} раундов=${round}`);
console.log(JSON.stringify({ status: end?.status ?? null, attempts: end?.attempts ?? 0, rounds: round, waitingFor: end?.waitingFor ?? null }, null, 1));
