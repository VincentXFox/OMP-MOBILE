import { describe, expect, test } from "bun:test";
import { parseSubagentRows, previewLines } from "./subagent-view";

function line(event: unknown): string {
	return JSON.stringify(event);
}

describe("parseSubagentRows", () => {
	test("реплики, вызовы и результаты превращаются в строки", () => {
		const raw = [
			line({ type: "title", title: "тест" }),
			line({ type: "message", message: { role: "user", content: [{ type: "text", text: "прочитай файл" }] } }),
			line({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "надо посмотреть файл" },
						{ type: "text", text: "Сейчас посмотрю." },
						{ type: "toolCall", name: "read", arguments: { path: "/etc/hostname", i: "читаю имя" } },
					],
				},
			}),
			line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Thor1" }] } }),
		].join("\n");
		const rows = parseSubagentRows(raw);
		expect(rows.map(row => row.kind)).toEqual(["user", "assistant", "tool", "result"]);
		expect(rows[2]?.name).toBe("read");
		expect(rows[2]?.arg).toBe("/etc/hostname");
		expect(rows[3]?.text).toBe("Thor1");
	});

	test("thinking не попадает в показ, точечные реплики отфильтрованы", () => {
		const raw = [
			line({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "секрет" }] } }),
			line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "." }] } }),
			line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "готово" }] } }),
		].join("\n");
		const rows = parseSubagentRows(raw);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe("готово");
		expect(JSON.stringify(rows)).not.toContain("секрет");
	});

	test("ошибка в результате помечается", () => {
		const raw = line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Error: нет файла" }] } });
		const rows = parseSubagentRows(raw);
		expect(rows[0]?.failed).toBe(true);
	});

	test("не-JSON строки сохраняются как сырой текст", () => {
		const rows = parseSubagentRows("plain line one\nplain line two");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("raw");
		expect(rows[0]?.text).toContain("plain line one");
	});

	test("очень длинный результат обрезается", () => {
		const long = "x".repeat(5000);
		const rows = parseSubagentRows(line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: long }] } }));
		expect((rows[0]?.text ?? "").length).toBeLessThan(1300);
	});

	test("переносы строк в результате сохраняются", () => {
		const multi = ["первая", "вторая", "третья", "четвёртая"].join("\n");
		const rows = parseSubagentRows(line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: multi }] } }));
		expect(rows[0]?.text).toBe(multi);
		const preview = previewLines(rows[0]?.text ?? "", false);
		expect(preview.hidden).toBe(1);
		expect(preview.lines).toEqual(["первая", "вторая", "третья"]);
	});

	test("превью сворачивает длинный результат до трёх строк", () => {
		const text = ["a", "b", "c", "d", "e"].join("\n");
		expect(previewLines(text, false)).toEqual({ lines: ["a", "b", "c"], hidden: 2 });
		expect(previewLines(text, true).hidden).toBe(0);
		expect(previewLines("a\nb", false).hidden).toBe(0);
	});
});
