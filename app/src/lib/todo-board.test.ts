import { expect, test } from "bun:test";
import { todoBoardFromEntries } from "./todo-board";
import type { SessionEntry } from "@oh-my-pi/pi-wire";

/** Запись транскрипта с результатом инструмента `todo` — как её присылает хаб. */
function todoEntry(phases: unknown, toolName = "todo"): unknown {
	return {
		type: "message",
		id: `m-${Math.random().toString(16).slice(2)}`,
		message: { role: "toolResult", toolName, details: { op: "update", phases } },
	};
}

function entries(...items: unknown[]): SessionEntry[] {
	return items as SessionEntry[];
}

test("борд собирается из формы tasks и считает прогресс", () => {
	const board = todoBoardFromEntries(
		entries(
			todoEntry([
				{ name: "Разведка", tasks: [{ content: "прочитать каталог", status: "completed" }] },
				{ name: "Работа", tasks: [{ content: "собрать yml", status: "in_progress" }, { content: "проверить", status: "pending" }] },
			]),
		),
	);
	if (board === null) throw new Error("борд не собран");
	expect(board.done).toBe(1);
	expect(board.total).toBe(3);
	expect(board.activePhase).toBe("Работа");
	expect(board.phases[1]?.tasks[0]?.status).toBe("in_progress");
});

test("форма items (другая версия инструмента) не даёт пустой борд", () => {
	const board = todoBoardFromEntries(entries(todoEntry([{ name: "Фаза", items: [{ text: "шаг", status: "completed" }, { text: "шаг 2", status: "pending" }] }])));
	if (board === null) throw new Error("борд не собран");
	expect(board.total).toBe(2);
	expect(board.done).toBe(1);
	expect(board.phases[0]?.tasks.map((t) => t.content)).toEqual(["шаг", "шаг 2"]);
});

test("побеждает последний борд транскрипта, а не первый", () => {
	const board = todoBoardFromEntries(
		entries(
			todoEntry([{ name: "Старая", tasks: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] }]),
			todoEntry([{ name: "Новая", tasks: [{ content: "a", status: "completed" }] }]),
		),
	);
	if (board === null) throw new Error("борд не собран");
	expect(board.total).toBe(1);
	expect(board.done).toBe(1);
	expect(board.phases[0]?.name).toBe("Новая");
});

test("abandoned не считается сделанным и не тянет активную фазу", () => {
	const board = todoBoardFromEntries(
		entries(todoEntry([{ name: "Ф", tasks: [{ content: "a", status: "abandoned" }, { content: "b", status: "completed" }] }])),
	);
	if (board === null) throw new Error("борд не собран");
	expect(board.done).toBe(1);
	expect(board.total).toBe(2);
	expect(board.activePhase).toBeNull();
});

test("без вызова todo или без details борд отсутствует", () => {
	expect(todoBoardFromEntries(entries(todoEntry([], "bash")))).toBeNull();
	expect(todoBoardFromEntries(entries({ type: "message", id: "x", message: { role: "toolResult", toolName: "todo" } }))).toBeNull();
	expect(todoBoardFromEntries(entries(todoEntry([{ name: "пусто", tasks: [] }])))).toBeNull();
	expect(todoBoardFromEntries([])).toBeNull();
});

test("пустой tasks не прячет непустой items", () => {
	const board = todoBoardFromEntries(entries(todoEntry([{ name: "Ф", tasks: [], items: [{ text: "шаг", status: "completed" }] }])));
	if (board === null) throw new Error("борд не собран");
	expect(board.total).toBe(1);
	expect(board.done).toBe(1);
	expect(board.phases[0]?.tasks[0]?.content).toBe("шаг");
});
