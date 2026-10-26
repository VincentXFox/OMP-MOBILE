import { describe, expect, test } from "bun:test";
import { contextBlock, projectRelevance, rankFacts, searchGraph } from "../memory-graph/retrieve.ts";
import { openGraphDb, upsertFact, type GraphFact } from "../memory-graph/store.ts";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function fact(patch: Partial<GraphFact>): GraphFact {
	const base: GraphFact = {
		id: Math.random().toString(16).slice(2),
		kind: "fact",
		fact: "факт",
		norm: "факт",
		src: null,
		dst: null,
		project: "/p/a",
		confidence: 0.7,
		importance: 0.5,
		validFrom: NOW - DAY,
		validTo: null,
		mentions: 1,
		firstSeen: NOW - DAY,
		lastSeen: NOW - DAY,
		sessionId: null,
		quote: null,
	};
	return { ...base, ...patch };
}

describe("ранжирование фактов", () => {
	test("совпадение с запросом весит больше свежести", () => {
		const old = fact({ norm: "туннель релей порт 8789", fact: "Туннель держит релей на 8789", lastSeen: NOW - 40 * DAY, importance: 0.5 });
		const fresh = fact({ norm: "решили поменять шрифт", fact: "Решили поменять шрифт", lastSeen: NOW, importance: 0.5 });
		const ranked = rankFacts([old, fresh], { query: "порт релей туннель", now: NOW, limit: 2 });
		expect(ranked[0]?.fact).toContain("8789");
		expect(ranked[0]?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("пустой запрос: свежие и важные сверху", () => {
		const stale = fact({ fact: "старое", norm: "старое", lastSeen: NOW - 300 * DAY, importance: 0.9 });
		const fresh = fact({ fact: "новое", norm: "новое", lastSeen: NOW, importance: 0.5 });
		const ranked = rankFacts([stale, fresh], { now: NOW, limit: 2 });
		expect(ranked[0]?.fact).toBe("новое");
	});

	test("частое упоминание поднимает факт при равной свежести", () => {
		const once = fact({ fact: "редкое", norm: "редкое", mentions: 1 });
		const many = fact({ fact: "частое", norm: "частое", mentions: 9 });
		const ranked = rankFacts([once, many], { now: NOW, limit: 2 });
		expect(ranked[0]?.fact).toBe("частое");
	});

	test("фильтр по проекту не подмешивает чужие факты", () => {
		const db = openGraphDb(":memory:");
		upsertFact(db, { kind: "decision", fact: "Решили держать релей на 7466", norm: undefined as never, project: "/p/a", confidence: 0.8, importance: 0.8, at: NOW } as never);
		upsertFact(db, { kind: "decision", fact: "Решили держать релей на 7466", project: "/p/b", confidence: 0.8, importance: 0.8, at: NOW });
		expect(searchGraph(db, { project: "/p/a", now: NOW }).length).toBe(1);
		expect(searchGraph(db, { now: NOW }).length).toBe(1); // тот же текст — дедуплицирован
	});

	test("блок контекста уважает лимит символов и формат пунктов", () => {
		const db = openGraphDb(":memory:");
		for (let i = 0; i < 30; i += 1) {
			upsertFact(db, {
				kind: "decision",
				fact: `Решение номер ${i}: держим публичный релей на порту ${8000 + i} и проверяем туннель`,
				project: "/p/a",
				confidence: 0.8,
				importance: 0.8,
				at: NOW,
			});
		}
		const block = contextBlock(db, { project: "/p/a", now: NOW, maxChars: 400 });
		expect(block.length).toBeLessThanOrEqual(400);
		expect(block.split("\n")[0]).toContain("Граф памяти");
		expect(block.split("\n").length).toBeGreaterThan(2);
		expect(block).toContain("- [решение]");
	});

	test("пустой граф — пустой блок, а не заголовок", () => {
		const db = openGraphDb(":memory:");
		expect(contextBlock(db, { project: "/нет", now: NOW })).toBe("");
	});
});

describe("релевантность проекта", () => {
	test("точный каталог, подпроект, родитель и чужой", () => {
		expect(projectRelevance("/home/u/proj", "/home/u/proj")).toBe(1);
		expect(projectRelevance("/home/u/proj/sub", "/home/u/proj")).toBe(0.9);
		expect(projectRelevance("/home/u", "/home/u/proj")).toBe(0.6);
		expect(projectRelevance("/tmp", "/home/u/proj")).toBe(0);
		expect(projectRelevance("/anything", null)).toBe(1);
	});

	test("контекст проекта видит факты родителя, но не чужие", () => {
		const db = openGraphDb(":memory:");
		upsertFact(db, { kind: "decision", fact: "Решили держать релей на порту 7466 в домашнем каталоге", project: "/home/u", confidence: 0.8, importance: 0.8, at: NOW });
		upsertFact(db, { kind: "decision", fact: "Решили держать релей на порту 7466 во временном каталоге", project: "/tmp", confidence: 0.8, importance: 0.8, at: NOW });
		const block = contextBlock(db, { project: "/home/u/proj", now: NOW });
		expect(block).toContain("домашнем");
		expect(block).not.toContain("временном");
	});
});
