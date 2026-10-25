import type { ModelCost } from "./gateway";

/** Модели на своей машине токенами не тарифицируются. */
const LOCAL_PROVIDER_RE = /^(big-pc|helper|llama\.cpp)\//;

/** Компактная цена: 0.022 · 0.1 · 1.3 · 13. */
function fmt(value: number): string {
	if (value >= 10) return String(Math.round(value * 10) / 10);
	if (value >= 1) return String(Math.round(value * 100) / 100);
	return String(Math.round(value * 1000) / 1000);
}

/** Положительная цена, округлившаяся в ноль, печатается как «<0.001», а не «0». */
function cheap(value: number): string {
	const text = fmt(value);
	return value > 0 && text === "0" ? "<0.001" : text;
}

/**
 * Подпись цены использования для строки пикера: «0.10/0.42 $ за 1M».
 * Локальные модели честно называем бесплатными, а не «0/0»; неизвестную цену
 * не выдаём за дешёвую — такую строку список и держит в конце.
 */
export function modelPriceLabel(selector: string, cost: ModelCost | null | undefined): string {
	if (LOCAL_PROVIDER_RE.test(selector)) return "бесплатно · локальная";
	if (!cost || !Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return "цена не указана";
	if (cost.input <= 0 && cost.output <= 0) return "цена не указана";
	return `${cheap(cost.input)}/${cheap(cost.output)} $ за 1M`;
}
