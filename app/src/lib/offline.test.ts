import { afterEach, describe, expect, test } from "bun:test";
import { __setBackend, cachedJson, cachedJsonMeta, memoryStoreForTests, queuePrompt, queuedCount, readCached, staleMark, takeQueuedPrompts } from "./offline";

afterEach(() => {
	__setBackend(memoryStoreForTests());
});

describe("кэш ответов шлюза", () => {
	test("удачный ответ отдаётся свежим и ложится в кэш", async () => {
		__setBackend(memoryStoreForTests());
		const first = await cachedJson("sessions", async () => ({ sessions: [1, 2] }));
		expect(first.at).toBeNull();
		expect(first.value).toEqual({ sessions: [1, 2] });
		const cached = await readCached<{ sessions: number[] }>("sessions");
		expect(cached?.body).toEqual({ sessions: [1, 2] });
	});

	test("сеть упала — возвращается последняя копия с временем получения", async () => {
		__setBackend(memoryStoreForTests());
		await cachedJson("sessions", async () => ({ sessions: ["a"] }));
		const before = Date.now();
		const stale = await cachedJson<{ sessions: string[] }>("sessions", async () => {
			throw new Error("network down");
		});
		expect(stale.value).toEqual({ sessions: ["a"] });
		expect(stale.at).not.toBeNull();
		expect(stale.at as number).toBeLessThanOrEqual(before);
	});

	test("сеть упала и кэша нет — пробрасывается исходная ошибка", async () => {
		__setBackend(memoryStoreForTests());
		await expect(
			cachedJson("sessions", async () => {
				throw new Error("туннель молчит");
			}),
		).rejects.toThrow("туннель молчит");
	});

	test("тяжёлый ответ в кэш не кладётся", async () => {
		__setBackend(memoryStoreForTests());
		const heavy = { text: "x".repeat(2_000_000) };
		await cachedJson("tail", async () => heavy);
		expect(await readCached("tail")).toBeNull();
	});

	test("свежий ответ перекрывает старую копию", async () => {
		__setBackend(memoryStoreForTests());
		await cachedJson<{ sessions: string[] }>("sessions", async () => ({ sessions: ["old"] }));
		await cachedJson<{ sessions: string[] }>("sessions", async () => ({ sessions: ["new"] }));
		const stale = await cachedJson<{ sessions: string[] }>("sessions", async () => {
			throw new Error("down");
		});
		expect(stale.value).toEqual({ sessions: ["new"] });
	});
});

describe("копия из кэша service worker", () => {
	test("время копии приходит из заголовка и видно оболочке", async () => {
		__setBackend(memoryStoreForTests());
		const at = Date.now() - 60_000;
		const result = await cachedJsonMeta<{ sessions: string[] }>("sessions", async () => ({ value: { sessions: ["sw"] }, staleAt: at }));
		expect(result.at).toBe(at);
		expect(staleMark("sessions")).toBe(at);
	});

	test("копия из service worker не подменяет время своей копии в браузере", async () => {
		__setBackend(memoryStoreForTests());
		await cachedJson("sessions", async () => ({ sessions: ["fresh"] }));
		const cachedAt = (await readCached<{ sessions: string[] }>("sessions"))?.at ?? 0;
		await cachedJsonMeta<{ sessions: string[] }>("sessions", async () => ({ value: { sessions: ["sw"] }, staleAt: cachedAt - 5000 }));
		expect((await readCached<{ sessions: string[] }>("sessions"))?.at).toBe(cachedAt);
	});

	test("свежий ответ снимает отметку копии", async () => {
		__setBackend(memoryStoreForTests());
		const at = Date.now() - 1000;
		await cachedJsonMeta<{ sessions: string[] }>("sessions", async () => ({ value: { sessions: ["sw"] }, staleAt: at }));
		await cachedJson<{ sessions: string[] }>("sessions", async () => ({ sessions: ["fresh"] }));
		expect(staleMark("sessions")).toBeNull();
	});
});

describe("очередь промптов без связи", () => {
	test("накопленное отдаётся в порядке набора и очищается", async () => {
		__setBackend(memoryStoreForTests());
		await queuePrompt("agent-1", "первый");
		await queuePrompt("agent-1", "второй");
		await queuePrompt("agent-2", "чужой");
		expect(await queuedCount("agent-1")).toBe(2);
		const mine = await takeQueuedPrompts("agent-1");
		expect(mine.map(item => item.text)).toEqual(["первый", "второй"]);
		expect(await queuedCount("agent-1")).toBe(0);
		expect((await takeQueuedPrompts("agent-2")).map(item => item.text)).toEqual(["чужой"]);
	});
});
