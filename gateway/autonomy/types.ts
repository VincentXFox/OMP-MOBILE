/**
 * Автономная задача: цель, критерии, попытки, расход, статусы.
 *
 * Модель данных намеренно плоская и сериализуемая: состояние переживает рестарт
 * шлюза и закрытие телефона, поэтому всё, что нужно для продолжения, лежит здесь,
 * а не в памяти процесса.
 */

/** Терминальные и промежуточные состояния задачи. Успех — только `done`. */
export type TaskStatus =
  | "queued" // создана, цикл ещё не поднялся
  | "running" // модель работает
  | "verifying" // идут проверки приёмки
  | "awaiting_approval" // действие требует разрешения пользователя
  | "paused" // пауза пользователем
  | "blocked" // нужен внешний шаг/доступ, продолжать нельзя
  | "budget_exhausted" // исчерпан бюджет токенов/денег
  | "no_progress" // несколько стратегий без результата
  | "cancelled" // отменена пользователем
  | "failed" // ошибка транспорта/непоправимый сбой
  | "done"; // все критерии подтверждены проверками

/** Почему задача остановилась: показывается в UI и в отчёте. */
export type StopReason =
  | { kind: "done"; detail: string }
  | { kind: "budget"; detail: string }
  | { kind: "no_progress"; detail: string }
  | { kind: "blocked"; detail: string }
  | { kind: "cancelled"; detail: string }
  | { kind: "failed"; detail: string };

/** Критерий приёмки: сохраняется ДО первого действия и модель его не меняет. */
export interface Criterion {
  id: string;
  /** Что должно быть истинно (человеческим языком). */
  statement: string;
  /** Машинная проверка: команда и ожидаемый результат. */
  check?: CheckSpec;
  /** Прошёл ли критерий проверку (обновляется только раннером проверок). */
  passed: boolean;
  /** Критерий выведен контроллером из цели (плановый ход), а не задан автором задачи. */
  derived?: boolean;
  /** Последний наблюдаемый результат проверки. */
  lastResult?: string;
  checkedAt?: number;
}

/** Проверка = команда в рабочем каталоге задачи + правило успеха. */
export interface CheckSpec {
  command: string;
  /** Ожидаемый код выхода, по умолчанию 0. */
  expectExit?: number;
  /** Подстрока, которая обязана быть в выводе (stdout+stderr). */
  expectContains?: string;
  /** Подстрока, которой быть не должно. */
  expectAbsent?: string;
  /** Таймаут, по умолчанию 120 с. */
  timeoutMs?: number;
}

/** Одна запись журнала доказательств: что запускали и что получили. */
export interface Evidence {
  at: number;
  criterionId: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** Хвост вывода для человека (не полный лог). */
  output: string;
  durationMs: number;
}

/** Попытка решения: чем закончилась и что изменилось. */
export interface Attempt {
  index: number;
  startedAt: number;
  finishedAt?: number;
  /** Какая стратегия применялась (метка, её назначает контроллер). */
  strategy: string;
  /** Что агент заявил/сделал за ход (краткая выжимка). */
  summary: string;
  /** Признак реального прогресса: закрытый критерий или новое подтверждение. */
  progress: boolean;
  /** Ошибки проверок, найденные после хода. */
  failures: string[];
}

/** Расход по данным провайдера. Деньги считаются по таблице цен, не угадываются. */
export interface Spend {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Оценка в долларах по конфигу цен; null — цены для модели не заданы. */
  costUsd: number | null;
  /** Сколько ходов оплачено (для UI). */
  turns: number;
}

export interface BudgetLimit {
  /** Максимум токенов (вход+выход) на задачу. */
  maxTokens: number;
  /** Максимум денег, если цены заданы. */
  maxCostUsd?: number;
  /** Резерв токенов, который нельзя тратить до финальной проверки. */
  reserveTokens: number;
}

/** Действие, которое могло иметь побочный эффект: нужно для идемпотентности. */
export interface PendingAction {
  at: number;
  kind: "prompt" | "check";
  /** Текст промпта или команда проверки — чтобы понять, что именно выполнялось. */
  detail: string;
  /** Сколько раз это действие уже отправлялось. */
  attempts: number;
}

export interface Task {
  id: string;
  /** Исходная цель пользователя, дословно. */
  goal: string;
  /** Рабочий каталог задачи. */
  cwd: string;
  model: string;
  status: TaskStatus;
  stopReason: StopReason | null;
  createdAt: number;
  updatedAt: number;
  /** Критерии приёмки, зафиксированные до старта. */
  criteria: Criterion[];
  /** Текущий этап для UI (человеческое название). */
  stage: string;
  /** Последний ПОДТВЕРЖДЁННЫЙ проверкой результат (не слова модели). */
  lastVerifiedResult: string | null;
  attempts: Attempt[];
  evidence: Evidence[];
  spend: Spend;
  budget: BudgetLimit;
  /** Стратегии, уже испробованные без прогресса (для no_progress). */
  strategiesTried: string[];
  /** Сколько подряд ходов без прогресса. */
  noProgressStreak: number;
  pendingAction: PendingAction | null;
  /** Запрос разрешения, если статус awaiting_approval. */
  approval: {
    requestId: string;
    title: string;
    detail: string;
    requestedAt: number;
    /** Ответ пользователя, когда придёт. */
    decision: "allow" | "deny" | null;
  } | null;
  /** Команды, которые разрешено выполнять без спроса (пути/шаблоны). */
  autoApprove: string[];
  /** Сколько раз модель звали; защита от неограниченного цикла. */
  turns: number;
  /** Доп. контекст, который контроллер передаёт агенту в следующем промпте. */
  nextInstruction: string | null;
}

export const TERMINAL: readonly TaskStatus[] = [
  "done",
  "cancelled",
  "failed",
  "no_progress",
  "budget_exhausted",
  "blocked",
];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

/** Модель не может отменить критерий: набор фиксируется при создании. */
export function emptySpend(): Spend {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
}
