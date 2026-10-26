import { expect, test } from "bun:test";
import { graphDateLabel, graphFactMeta, graphKindLabel, graphPercent, highlightSegments, shortProject } from "./graph-view";

/** Локальные даты: проверяем формат подписи, а не часовой пояс машины. */
const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const SAME_YEAR = new Date(2026, 9, 26, 5, 0, 0).getTime();
const OTHER_YEAR = new Date(2025, 0, 3, 5, 0, 0).getTime();

test("kind labels are russian and unknown kinds stay visible", () => {
	expect(graphKindLabel("decision")).toBe("решение");
	expect(graphKindLabel("insight")).toBe("причина");
	expect(graphKindLabel("fix")).toBe("исправлено");
	expect(graphKindLabel("rule")).toBe("правило");
	expect(graphKindLabel("error")).toBe("ошибка");
	expect(graphKindLabel("fact")).toBe("факт");
	expect(graphKindLabel("weird")).toBe("weird");
});

test("short project keeps last path segment and survives trailing slash", () => {
	expect(shortProject("/home/vincentfox/omp-mobile")).toBe("omp-mobile");
	expect(shortProject("/home/vincentfox/omp-mobile/")).toBe("omp-mobile");
	expect(shortProject("omp-mobile")).toBe("omp-mobile");
	expect(shortProject("/")).toBe("/");
});

test("highlight splits on matched words, ignoring case", () => {
	const text = "Память графа и память Mnemopi";
	const parts = highlightSegments(text, ["память"]);
	expect(parts.filter(part => part.hit).map(part => part.text.toLowerCase())).toEqual(["память", "память"]);
	expect(parts.map(part => part.text).join("")).toBe(text);
	expect(parts.filter(part => !part.hit).map(part => part.text).join("")).toBe(" графа и  Mnemopi");
});

test("longest term wins over its own prefix", () => {
	const parts = highlightSegments("граф фактов памяти", ["граф", "граф фактов"]);
	expect(parts.map(part => (part.hit ? `[${part.text}]` : part.text)).join("")).toBe("[граф фактов] памяти");
});

test("regex special characters in terms are escaped, text never duplicated", () => {
	const text = "файл a.ts и b.ts";
	const parts = highlightSegments(text, ["a.t"]);
	expect(parts.map(part => part.text).join("")).toBe(text);
	expect(parts.map(part => (part.hit ? `[${part.text}]` : part.text)).join("")).toBe("файл [a.t]s и b.ts");
	expect(highlightSegments("a.t", ["a.t"])).toEqual([{ text: "a.t", hit: true }]);
});

test("empty text and empty terms degrade without marks", () => {
	expect(highlightSegments("", ["x"])).toEqual([]);
	expect(highlightSegments("текст", [])).toEqual([{ text: "текст", hit: false }]);
	expect(highlightSegments("текст", ["  "])).toEqual([{ text: "текст", hit: false }]);
});

test("dates: current year drops it, other year keeps it", () => {
	expect(graphDateLabel(SAME_YEAR, NOW)).toBe("26.10");
	expect(graphDateLabel(OTHER_YEAR, NOW)).toBe("03.01.2025");
	expect(graphDateLabel(0, NOW)).toBe("без даты");
	expect(graphDateLabel(Number.NaN, NOW)).toBe("без даты");
});

test("percent clamps and never prints NaN", () => {
	expect(graphPercent(0.823)).toBe("82%");
	expect(graphPercent(1.4)).toBe("100%");
	expect(graphPercent(-1)).toBe("0%");
	expect(graphPercent(Number.NaN)).toBe("0%");
});

test("fact meta line joins project, date, mentions and confidence", () => {
	expect(graphFactMeta({ project: "/home/vincentfox/omp-mobile", lastSeen: SAME_YEAR, mentions: 7, confidence: 0.9 }, NOW)).toBe(
		"/home/vincentfox/omp-mobile · 26.10 · упоминаний 7 · уверенность 90%",
	);
	expect(graphFactMeta({ project: "", lastSeen: 0, mentions: 0, confidence: 0 }, NOW)).toBe(
		"без проекта · без даты · упоминаний 0 · уверенность 0%",
	);
});
