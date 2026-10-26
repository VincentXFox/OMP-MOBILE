import { describe, expect, test } from "bun:test";
import { extractClaims, extractEntities, extractFromTranscript, messageText, splitClaims } from "../memory-graph/extract.ts";

const CTX = { project: "/home/vincentfox/omp-mobile", sessionId: "s-1" };

describe("экстракция фактов", () => {
	test("решение с сущностями становится фактом", () => {
		const facts = extractClaims("Решили: публичный релей держим на порту 8789 через туннель de5.", CTX);
		expect(facts).toHaveLength(1);
		expect(facts[0]?.kind).toBe("decision");
		expect(facts[0]?.confidence).toBeGreaterThan(0.7);
		expect(facts[0]?.src).not.toBeNull();
		expect(facts[0]?.sessionId).toBe("s-1");
	});

	test("причина и исправление дают разные виды", () => {
		expect(extractClaims("Причина была в том, что Caddy отдавал Alt-Svc на h3 порт 4430.", CTX)[0]?.kind).toBe("insight");
		expect(extractClaims("Починил парсер борда в todo-board.ts, проверено на живых сессиях.", CTX)[0]?.kind).toBe("fix");
		expect(extractClaims("Нельзя коммитить gateway/config.json в репозиторий.", CTX)[0]?.kind).toBe("rule");
		expect(extractClaims("Шлюз падает с exit code 1 после правки panes.ts.", CTX)[0]?.kind).toBe("error");
	});

	test("без маркера смысла фактов нет, даже если текст длинный и с сущностями", () => {
		expect(extractClaims("Открыл файл gateway/main.ts и посмотрел маршруты /api/models и /api/hosts.", CTX)).toHaveLength(0);
	});

	test("код, таблицы и диффы не попадают в граф", () => {
		expect(extractClaims("Решили: `const x = foo(); if (x) { return 1; }` — итог работы в main.ts", CTX).filter((f) => f.fact.includes("const x"))).toHaveLength(0);
		expect(extractClaims("| решили | Caddy | 4430 |", CTX)).toHaveLength(0);
		expect(extractClaims("diff --git a/main.ts b/main.ts — исправил маршрут", CTX)).toHaveLength(0);
	});

	test("обрывки строк короче порога отбрасываются", () => {
		expect(extractClaims("Исправил de5.", CTX)).toHaveLength(0);
	});

	test("одна и та же фраза дважды в тексте даёт один факт", () => {
		const line = "Решили: граф памяти живёт в SQLite рядом с состоянием шлюза.";
		expect(extractClaims(`${line}\n${line}`, CTX)).toHaveLength(1);
	});

	test("сущности: пути, юниты, хосты, инструменты, проект", () => {
		const entities = extractEntities("Правка в gateway/files.ts и ~/omp-mobile/app, деплой omp-pocket-tunnel.service на de5", CTX.project);
		const kinds = new Set(entities.map((e) => e.kind));
		expect(kinds.has("path")).toBe(true);
		expect(kinds.has("service")).toBe(true);
		expect(kinds.has("host")).toBe(true);
		expect(kinds.has("tool")).toBe(true);
	});

	test("деление на утверждения: строки списка и концы предложений", () => {
		const claims = splitClaims("- Первое решение. Второе решение!\nИтог: третье.");
		expect(claims).toEqual(["Первое решение.", "Второе решение!", "Итог: третье."]);
	});

	test("текст реплики: строка и массив блоков; toolResult не реплика", () => {
		expect(messageText({ message: { role: "assistant", content: "просто текст" } })).toBe("просто текст");
		expect(messageText({ message: { role: "user", content: [{ type: "text", text: "а" }, { type: "image", url: "x" }, { type: "text", text: "б" }] } })).toBe("а\nб");
		expect(messageText({ message: { role: "toolResult", content: [{ type: "text", text: "вывод" }] } })).toBeNull();
		expect(messageText({ type: "custom" })).toBeNull();
	});

	test("транскрипт: битые строки не роняют разбор", () => {
		const lines = [
			"{\"type\":\"session\",\"cwd\":\"/p\"}",
			"не json",
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Решили: граф памяти хранится в SQLite и обновляется инкрементально." }] } }),
		];
		const facts = extractFromTranscript(lines, { project: "/p", sessionId: "s" });
		expect(facts).toHaveLength(1);
		expect(facts[0]?.fact).toContain("SQLite");
	});
});
