import { expect, test } from "bun:test";
import { modelPriceLabel } from "./model-price";

test("цена показывается парой вход/выход за 1M токенов", () => {
	expect(modelPriceLabel("cheaperinference/deepseek-v4.1-flash", { input: 0.1045, output: 0.418 })).toBe("0.105/0.418 $ за 1M");
	expect(modelPriceLabel("cheaperinference/claude-opus-5.5", { input: 2.606421, output: 13.032107 })).toBe("2.61/13 $ за 1M");
	expect(modelPriceLabel("zai/glm-5", { input: 1, output: 3.2 })).toBe("1/3.2 $ за 1M");
});

test("локальная модель названа бесплатной, а не нулевой ценой", () => {
	expect(modelPriceLabel("big-pc/huihui-qwen3.8-27b-vl", null)).toBe("бесплатно · локальная");
	expect(modelPriceLabel("llama.cpp//home/vincentfox/models/x.gguf", { input: 0, output: 0 })).toBe("бесплатно · локальная");
});

test("неизвестная цена честно помечена, а не показана как ноль", () => {
	expect(modelPriceLabel("zai/glm-4.5-flash", null)).toBe("цена не указана");
	expect(modelPriceLabel("zai/glm-4.7-flash", { input: 0, output: 0 })).toBe("цена не указана");
	expect(modelPriceLabel("cheaperinference/x", { input: Number.NaN, output: 1 })).toBe("цена не указана");
});

test("положительная копеечная цена не печатается как ноль", () => {
	expect(modelPriceLabel("cheaperinference/x", { input: 0.0002, output: 0.0004 })).toBe("<0.001/<0.001 $ за 1M");
	expect(modelPriceLabel("cheaperinference/y", { input: 0, output: 0.5 })).toBe("0/0.5 $ за 1M");
});
