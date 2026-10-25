import { randomUUID } from "node:crypto";
import { addUsage, checkBudget, emptyUsage } from "./budget.ts";
import { failuresToInstruction, verify } from "./checks.ts";
import type { AgentLink, ApprovalRequest, LinkFactory, TurnOutcome } from "./links.ts";
import type { TaskStore } from "./store.ts";
import type {
  Attempt,
  BudgetLimit,
  Criterion,
  StopReason,
  Task,
  TaskStatus,
} from "./types.ts";
import { emptySpend, isTerminal } from "./types.ts";

/**
 * Управляющий цикл автономной задачи.
 *
 * Кто здесь что решает: модель делает ходы, но не решает «готово или нет» —
 * это решают проверки критериев и бюджет. Контроллер держит инварианты:
 *
 * - критерии фиксируются до первого действия и меняются только раннером проверок;
 * - задача завершается только `done` по ПОЛНОМУ прогону, а не по словам модели;
 * - бюджет тратится по данным провайдера и не даёт бесконечный цикл;
 * - сам ход пишется в `pendingAction` до отправки: после рестарта видно, что
 *   действие могло уйти, и повторять его вслепую нельзя;
 * - «ничего не выходит» — это не повод долбить одно и то же: после порога ходов
 *   без прогресса агент обязан сменить стратегию, а после исчерпания смен —
 *   задача честно останавливается в `no_progress`.
 *
 * Цикл однопоточный на задачу: `start` идемпотентен, а все переходы состояния
 * сохраняются в store ДО следующего шага, поэтому рестарт шлюза ничего не теряет.
 */

const DEFAULT_NO_PROGRESS = 3;
const DEFAULT_STRATEGIES = 2;
/** Сколько символов текста модели держим в журнале попыток (полный текст — в транскрипте). */
const SUMMARY_LIMIT = 600;

export interface ControllerDeps {
  store: TaskStore;
  linkFactory: LinkFactory;
  now?: () => number;
  /** Порог безрезультатных ходов до смены стратегии (по умолчанию 3). */
  noProgressThreshold?: number;
  /** Сколько новых стратегий пробуем после порога (по умолчанию 2). */
  strategiesBeforeStop?: number;
}

/** Чтение статуса через функцию: TypeScript иначе «запоминает» сужение после
 *  присваивания `task.status = "running"` и считает сравнение с другим статусом
 *  невозможным (TS2367), хотя статус меняется в других ветках. */
function statusOf(task: Task): TaskStatus {
  return task.status;
}

export interface CreateTaskInput {
  goal: string;
  cwd: string;
  model: string;
  criteria: Criterion[];
  budget: BudgetLimit;
  autoApprove?: string[];
}

export class TaskController {
  readonly #store: TaskStore;
  /** Подписчики на каждое сохранённое состояние: UI и тесты ждут события, а не таймеры. */
  readonly #listeners = new Set<(task: Task) => void>();
  readonly #linkFactory: LinkFactory;
  readonly #clock: () => number;
  readonly #threshold: number;
  readonly #strategiesBeforeStop: number;

  /** Живые циклы: один на задачу, повторный `start` — no-op. */
  readonly #loops = new Map<string, Promise<void>>();
  readonly #links = new Map<string, AgentLink>();
  readonly #signals = new Map<string, AbortController>();
  /** Ожидания: пауза и решение по approval. Разбужены ровно один раз. */
  readonly #wakeWaits = new Map<string, { promise: Promise<void>; release: () => void }>();
  readonly #approvalWaits = new Map<string, { promise: Promise<void>; release: () => void }>();
  /** Отмена необратима: после неё ни один переход не может «оживить» задачу. */
  readonly #cancelled = new Set<string>();
  /** Счётчик повторов одного и того же промпта — аудит идемпотентности. */
  readonly #promptCounts = new Map<string, number>();

