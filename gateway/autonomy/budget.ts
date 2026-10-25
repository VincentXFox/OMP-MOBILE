import type { BudgetLimit, Spend } from "./types.ts";

/**
 * Бюджет задачи: токены и деньги.
 *
 * Чего этот модуль НЕ делает: не превращает токены в деньги «на глаз». Цена
 * берётся из конфигурации по модели (config.autonomy.prices), а если её нет —
 * стоимость остаётся null, и это честно показывается в UI. Встроенный
 * token_budget goal-режима не годится как денежный лимит: он не учитывает
 * cache-read и отдельный ход может пересечь границу.
 */

export interface ModelPrice {
  /** $ за 1M входных токенов. */
  inputPerM: number;
  /** $ за 1M выходных токенов. */
  outputPerM: number;
  /** $ за 1M токенов чтения кэша (обычно 10% от входа). */
  cacheReadPerM?: number;
  /** $ за 1M токенов записи кэша. */
  cacheWritePerM?: number;
}

/** Снимок расхода, который отдаёт omp после хода (get_session_stats/usage). */
export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): UsageDelta {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Складывает расход, переживая перезапуски: счётчики только растут. */
export function addUsage(spend: Spend, delta: UsageDelta, price: ModelPrice | null): Spend {
  const next: Spend = {
    inputTokens: spend.inputTokens + Math.max(0, Math.trunc(delta.inputTokens)),
    outputTokens: spend.outputTokens + Math.max(0, Math.trunc(delta.outputTokens)),
    cacheReadTokens: spend.cacheReadTokens + Math.max(0, Math.trunc(delta.cacheReadTokens)),
    cacheWriteTokens: spend.cacheWriteTokens + Math.max(0, Math.trunc(delta.cacheWriteTokens)),
    turns: spend.turns + 1,
    costUsd: spend.costUsd,
  };
  if (price === null) return next;
  const cached = (next.cacheReadTokens * (price.cacheReadPerM ?? price.inputPerM * 0.1)) / 1_000_000;
  const writes = (next.cacheWriteTokens * (price.cacheWritePerM ?? price.inputPerM)) / 1_000_000;
  const fresh = (next.inputTokens * price.inputPerM) / 1_000_000;
  const out = (next.outputTokens * price.outputPerM) / 1_000_000;
  next.costUsd = Math.round((cached + writes + fresh + out) * 1e6) / 1e6;
  return next;
}

export function tokensUsed(spend: Spend): number {
  // Вход, выход и чтение кэша — оплачиваемые токены; запись кэша тоже.
  return spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Сколько осталось до лимита с учётом резерва. */
  freeTokens: number;
  freeUsd: number | null;
  reason: string | null;
}

/**
 * Проверка перед новым запросом к модели.
 * `reserve` тратится только на финальную проверку: пока задача не в фазе
 * `verifying`, резерв недоступен — иначе бюджет кончится ровно перед приёмкой.
 */
export function checkBudget(spend: Spend, limit: BudgetLimit, phase: "work" | "verify"): BudgetVerdict {
  const used = tokensUsed(spend);
  const reserve = phase === "verify" ? 0 : Math.max(0, limit.reserveTokens);
  const freeTokens = Math.max(0, limit.maxTokens - used - reserve);
  const freeUsd = limit.maxCostUsd !== undefined && spend.costUsd !== null ? Math.max(0, limit.maxCostUsd - spend.costUsd) : null;
  if (freeTokens <= 0) {
    return {
      ok: false,
      freeTokens,
      freeUsd,
      reason:
        `Бюджет токенов исчерпан: использовано ${used} из ${limit.maxTokens}` +
        (reserve > 0 ? ` (резерв ${reserve} токенов держится на финальную проверку)` : ""),
    };
  }
  if (freeUsd !== null && freeUsd <= 0) {
    return { ok: false, freeTokens, freeUsd, reason: `Денежный лимит исчерпан: потрачено $${spend.costUsd?.toFixed(4)} из $${limit.maxCostUsd}` };
  }
  return { ok: true, freeTokens, freeUsd, reason: null };
}
