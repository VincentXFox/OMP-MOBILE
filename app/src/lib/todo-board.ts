import type { SessionEntry } from "@oh-my-pi/pi-wire";

/** Самый свежий туду-борд сессии — всегда перед глазами пользователя. */

export type TodoTaskStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
	content: string;
	status: TodoTaskStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoBoard {
	phases: TodoPhase[];
	done: number;
	total: number;
	/** Фаза с текущей задачей, иначе первая с незакрытыми задачами, иначе null. */
	activePhase: string | null;
}

function taskStatusOf(value: unknown): TodoTaskStatus {
	return value === "completed" || value === "in_progress" || value === "abandoned" ? value : "pending";
}

function boardFromPhases(raw: readonly unknown[]): TodoBoard {
	const phases: TodoPhase[] = [];
	let done = 0;
	let total = 0;
	let activePhase: string | null = null;
	let fallbackPhase: string | null = null;
	for (const phaseRaw of raw) {
		if (phaseRaw === null || typeof phaseRaw !== "object") continue;
		const phaseName = "name" in phaseRaw && typeof phaseRaw.name === "string" ? phaseRaw.name : "";
		const tasks: TodoTask[] = [];
		// Форма борда менялась между версиями инструмента: `tasks` и `items`.
		// Читаем обе, иначе борд в чате молча пустеет, пока счётчик на карточке
		// (шлюз, gateway/todo-progress.ts) продолжает считать.
		const tasksField = (phaseRaw as Record<string, unknown>).tasks;
		const itemsField = (phaseRaw as Record<string, unknown>).items;
		// Пустой `tasks` не должен прятать непустой `items`: версии инструмента
		// кладут задачи то в одно поле, то в другое.
		const rawTasks =
			Array.isArray(tasksField) && tasksField.length > 0
				? (tasksField as unknown[])
				: Array.isArray(itemsField) && itemsField.length > 0
					? (itemsField as unknown[])
					: Array.isArray(tasksField)
						? (tasksField as unknown[])
						: Array.isArray(itemsField)
							? (itemsField as unknown[])
							: null;
		if (rawTasks !== null) {
			for (const taskRaw of rawTasks) {
				if (taskRaw === null || typeof taskRaw !== "object") continue;
				const content = "content" in taskRaw && typeof taskRaw.content === "string" ? taskRaw.content : "text" in taskRaw && typeof taskRaw.text === "string" ? taskRaw.text : "";
				if (content.length === 0) continue;
				const status = taskStatusOf("status" in taskRaw ? taskRaw.status : undefined);
				tasks.push({ content, status });
				total++;
				if (status === "completed") done++;
				if (status === "in_progress" && activePhase === null) activePhase = phaseName;
				if ((status === "pending" || status === "in_progress") && fallbackPhase === null) fallbackPhase = phaseName;
			}
		}
		phases.push({ name: phaseName, tasks });
	}
	return { phases, done, total, activePhase: activePhase ?? fallbackPhase };
}

/**
 * Replay the transcript backwards: the LAST `todo` tool result carries the
 * resulting board (its details.phases), so no op-by-op replay is needed.
 * Sessions without any todo call → null.
 */
export function todoBoardFromEntries(entries: readonly SessionEntry[]): TodoBoard | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry: unknown = entries[i];
		if (entry === null || typeof entry !== "object" || !("type" in entry) || entry.type !== "message") continue;
		if (!("message" in entry)) continue;
		const message: unknown = entry.message;
		if (message === null || typeof message !== "object") continue;
		if (!("role" in message) || message.role !== "toolResult") continue;
		if (!("toolName" in message) || message.toolName !== "todo") continue;
		const details = "details" in message ? message.details : undefined;
		if (details === null || typeof details !== "object" || !("phases" in details) || !Array.isArray(details.phases)) continue;
		const board = boardFromPhases(details.phases);
		return board.total > 0 ? board : null;
	}
	return null;
}
