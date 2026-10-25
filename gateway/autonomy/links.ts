import type { UsageDelta } from "./budget.ts";
import type { Task } from "./types.ts";

/**
 * Контракт связи с моделью. Контроллер не знает, как именно он говорит с omp:
 * в продакшене это RPC-процесс, в тестах — сценарный двойник. Поэтому весь
 * управляющий цикл проверяется без модели и без сети.
 */

export interface TurnOutcome {
  /** Чем закончился ход. `error` — провайдер/транспорт, а не «модель передумала». */
  status: "completed" | "error" | "aborted";
  /** Финальный текст ассистента этого хода (для отчёта и выжимки). */
  text: string;
  /** Расход именно этого хода (дельта, не накопленный). */
  usage: UsageDelta;
  /** Упавшие вызовы инструментов: нужны для «смени стратегию». */
  toolFailures: string[];
  /** Стоимость хода в долларах, как её посчитал omp (`get_session_stats.cost`).
   *  undefined — провайдер/рантайм не дал цены: бюджет тогда только по токенам. */
  costUsd?: number;
  error?: string;
}

/** Запрос разрешения на действие (approval), который контроллер паркует до решения. */
export interface ApprovalRequest {
  id: string;
  title: string;
  detail: string;
}

export interface AgentLink {
  /** Один ход: промпт → финальный ответ. Не бросает — ошибки в TurnOutcome. */
  prompt(text: string, opts?: { signal?: AbortSignal }): Promise<TurnOutcome>;
  abort(): Promise<void>;
  /** Ответ на approval; неизвестный id — no-op. */
  answerApproval(id: string, decision: "allow" | "deny"): Promise<void>;
  onApproval(cb: (req: ApprovalRequest) => void): void;
  close(): Promise<void>;
}

/** Фабрика связи на задачу: у каждой задачи своя сессия и свой процесс. */
export type LinkFactory = (task: Task) => Promise<AgentLink>;

/**
 * Сценарный двойник для тестов: заранее заданные ответы ходов и события approval.
 * Никакой сети и модели — контракт цикла проверяется детерминированно.
 */
export class ScriptedLink implements AgentLink {
  #turns: TurnOutcome[] = [];
  #approvals: ApprovalRequest[] = [];
  #approvalHandler: ((req: ApprovalRequest) => void) | null = null;
  #answered: { id: string; decision: "allow" | "deny" }[] = [];
  #prompts: string[] = [];
  #aborts = 0;
  #closed = false;

  /** Добавить ход (в порядке вызовов prompt). */
  pushTurn(outcome: Partial<TurnOutcome> & Pick<TurnOutcome, "text">): this {
    this.#turns.push({
      status: outcome.status ?? "completed",
      text: outcome.text,
      usage: outcome.usage ?? { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolFailures: outcome.toolFailures ?? [],
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    return this;
  }

  /** Выдать запрос разрешения (он придёт в onApproval после следующего prompt). */
  pushApproval(req: ApprovalRequest): this {
    this.#approvals.push(req);
    return this;
  }

  get prompts(): readonly string[] {
    return this.#prompts;
  }

  get answered(): readonly { id: string; decision: "allow" | "deny" }[] {
    return this.#answered;
  }

  get aborts(): number {
    return this.#aborts;
  }

  get closed(): boolean {
    return this.#closed;
  }

  prompt(text: string): Promise<TurnOutcome> {
    this.#prompts.push(text);
    const next = this.#approvals.shift();
    if (next !== undefined) queueMicrotask(() => this.#approvalHandler?.(next));
    const outcome = this.#turns.shift();
    if (outcome !== undefined) return Promise.resolve(outcome);
    return Promise.resolve({
      status: "completed",
      text: "ok",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      toolFailures: [],
    });
  }

  abort(): Promise<void> {
    this.#aborts += 1;
    return Promise.resolve();
  }

  answerApproval(id: string, decision: "allow" | "deny"): Promise<void> {
    this.#answered.push({ id, decision });
    return Promise.resolve();
  }

  onApproval(cb: (req: ApprovalRequest) => void): void {
    this.#approvalHandler = cb;
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
