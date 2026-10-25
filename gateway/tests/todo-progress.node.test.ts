import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todoProgressOf } from "../todo-progress.ts";

function sessionFile(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-todo-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

/** Результат инструмента `todo` в той форме, что пишет omp. */
function todoResult(phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>, at = "2026-10-25T10:00:00.000Z"): unknown {
	return {
		type: "message",
		id: `todo-${Math.random().toString(16).slice(2)}`,
		timestamp: at,
		message: { role: "toolResult", toolName: "todo", details: { op: "update", phases } },
	};
}

describe("прогресс туду-борда для карточки агента", () => {
	test("считает done/total и фазу с текущей задачей", () => {
		const path = sessionFile([
			todoResult([
				{ name: "Старт", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }] },
				{ name: "Работа", tasks: [{ content: "c", status: "in_progress" }, { content: "d", status: "pending" }] },
			]),
		]);
		expect(todoProgressOf(path)).toEqual({ done: 2, total: 4, activePhase: "Работа" });
	});

	test("берёт последний борд, а не первый", () => {
		const path = sessionFile([
			todoResult([{ name: "A", tasks: [{ content: "a", status: "pending" }] }], "2026-10-25T10:00:00.000Z"),
			todoResult([{ name: "A", tasks: [{ content: "a", status: "completed" }] }], "2026-10-25T10:05:00.000Z"),
		]);
		expect(todoProgressOf(path)).toEqual({ done: 1, total: 1, activePhase: null });
	});

	test("понимает старую форму items/text и пропускает abandoned", () => {
		const path = sessionFile([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { phases: [{ name: "Ф", items: [{ text: "раз", status: "completed" }, { text: "два", status: "abandoned" }, { text: "три", status: "in_progress" }] }] },
				},
			},
		]);
		expect(todoProgressOf(path)).toEqual({ done: 1, total: 3, activePhase: "Ф" });
	});

	test("сессия без туду и отсутствующий файл — null", () => {
		const plain = sessionFile([{ type: "message", message: { role: "assistant", content: [] } }]);
		expect(todoProgressOf(plain)).toBeNull();
		expect(todoProgressOf(join(tmpdir(), "нет-такого-файла-omp.jsonl"))).toBeNull();
		expect(todoProgressOf(null)).toBeNull();
	});

	test("перечитывает файл после дописывания, а не отдаёт кеш", () => {
		const path = sessionFile([todoResult([{ name: "A", tasks: [{ content: "a", status: "pending" }] }])]);
		expect(todoProgressOf(path)?.done).toBe(0);
		appendFileSync(
			path,
			`${JSON.stringify(todoResult([{ name: "A", tasks: [{ content: "a", status: "completed" }] }], "2026-10-25T11:00:00.000Z"))}\n`,
		);
		expect(todoProgressOf(path)).toEqual({ done: 1, total: 1, activePhase: null });
	});

	test("битые строки и мусор не ломают разбор", () => {
		const path = sessionFile([todoResult([{ name: "A", tasks: [{ content: "a", status: "completed" }] }])]);
		appendFileSync(path, "{ это не json\n");
		appendFileSync(path, `${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: "нет" } } })}\n`);
		expect(todoProgressOf(path)).toEqual({ done: 1, total: 1, activePhase: null });
	});
});
