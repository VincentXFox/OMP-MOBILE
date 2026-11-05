/**
 * Тесты порта cc-plugin-you-should-know: разбор ответа, дедупликация, частота,
 * рост интервала при игнорировании и компактная выжимка сессии.
 */
import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULTS,
	accept,
	noteBlock,
	noteHash,
	normalizeLearn,
	parseObserver,
	runtimeForScript,
	settleIgnored,
	shouldSuggest,
	shouldTrigger,
	step,
	transcriptBlock,
	type YsnState,
} from "../pre/you-should-know.ts";

function empty(interval = 6): YsnState {
	return { steps: 0, interval, notes: [], pending: [], suggested: 0, ignored: 0, unsettled: 0, lastCheckAt: null };
}

describe("you-should-know", () => {
	test("learn: none — молчание", () => {
		expect(parseObserver("learn: none").learn).toBeNull();
		expect(parseObserver("learn:").learn).toBeNull();
		expect(parseObserver("болтовня без полей").learn).toBeNull();
	});

	test("обычная заметка разбирается на learn/tag/explain", () => {
		const parsed = parseObserver("learn: Индекс стал медленнее после смены схемы\ntag: Heads up\nexplain:\n**Первый пункт**\n- следствие: поиск дольше в 2 раза");
		expect(parsed.learn).toContain("Индекс стал медленнее");
		expect(parsed.tag).toBe("Heads up");
		expect(parsed.explain).toContain("Первый пункт");
	});

	test("тег по умолчанию — You should know", () => {
		expect(parseObserver("learn: что-то важное").tag).toBe("You should know");
	});

	test("нормализация и хеш не зависят от регистра и пунктуации", () => {
		expect(normalizeLearn("Индекс, стал МЕДЛЕННЕЕ!")).toBe(normalizeLearn("индекс стал медленнее"));
		expect(noteHash("Индекс, стал МЕДЛЕННЕЕ!")).toBe(noteHash("индекс стал медленнее"));
	});

	test("одна и та же заметка не повторяется", () => {
		const state = empty();
		const first = accept(state, { learn: "Первый риск в схеме", tag: "Heads up", explain: "" }, DEFAULTS);
		const second = accept(state, { learn: "первый риск в схеме", tag: "Heads up", explain: "" }, DEFAULTS);
		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(state.suggested).toBe(1);
	});

	test("лимит заметок в час соблюдается", () => {
		const state = empty();
		const now = Date.now();
		for (let i = 0; i < DEFAULTS.maxNotesPerHour; i++) {
			expect(accept(state, { learn: `риск номер ${i}`, tag: "Heads up", explain: "" }, DEFAULTS, now)).not.toBeNull();
		}
		expect(shouldSuggest(state, "четвёртый риск", DEFAULTS, now)).toBe(false);
		// через час окно сдвигается
		expect(shouldSuggest(state, "четвёртый риск", DEFAULTS, now + 61 * 60 * 1000)).toBe(true);
	});

	test("порог: срабатывание на каждом N-м шаге", () => {
		const state = empty(3);
		const triggers: number[] = [];
		for (let i = 0; i < 7; i++) if (step(state, DEFAULTS)) triggers.push(state.steps);
		expect(triggers).toEqual([3, 6]);
	});

	test("выключенный наблюдатель не срабатывает", () => {
		const state = empty(1);
		expect(shouldTrigger(state, { ...DEFAULTS, enabled: false })).toBe(false);
	});

	test("игнорирование увеличивает интервал, но не больше 24", () => {
		const state = empty(6);
		// показанная заметка без реакции = unsettled; каждая такая ситуация удваивает интервал
		state.unsettled = 1;
		settleIgnored(state);
		expect(state.interval).toBe(12);
		expect(state.unsettled).toBe(0);
		// повторный вызов без новой показанной заметки ничего не меняет
		settleIgnored(state);
		expect(state.interval).toBe(12);
		state.unsettled = 1;
		settleIgnored(state);
		expect(state.interval).toBe(24);
		state.unsettled = 1;
		settleIgnored(state);
		expect(state.interval).toBe(24);
	});

	test("блок для промпта содержит тег, суть и путь, и предупреждает о внешнем источнике", () => {
		const block = noteBlock({ at: "", learn: "Важная деталь", tag: "Heads up", explain: "", hash: "x", acknowledged: false }, "/tmp/notes.md");
		expect(block).toContain("Heads up: Важная деталь");
		expect(block).toContain("/tmp/notes.md");
		expect(block).toContain("внешнее наблюдение");
	});

	test("выжимка сессии урезается с двух сторон", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `шаг ${i}: ${"x".repeat(40)}`);
		const block = transcriptBlock(lines, 2000);
		expect(block.length).toBeLessThan(2100);
		expect(block).toContain("шаг 0");
		expect(block).toContain("шаг 499");
		expect(block).toContain("…");
	});

	test("раннер запускается интерпретатором, а не бинарём omp", () => {
		// Регрессия 03.11: `omp <скрипт> _tmp /tmp` для omp — это промпт новой сессии,
		// поэтому раннеры размножались. Интерпретатор обязан быть bun/node.
		const runtime = runtimeForScript();
		expect(runtime).not.toBeNull();
		expect(runtime === null ? "" : basename(runtime)).toBe("bun");
	});

	test("несуществующий YSN_RUNTIME не подставляется", () => {
		process.env.YSN_RUNTIME = join(tmpdir(), "нет-такого-интерпретатора");
		expect(runtimeForScript()).toBeNull();
		delete process.env.YSN_RUNTIME;
	});
});