  /** Подписка на переходы: колл-бэк вызывается после каждой успешной записи. */
  onUpdate(cb: (task: Task) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /** Ожидание состояния без опроса и sleep-ов: резолвится по событию store. */
  waitFor(id: string, predicate: (task: Task) => boolean, timeoutMs = 30_000): Promise<Task | null> {
    const current = this.get(id);
    if (current !== null && predicate(current)) return Promise.resolve(current);
    const { promise, resolve } = Promise.withResolvers<Task | null>();
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(this.get(id));
    }, timeoutMs);
    const unsubscribe = this.onUpdate((task) => {
      if (task.id !== id || !predicate(task)) return;
      unsubscribe();
      clearTimeout(timer);
      resolve(task);
    });
    return promise;
  }

  #persist(task: Task): Task {
    const saved = this.#store.save(task);
    for (const cb of this.#listeners) {
      try {
        cb(saved);
      } catch {
        // подписчик не должен ломать цикл задачи
      }
    }
    return saved;
  }

  constructor(deps: ControllerDeps) {
    this.#store = deps.store;
    this.#linkFactory = deps.linkFactory;
    this.#clock = deps.now ?? Date.now;
    this.#threshold = Math.max(1, Math.trunc(deps.noProgressThreshold ?? DEFAULT_NO_PROGRESS));
    this.#strategiesBeforeStop = Math.max(0, Math.trunc(deps.strategiesBeforeStop ?? DEFAULT_STRATEGIES));
  }

  create(input: CreateTaskInput): Task {
    const now = this.#clock();
    const task: Task = {
      id: `task-${randomUUID()}`,
      goal: input.goal,
      cwd: input.cwd,
      model: input.model,
      status: "queued",
      stopReason: null,
      createdAt: now,
      updatedAt: now,
      // Критерии копируются и принудительно гасятся: набор фиксируется до первого
      // действия, и модель не может ни отменить проверку, ни «заранее» её закрыть.
      criteria: structuredClone(input.criteria).map((c) => ({
        ...c,
        passed: false,
        lastResult: undefined,
        checkedAt: undefined,
      })),
      stage: "создана: критерии и проверки зафиксированы",
      lastVerifiedResult: null,
      attempts: [],
      evidence: [],
      spend: emptySpend(),
      budget: { ...input.budget },
      strategiesTried: [],
      noProgressStreak: 0,
      pendingAction: null,
      approval: null,
      autoApprove: [...(input.autoApprove ?? [])],
      turns: 0,
      nextInstruction: null,
    };
    return this.#persist(task);
  }

  start(id: string): void {
    const task = this.#store.get(id);
    if (task === null) return;
    if (isTerminal(task.status) || this.#cancelled.has(id)) return;
    if (this.#loops.has(id)) return; // один цикл на задачу
    const loop = this.#run(id)
      .catch((err: unknown) => this.#crash(id, err))
      .finally(() => {
        this.#loops.delete(id);
        this.#release(id);
      });
    this.#loops.set(id, loop);
  }

  /** Пауза останавливает цикл перед следующим ходом; текущий ход доживает и фиксируется. */
  pause(id: string): void {
    const task = this.#store.get(id);
    if (task === null || isTerminal(task.status) || this.#cancelled.has(id)) return;
    if (statusOf(task) === "paused") return;
    task.status = "paused";
    task.stage = "пауза по запросу пользователя";
    this.#persist(task);
  }

  resume(id: string): void {
    const task = this.#store.get(id);
    if (task === null || isTerminal(task.status) || this.#cancelled.has(id)) return;
    if (statusOf(task) === "paused") {
      task.status = "running";
      task.stage = "продолжение после паузы";
      this.#persist(task);
    }
    this.#wake(id);
    this.start(id);
  }

  cancel(id: string): void {
    const task = this.#store.get(id);
    if (task === null || isTerminal(task.status)) return;
    this.#cancelled.add(id);
    // Частичный результат не выбрасываем: он уже лежит в attempts/evidence, а
    // pendingAction снимается — повторять незавершённое действие никто не станет.
    task.pendingAction = null;
    task.status = "cancelled";
    task.stage = "отменена пользователем";
    task.stopReason = {
      kind: "cancelled",
      detail: "Отменено пользователем; частичный результат остался в журнале попыток и доказательств.",
    };
    this.#persist(task);
    this.#signals.get(id)?.abort();
    const link = this.#links.get(id);
    if (link !== undefined) void link.abort().catch(() => {});
    this.#wakeApproval(id);
    this.#wake(id);
  }

  decideApproval(id: string, decision: "allow" | "deny"): void {
    const task = this.#store.get(id);
    if (task === null || task.approval === null) return;
    if (task.approval.decision !== null) return; // повторное решение не перебивает первое
    if (statusOf(task) === "cancelled") return;
    const approval = task.approval;
    approval.decision = decision;
    const link = this.#links.get(id);
    if (link !== undefined) void link.answerApproval(approval.requestId, decision).catch(() => {});
    if (decision === "deny") {
      task.status = "blocked";
      task.stage = `действие не разрешено: ${approval.title}`;
      task.stopReason = {
        kind: "blocked",
        detail: `Пользователь запретил действие «${approval.title}» (${approval.detail}). Продолжать без другого разрешения нельзя.`,
      };
    } else {
      task.status = "running";
      task.stage = `действие разрешено: ${approval.title}`;
    }
    this.#persist(task);
    this.#wakeApproval(id);
  }

  get(id: string): Task | null {
    return this.#store.get(id);
  }

  list(): Task[] {
    return this.#store.list();
  }

  /**
   * Подъём задач после рестарта шлюза.
   *
   * Если ход был отправлен, но исход до диска не дошёл — задача паркуется в
   * `blocked`, а не повторяется: действие могло уже сработать (файл записан,
   * команда ушла), и второй прогон сделал бы работу дважды.
   */
  resumeAfterRestart(): void {
    for (const task of this.#store.resumable()) {
      if (task.pendingAction !== null) {
        this.#finish(task, "blocked", {
          kind: "blocked",
          detail:
            `Причина: исход неизвестен, нужно подтверждение — ${task.pendingAction.kind} «${clip(task.pendingAction.detail, 160)}» ` +
            `отправлен ${new Date(task.pendingAction.at).toISOString()}, результат не сохранился. ` +
            "Проверьте состояние вручную и решите, продолжать ли задачу.",
        });
        continue;
      }
      if (statusOf(task) === "running" || statusOf(task) === "verifying") {
        // Цикл начинается с хода, поэтому verifying после рестарта снова становится
        // running: доказательства проверок сохранились, а незавершённая приёмка
        // будет переиграна после следующего хода.
        task.status = "running";
      }
      task.stage = "продолжение после рестарта";
      this.#persist(task);
      this.start(task.id);
    }
  }

  // ── цикл ────────────────────────────────────────────────────────────────

  async #run(id: string): Promise<void> {
    for (;;) {
      const task = this.#store.get(id);
      if (task === null) return;
      if (this.#cancelled.has(id) || statusOf(task) === "cancelled") return;
      if (isTerminal(task.status)) return;

      if (statusOf(task) === "paused") {
        await this.#wait(id);
        continue;
      }
      // Парк на approval: решение придёт извне (пользователь или авто-политика).
      // Решение могло прийти до рестарта — тогда цикл не ждёт, а применяет его:
      // `continue` без изменения статуса крутился бы вечно.
      if (statusOf(task) === "awaiting_approval") {
        if (task.approval === null) {
          this.#finish(task, "blocked", {
            kind: "blocked",
            detail: "Запрос разрешения потерян: статус awaiting_approval без самого запроса. Нужно подтверждение пользователя.",
          });
          return;
        }
        if (task.approval.decision === null) {
          await this.#waitApproval(id);
          continue;
        }
        if (task.approval.decision === "deny") {
          this.#finish(task, "blocked", {
            kind: "blocked",
            detail: `Пользователь запретил действие «${task.approval.title}» (${task.approval.detail}). Продолжать без другого разрешения нельзя.`,
          });
          return;
        }
        task.status = "running";
        this.#persist(task);
        continue;
      }

      // Критериев нет — значит их надо вывести из цели до любого рабочего действия.
      if (task.criteria.length === 0) {
        if (!(await this.#deriveCriteria(task))) return;
        continue;
      }

      // Резерв бюджета освобождается только в фазе приёмки: `work` держит его, чтобы
      // лимит не кончился ровно перед финальным прогоном.
      const phase: "work" | "verify" = statusOf(task) === "verifying" ? "verify" : "work";
      const verdict = checkBudget(task.spend, task.budget, phase);
      if (!verdict.ok) {
        this.#finish(task, "budget_exhausted", { kind: "budget", detail: verdict.reason ?? "бюджет исчерпан" });
        return;
      }

      await this.#step(id);
    }
  }

  /** Один ход: промпт → ответ → проверки → переход состояния. */
  /** Критерии из цели: один плановый ход. Набор фиксируется ДО первого рабочего
   *  действия и дальше меняется только раннером проверок — даже если агент позже
   *  «передумает», критерии в задаче останутся теми же. */
  async #deriveCriteria(task: Task): Promise<boolean> {
    task.status = "running";
    task.stage = "планирование: вывожу критерии приёмки из цели";
    this.#persist(task);
    const prompt = [
      "Ты планировщик приёмки. По цели составь критерии, каждый из которых проверяется командой в этом каталоге.",
      `Цель: ${task.goal}`,
      `Рабочий каталог: ${task.cwd}`,
      "",
      "Верни ТОЛЬКО JSON без пояснений:",
      '{"criteria":[{"id":"c1","statement":"что должно быть истинно","check":{"command":"неинтерактивная команда, exit 0 = успех"}}]}',
      "Правила: 1–6 критериев; команда завершается сама и укладывается в 120 с; никаких внешних сервисов, недоступных из каталога; если проверить нечем — не выдумывай критерий.",
    ].join("\n");
    const link = await this.#link(task);
    const outcome = await link.prompt(prompt);
    task.spend = addUsage(task.spend, outcome.usage, null);
    if (typeof outcome.costUsd === "number" && Number.isFinite(outcome.costUsd)) {
      task.spend.costUsd = Math.round(((task.spend.costUsd ?? 0) + outcome.costUsd) * 1e6) / 1e6;
    }
    task.turns += 1;
    const criteria = outcome.status === "completed" ? parseCriteriaJson(outcome.text) : null;
    if (criteria === null) {
      this.#finish(task, "blocked", {
        kind: "blocked",
        detail:
          "Не удалось вывести критерии приёмки из цели: модель не вернула разбираемый JSON с проверками. " +
          "Задай критерии явно при создании задачи (criteria[].check.command).",
      });
      return false;
    }
    task.criteria = criteria;
    task.stage = `критерии зафиксированы: ${criteria.length}`;
    this.#persist(task);
    return true;
  }

  async #step(id: string): Promise<void> {
    const task = this.#store.get(id);
    if (task === null) return;

    // Метка стратегии выводится из числа исчерпанных: после смены номера она растёт.
    const strategy = `S${task.strategiesTried.length + 1}`;
    const prompt = buildPrompt(task, strategy);
    const attempt: Attempt = {
      index: task.attempts.length + 1,
      startedAt: this.#clock(),
      strategy,
      summary: "",
      progress: false,
      failures: [],
    };
    task.attempts.push(attempt);
    task.turns += 1;
    task.status = "running";
    task.stage = `ход ${task.turns}: стратегия ${strategy}`;
    // pendingAction пишется ДО отправки промпта: после рестарта по нему видно,
    // что исход неизвестен, и повторять ход вслепую запрещено.
    task.pendingAction = {
      at: this.#clock(),
      kind: "prompt",
      detail: prompt,
      attempts: this.#notePrompt(id, prompt),
    };
    this.#persist(task);

    const signal = new AbortController();
    this.#signals.set(id, signal);
    let outcome: TurnOutcome;
    try {
      const link = await this.#link(task);
      outcome = await link.prompt(prompt, { signal: signal.signal });
    } catch (err) {
      // Контракт обещает «не бросает», но управляющий цикл не имеет права упасть
      // из-за двойника/транспорта: ошибка становится обычным ходом без прогресса.
      outcome = {
        status: "error",
        text: "",
        usage: emptyUsage(),
        toolFailures: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.#signals.delete(id);
    }

    // Исход получен — снимаем pendingAction раньше проверок, чтобы рестарт между
    // ними не выглядел как «ход неизвестного исхода».
    task.pendingAction = null;
    // Деньги здесь не пересчитываются: стоимость берётся из данных omp, а у
    // контроллера есть только дельта токенов.
    task.spend = addUsage(task.spend, outcome.usage, null);
    // Деньги считает omp (`get_session_stats.cost`): своя таблица цен на каждую
    // модель — источник расхождений, поэтому берём факт, а не пересчёт.
    if (typeof outcome.costUsd === "number" && Number.isFinite(outcome.costUsd)) {
      task.spend.costUsd = Math.round(((task.spend.costUsd ?? 0) + outcome.costUsd) * 1e6) / 1e6;
    }
    attempt.finishedAt = this.#clock();
    attempt.summary = clip(outcome.text.trim(), SUMMARY_LIMIT) || `(${outcome.status}, без текста)`;
    attempt.failures.push(...outcome.toolFailures);
    this.#persist(task);

    if (this.#cancelled.has(id) || statusOf(task) === "cancelled") return;
    if (statusOf(task) === "paused") return;

    // Approval, пришедший во время хода, паркует задачу до решения: ход не
    // «проглатывается» молча и не продолжается с запрещённым действием.
    if (task.approval !== null && task.approval.decision === null) {
      await this.#waitApproval(id);
      if (this.#cancelled.has(id) || isTerminal(task.status) || statusOf(task) === "paused") return;
      if (task.approval.decision === "deny") return; // decideApproval уже поставил blocked
    }

    let failureText = "";
    let progressed = false;

    if (outcome.status === "completed") {
      const quick = await verify(task.criteria, task.cwd, { onlyOpen: true });
      task.evidence.push(...quick.evidence);
      // Прогресс — это новый зелёный критерий, а не бодрый текст модели. Повторная
      // зелёная проверка уже закрытого критерия прогрессом не считается: иначе
      // задача «двигалась» бы, стоя на месте.
      progressed = quick.newlyPassed.length > 0;
      failureText = quick.allPassed ? "" : failuresToInstruction(quick);
      attempt.failures.push(...task.criteria.filter((c) => !c.passed).map((c) => c.id));

      if (this.#cancelled.has(id) || statusOf(task) === "paused") return;

      if (task.criteria.length > 0 && task.criteria.every((c) => c.passed)) {
        // Точечный прогон закрыл всё, но завершает задачу только ПОЛНЫЙ набор:
        // иначе остался бы «зелёным» критерий, который никто не перепроверил.
        task.stage = "финальная проверка приёмки";
        task.status = "verifying";
        this.#persist(task);
        const full = await verify(task.criteria, task.cwd, { onlyOpen: false });
        task.evidence.push(...full.evidence);
        if (this.#cancelled.has(id)) return;
        if (full.allPassed) {
          task.lastVerifiedResult = `полный прогон: ${task.criteria.length} критериев зелёные`;
          attempt.progress = true;
          this.#finish(task, "done", {
            kind: "done",
            detail: `Все критерии приёмки подтверждены полным прогоном: ${task.criteria.map((c) => c.id).join(", ")}`,
          });
          return;
        }
        // Полный прогон нашёл регрессию — возвращаемся в работу с её текстом.
        progressed = false;
        failureText = failuresToInstruction(full);
        task.lastVerifiedResult = null;
        if (statusOf(task) !== "paused") task.status = "running";
      }
    } else {
      // Ошибка транспорта — не «готово» и не прогресс; агент должен увидеть её текст.
      failureText =
        `Ход завершился со статусом ${outcome.status}: ${outcome.error ?? "без текста"}. ` +
        "Проверь инструменты/сеть и продолжи иначе.";
      attempt.failures.push(`turn:${outcome.status}`);
    }

    if (progressed) {
      task.noProgressStreak = 0;
      task.nextInstruction = null;
    } else {
      task.noProgressStreak += 1;
      if (task.noProgressStreak >= this.#threshold) {
        // Порог: не «продолжай», а «смени подход». Текущая стратегия объявляется
        // исчерпанной, следующая получает новый номер и запрет повторять старые ходы.
        if (!task.strategiesTried.includes(strategy)) task.strategiesTried.push(strategy);
        task.noProgressStreak = 0;
        if (task.strategiesTried.length > this.#strategiesBeforeStop) {
          this.#finish(task, "no_progress", {
            kind: "no_progress",
            detail:
              `Прогресса нет после ${task.strategiesTried.length} стратегий (${task.strategiesTried.join(", ")}): ` +
              `порог ${this.#threshold} ходов без закрытых критериев достигнут ${task.strategiesTried.length} раз.`,
          });
          return;
        }
        failureText = [failureText, strategyChangeInstruction(task, strategy, this.#threshold)]
          .filter((part) => part !== "")
          .join("\n");
      }
    }

    attempt.progress = progressed;
    task.nextInstruction = failureText === "" ? null : failureText;
    if (statusOf(task) !== "paused" && statusOf(task) !== "awaiting_approval") task.status = "running";
    task.stage =
      task.criteria.length === 0
        ? "в работе: критерии не заданы"
        : `в работе: открыто ${task.criteria.filter((c) => !c.passed).length} из ${task.criteria.length}`;
    this.#persist(task);
  }

  // ── инфраструктура ──────────────────────────────────────────────────────

  async #link(task: Task): Promise<AgentLink> {
    const existing = this.#links.get(task.id);
    if (existing !== undefined) return existing;
    const link = await this.#linkFactory(task);
    // Approval может прийти в любой момент хода: контроллер либо разрешает действие
    // политикой, либо паркует задачу до решения пользователя.
    link.onApproval((req) => this.#onApproval(task.id, req));
    this.#links.set(task.id, link);
    return link;
  }

  #onApproval(id: string, req: ApprovalRequest): void {
    const task = this.#store.get(id);
    if (task === null || isTerminal(task.status)) return;

    if (autoAllowed(task, req)) {
      // Разрешённое политикой действие не должно будить человека: отвечаем сразу,
      // но оставляем след в задаче для аудита.
      task.approval = {
        requestId: req.id,
        title: req.title,
        detail: req.detail,
        requestedAt: this.#clock(),
        decision: "allow",
      };
      this.#persist(task);
      const link = this.#links.get(id);
      if (link !== undefined) void link.answerApproval(req.id, "allow").catch(() => {});
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    this.#approvalWaits.set(id, { promise, release: resolve });
    task.approval = {
      requestId: req.id,
      title: req.title,
      detail: req.detail,
      requestedAt: this.#clock(),
      decision: null,
    };
    task.status = "awaiting_approval";
    task.stage = `ожидает разрешения: ${req.title}`;
    this.#persist(task);
  }

  #finish(task: Task, status: TaskStatus, reason: StopReason): void {
    if (statusOf(task) === "cancelled") return; // отмена сильнее любого перехода
    task.status = status;
    task.stage = status === "done" ? "готово" : `остановлено: ${status}`;
    task.stopReason = reason;
    task.pendingAction = null;
    this.#persist(task);
  }

  #crash(id: string, err: unknown): void {
    const task = this.#store.get(id);
    if (task === null || isTerminal(task.status)) return;
    this.#finish(task, "failed", {
      kind: "failed",
      detail: `Сбой управляющего цикла: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  /** Закрывает сессию и будит всех, кто её ждал. */
  #release(id: string): void {
    const link = this.#links.get(id);
    this.#links.delete(id);
    this.#signals.get(id)?.abort();
    this.#signals.delete(id);
    if (link !== undefined) void link.close().catch(() => {});
    this.#wakeApproval(id);
    this.#wake(id);
  }

  #notePrompt(id: string, prompt: string): number {
    const key = `${id}\u0000${prompt}`;
    const n = (this.#promptCounts.get(key) ?? 0) + 1;
    this.#promptCounts.set(key, n);
    return n;
  }

  #wait(id: string): Promise<void> {
    const existing = this.#wakeWaits.get(id);
    if (existing !== undefined) return existing.promise;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#wakeWaits.set(id, { promise, release: resolve });
    return promise;
  }

  #wake(id: string): void {
    const wait = this.#wakeWaits.get(id);
    if (wait === undefined) return;
    this.#wakeWaits.delete(id);
    wait.release();
  }

  #waitApproval(id: string): Promise<void> {
    const existing = this.#approvalWaits.get(id);
    if (existing !== undefined) return existing.promise;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#approvalWaits.set(id, { promise, release: resolve });
    return promise;
  }

  #wakeApproval(id: string): void {
    const wait = this.#approvalWaits.get(id);
    if (wait === undefined) return;
    this.#approvalWaits.delete(id);
    wait.release();
  }
}

// ── чистые помощники ──────────────────────────────────────────────────────

/**
 * Разбор критериев из планового хода. Модель обязана вернуть JSON; всё, что не
 * похоже на проверяемый критерий, отбрасывается — лучше пустой набор (→ blocked),
 * чем «критерий», который нельзя проверить.
 */
export function parseCriteriaJson(text: string): Criterion[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("criteria" in parsed)) return null;
  const list = (parsed as { criteria: unknown }).criteria;
  if (!Array.isArray(list)) return null;
  const out: Criterion[] = [];
  for (const raw of list.slice(0, 6)) {
    if (raw === null || typeof raw !== "object") continue;
    if (!("statement" in raw) || typeof raw.statement !== "string") continue;
    const statement = raw.statement.trim();
    if (statement.length === 0) continue;
    const id = "id" in raw && typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `c${out.length + 1}`;
    let check: Criterion["check"];
    if ("check" in raw && raw.check !== null && typeof raw.check === "object" && "command" in raw.check) {
      const command = raw.check.command;
      if (typeof command === "string" && command.trim().length > 0) {
        check = { command: command.trim() };
        const spec = raw.check as { expectExit?: unknown; expectContains?: unknown; timeoutMs?: unknown };
        if (typeof spec.expectExit === "number") check.expectExit = spec.expectExit;
        if (typeof spec.expectContains === "string" && spec.expectContains.length > 0) check.expectContains = spec.expectContains;
        if (typeof spec.timeoutMs === "number") check.timeoutMs = Math.min(Math.max(spec.timeoutMs, 1_000), 600_000);
      }
    }
    out.push({ id, statement: statement.slice(0, 200), ...(check !== undefined ? { check } : {}), passed: false, derived: true });
  }
  const unique = new Map<string, Criterion>();
  for (const c of out) if (!unique.has(c.id)) unique.set(c.id, c);
  return unique.size > 0 ? [...unique.values()] : null;
}

/**
 * Промпт хода. «Продолжай» здесь нет и быть не может: агенту отдаётся цель, этап,
 * открытые критерии с их командами, текст последних провалов и требование сменить
 * стратегию, если порог уже пройден.
 */
function buildPrompt(task: Task, strategy: string): string {
  const lines: string[] = [];
  lines.push(`Цель задачи: ${task.goal}`);
  lines.push(`Текущий этап: ${task.stage}`);
  lines.push(`Рабочий каталог: ${task.cwd}`);
  lines.push(`Твоя стратегия на этот ход: ${strategy}.`);

  const open = task.criteria.filter((c) => !c.passed);
  if (open.length === 0) {
    lines.push("Открытых критериев нет: всё закрыто проверками, ничего не меняй.");
  } else {
    lines.push("Открытые критерии приёмки (закрыть их может только зелёная проверка, не текст):");
    for (const c of open) {
      const command = c.check?.command;
      lines.push(`- ${c.id}: ${c.statement}${command === undefined ? " [машинной проверки нет]" : ` [проверка: ${command}]`}`);
      if (c.lastResult !== undefined && c.lastResult !== "") {
        const tail = c.lastResult.split("\n").slice(-2).join(" | ");
        lines.push(`  последний результат: ${clip(tail, 200)}`);
      }
    }
  }

  // Подтверждённые факты переживают компакцию контекста: агент видит, что уже
  // закрыто, и не переделывает это после сжатия истории.
  const passed = task.criteria.filter((c) => c.passed);
  if (passed.length > 0) {
    lines.push(`Уже подтверждено зелёными проверками: ${passed.map((c) => `${c.id} (${c.statement})`).join("; ")}. Повторно делать не нужно.`);
  }

  if (task.strategiesTried.length > 0) {
    lines.push(`Уже испробованные стратегии (не повторяй их): ${task.strategiesTried.join(", ")}.`);
  }
  if (task.nextInstruction !== null && task.nextInstruction !== "") {
    lines.push("", "Что показали проверки и чего ждёт контроллер:", task.nextInstruction);
  }

  lines.push(
    "",
    "Сделай один конкретный шаг к открытым критериям и закончи ход. Не объявляй готовность, пока проверки не зелёные.",
  );
  return lines.join("\n");
}

function strategyChangeInstruction(task: Task, strategy: string, threshold: number): string {
  const tried = task.strategiesTried.join(", ");
  return (
    `Порог безрезультатных ходов достигнут (${threshold} подряд без новых закрытых критериев).\n` +
    `Стратегия ${strategy} не работает. Испробовано: ${tried}.\n` +
    "Смени подход: не повторяй те же команды и файлы, выбери принципиально другой способ и одной строкой объясни, что именно меняешь."
  );
}

/**
 * Политика авто-разрешений: подстрока команды или шаблон со `*`.
 * Проверяются и заголовок, и детали запроса — одно поле часто содержит лишь имя
 * инструмента, а команда видна только в деталях.
 */
function autoAllowed(task: Task, req: ApprovalRequest): boolean {
  const haystack = `${req.title}\n${req.detail}`.toLowerCase();
  for (const raw of task.autoApprove) {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "") continue;
    if (!pattern.includes("*")) {
      if (haystack.includes(pattern)) return true;
      continue;
    }
    // Шаблон со звёздочкой: «bun test*» разрешает тесты, но не «rm -rf».
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(source, "s").test(haystack)) return true;
  }
  return false;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
