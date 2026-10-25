import { describe, expect, test } from "bun:test";
import { orderByUsagePrice, usagePriceWeight, type AgentModelOption } from "../files.ts";

function model(selector: string, input: number | null, output: number | null, pricingStatus = "fixed"): AgentModelOption {
	return {
		selector,
		name: selector,
		thinking: [],
		contextWindow: 0,
		cost: input === null || output === null ? null : { input, output },
		pricingStatus,
	};
}

describe("порядок моделей по цене использования", () => {
	test("дешёвые сверху, дорогие снизу", () => {
		const ordered = orderByUsagePrice([
			model("cheaperinference/claude-opus-5.5", 2.6, 13),
			model("cheaperinference/qwen3.7-flash", 0.022, 0.096),
			model("cheaperinference/deepseek-v4.1-flash", 0.1, 0.4),
		]);
		expect(ordered.map((m) => m.selector)).toEqual([
			"cheaperinference/qwen3.7-flash",
			"cheaperinference/deepseek-v4.1-flash",
			"cheaperinference/claude-opus-5.5",
		]);
	});

	test("локальные модели бесплатны и стоят первыми", () => {
		expect(usagePriceWeight(model("big-pc/huihui-qwen3.8-27b-vl", null, null))).toBe(0);
		expect(usagePriceWeight(model("llama.cpp//home/vincentfox/models/x.gguf", 0, 0))).toBe(0);
		const ordered = orderByUsagePrice([model("cheaperinference/gpt-5.6-luna", 0.08, 0.48), model("helper/qwen3-vl-4b", null, null)]);
		expect(ordered[0]?.selector).toBe("helper/qwen3-vl-4b");
	});

	test("неизвестная цена не выдаётся за дешёвую и уходит в конец", () => {
		expect(usagePriceWeight(model("zai/glm-4.5-flash", null, null, "unknown"))).toBe(Number.POSITIVE_INFINITY);
		expect(usagePriceWeight(model("zai/glm-4.7-flash", 0, 0, "unknown"))).toBe(Number.POSITIVE_INFINITY);
		const ordered = orderByUsagePrice([model("zai/glm-4.5-flash", null, null, "unknown"), model("cheaperinference/grok-4.7", 1.3, 3.9)]);
		expect(ordered.map((m) => m.selector)).toEqual(["cheaperinference/grok-4.7", "zai/glm-4.5-flash"]);
	});

	test("равная цена — стабильный порядок по имени", () => {
		const ordered = orderByUsagePrice([model("zai/glm-5.1", 1.4, 4.4), model("zai/glm-5", 1, 3.2), model("zai/glm-5.2", 1.4, 4.4)]);
		expect(ordered.map((m) => m.selector)).toEqual(["zai/glm-5", "zai/glm-5.1", "zai/glm-5.2"]);
	});

	test("объявленная бесплатной модель стоит вместе с локальными", () => {
		expect(usagePriceWeight({ selector: "someone/promo", cost: null, pricingStatus: "free" })).toBe(0);
		const ordered = orderByUsagePrice([model("cheaperinference/grok-4.7", 1.3, 3.9), { selector: "someone/promo", name: "Promo", thinking: [], contextWindow: 0, cost: null, pricingStatus: "free" }]);
		expect(ordered[0]?.selector).toBe("someone/promo");
	});
});
