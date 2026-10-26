import { describe, expect, test } from "bun:test";
import { openGraphDb, upsertFact, factId, normalizeFact, graphStats, fileState, markFileIndexed, nodeId } from "../memory-graph/store.ts";

function fresh() {
	return openGraphDb(":memory:");
}

const AT = Date.UTC(2026, 9, 25, 10, 0, 0);

describe("хранилище графа памяти", () => {
	test("повтор факта не плодит строку, а усиливает её", () => {
		const db = fresh();
		const base = { kind: "decision" as const, fact: "Решили держать релей на 7466.", project: "/p/a", confidence: 0.8, importance: 0.8, at: AT };
		expect(upsertFact(db, base)).toBe("inserted");
		expect(upsertFact(db, { ...base, at: AT + 60_000 })).toBe("merged");
		const stats = graphStats(db);
		expect(stats.facts).toBe(1);
		const row = db.query<{ mentions: number; last_seen: number }, []>("SELECT mentions, last_seen FROM facts").get();
		expect(row?.mentions).toBe(2);
		expect(row?.last_seen).toBe(AT + 60_000);
	});

	test("нормализация: регистр, пробелы и хвостовая пунктуация, но не смысл", () => {
		expect(normalizeFact("  Решили: релей на 7466!  ")).toBe("решили: релей на 7466");
		expect(normalizeFact("Правка --restore в main.ts")).toBe("правка --restore в main.ts");
		expect(normalizeFact("A\n\nB")).toBe("a b");
	});

	test("id факта стабилен по нормализованному тексту", () => {
		expect(factId(normalizeFact("Решили X."))).toBe(factId(normalizeFact(" решили x")));
	});

	test("узел получает вид и переживает разные регистры имени", () => {
		expect(nodeId("host", "DE5")).toBe(nodeId("host", "de5"));
		expect(nodeId("host", "de5")).not.toBe(nodeId("service", "de5"));
		const db = fresh();
		upsertFact(db, {
			kind: "fact",
			fact: "de5 держит Caddy на 4430",
			project: "/p/a",
			confidence: 0.5,
			importance: 0.5,
			at: AT,
			src: { kind: "host", name: "de5" },
			dst: { kind: "service", name: "caddy" },
		});
		upsertFact(db, { kind: "fact", fact: "de5 держит Caddy на 4430", project: "/p/a", confidence: 0.5, importance: 0.5, at: AT + 1, src: { kind: "host", name: "DE5" } });
		expect(graphStats(db).nodes).toBe(2);
	});

	test("состояние файла: неизменённый транскрипт не индексируется повторно", () => {
		const db = fresh();
		expect(fileState(db, "/x.jsonl")).toBeNull();
		markFileIndexed(db, "/x.jsonl", 100, 1_700_000_000, AT);
		expect(fileState(db, "/x.jsonl")).toEqual({ size: 100, mtime: 1_700_000_000 });
		markFileIndexed(db, "/x.jsonl", 120, 1_700_000_100, AT + 5);
		expect(fileState(db, "/x.jsonl")).toEqual({ size: 120, mtime: 1_700_000_100 });
	});

	test("статистика считает проекты и виды фактов", () => {
		const db = fresh();
		upsertFact(db, { kind: "decision", fact: "A: решили одно", project: "/p/a", confidence: 0.8, importance: 0.8, at: AT });
		upsertFact(db, { kind: "error", fact: "B: ошибка в шине", project: "/p/b", confidence: 0.6, importance: 0.6, at: AT });
		const stats = graphStats(db);
		expect(stats.facts).toBe(2);
		expect(stats.projects).toBe(2);
		expect(stats.byKind.decision).toBe(1);
		expect(stats.byKind.error).toBe(1);
	});

	test("повтор с более старым временем не откатывает свежесть назад", () => {
		const db = fresh();
		const base = { kind: "fact" as const, fact: "Туннель на de5 держит релей", project: "/p/a", confidence: 0.6, importance: 0.6 };
		upsertFact(db, { ...base, at: AT });
		upsertFact(db, { ...base, at: AT - 86_400_000 });
		const row = db.query<{ first_seen: number; last_seen: number }, []>("SELECT first_seen, last_seen FROM facts").get();
		expect(row?.last_seen).toBe(AT);
		expect(row?.first_seen).toBe(AT - 86_400_000);
	});
});
