import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskController } from "../controller.ts";
import { ScriptedLink } from "../links.ts";
import { TaskStore } from "../store.ts";
import type { Criterion, Task } from "../types.ts";
import { emptySpend } from "../types.ts";

/**
 * Тесты управляющего цикла на сценарном двойнике модели.
 *
 * Цикл живёт в фоне и наружу не отдаёт промисов, поэтому тест ждёт состояния
 * задачи через тот же `get`, что и UI: если чего-то не видно в store — этого не
 * произошло. Проверки — настоящие команды `true`/`false` во временном каталоге,
 * то есть проверяется и раннер проверок, и то, что «готово» говорит не модель.
 */

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-autonomy-"));
  store = new TaskStore(join(dir, "tasks"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function until(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Ждём событие (статус в store), а не «достаточную паузу»: setImmediate отдаёт
  // поток дочерним проверкам, а таймер теста только защищает от вечного зависания.
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function bigBudget(): Task["budget"] {
  return { maxTokens: 1_000_000, reserveTokens: 0 };
}

function createTask(controller: TaskController, overrides: Partial<Task> = {}): Task {
  return controller.create({
    goal: "тестовая цель",
    cwd: dir,
    model: "test/model",
    criteria: [{ id: "c1", statement: "проверка проходит", check: { command: "true" }, passed: false }],
    budget: bigBudget(),
    ...overrides,
  });
}

test("create фиксирует критерии и сохраняет задачу до первого хода", () => {
  const controller = new TaskController({
    store,
    linkFactory: async () => new ScriptedLink(),
  });
  const seeded: Criterion[] = [{ id: "c1", statement: "файл есть", check: { command: "true" }, passed: true }];
  const task = createTask(controller, { criteria: seeded });

  expect(task.status).toBe("queued");
  // Модель не может принести уже закрытый критерий: passed сбрасывается.
  expect(task.criteria[0]?.passed).toBe(false);
  expect(task.criteria).not.toBe(seeded);

  const onDisk = JSON.parse(readFileSync(store.path(task.id), "utf8")) as Task;
  expect(onDisk.status).toBe("queued");
  expect(onDisk.criteria.map((c) => c.id)).toEqual(["c1"]);
  expect(controller.list().map((t) => t.id)).toEqual([task.id]);
  expect(controller.get("нет-такой-задачи")).toBe(null);
});

test("прогресс закрывает критерий и завершает задачу полным прогоном", async () => {
  const link = new ScriptedLink().pushTurn({ text: "Критерий закрыт." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller);

  controller.start(task.id);
  await until("готово", () => controller.get(task.id)?.status === "done");

  const done = controller.get(task.id)!;
  expect(done.criteria[0]?.passed).toBe(true);
  expect(done.attempts[0]?.progress).toBe(true);
  expect(done.noProgressStreak).toBe(0);
  expect(done.stopReason?.kind).toBe("done");
  expect(done.lastVerifiedResult).toContain("полный прогон");
  expect(link.prompts).toHaveLength(1);
});

test("преждевременное «готово» продолжает работу с текстом провала проверки", async () => {
  // Проверка сама создаёт маркер и падает: только второй прогон станет зелёным.
  const check = "test -f marker || { touch marker; exit 1; }";
  const link = new ScriptedLink()
    .pushTurn({ text: "Готово! Всё сделано." })
    .pushTurn({ text: "Сделал: создал marker." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller, {
    goal: "создать marker в рабочем каталоге",
    criteria: [{ id: "c1", statement: "marker существует", check: { command: check }, passed: false }],
  });

  controller.start(task.id);
  await until("второй ход", () => link.prompts.length >= 2);

  const second = link.prompts[1]!;
  // Промпт — не «продолжай»: цель, критерий и текст упавшей проверки.
  expect(second).toContain("создать marker в рабочем каталоге");
  expect(second).toContain("c1");
  expect(second).toContain("exit 1");

  await until("готово", () => controller.get(task.id)?.status === "done");
  const done = controller.get(task.id)!;
  expect(done.criteria[0]?.passed).toBe(true);
  expect(done.attempts[1]?.progress).toBe(true);
  expect(done.spend.turns).toBe(2);
  expect(link.prompts).toHaveLength(2);
});

test("порог без прогресса требует смены стратегии, исчерпание стратегий даёт no_progress", async () => {
  const link = new ScriptedLink(); // дефолтные ходы: «ok» без токенов
  const controller = new TaskController({
    store,
    linkFactory: async () => link,
    noProgressThreshold: 2,
    strategiesBeforeStop: 1,
  });
  const task = createTask(controller, {
    goal: "починить проверку, которая всегда падает",
    criteria: [{ id: "c1", statement: "всегда падает", check: { command: "false" }, passed: false }],
  });

  controller.start(task.id);
  await until("no_progress", () => controller.get(task.id)?.status === "no_progress");

  const stopped = controller.get(task.id)!;
  expect(stopped.strategiesTried).toEqual(["S1", "S2"]);
  expect(stopped.noProgressStreak).toBe(0);
  expect(stopped.stopReason?.kind).toBe("no_progress");
  // 2 хода на S1 + 2 на S2: порог сбрасывается после смены стратегии.
  expect(link.prompts).toHaveLength(4);
  expect(link.prompts[2]).toContain("Смени подход");
  expect(link.prompts[2]).toContain("Испробовано: S1");
  expect(link.prompts[2]).toContain("S2");
});

test("исчерпанный бюджет останавливает задачу как budget_exhausted, а не done", async () => {
  const link = new ScriptedLink().pushTurn({ text: "Работаю." }); // 100 + 50 токенов
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller, {
    criteria: [{ id: "c1", statement: "не проходит", check: { command: "false" }, passed: false }],
    budget: { maxTokens: 120, reserveTokens: 0 },
  });

  controller.start(task.id);
  await until("budget_exhausted", () => controller.get(task.id)?.status === "budget_exhausted");

  const stopped = controller.get(task.id)!;
  expect(stopped.stopReason?.kind).toBe("budget");
  expect(stopped.stopReason?.detail).toContain("Бюджет токенов исчерпан");
  expect(stopped.turns).toBe(1);
  expect(stopped.spend.inputTokens).toBe(100);
  expect(stopped.spend.outputTokens).toBe(50);
  expect(link.prompts).toHaveLength(1);
});

test("деньги хода из omp учитываются в бюджете: maxCostUsd останавливает задачу", async () => {
  const link = new ScriptedLink()
    .pushTurn({ text: "Шаг 1.", costUsd: 0.3 })
    .pushTurn({ text: "Шаг 2.", costUsd: 0.3 });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller, {
    criteria: [{ id: "c1", statement: "не проходит", check: { command: "false" }, passed: false }],
    budget: { maxTokens: 1_000_000, maxCostUsd: 0.5, reserveTokens: 0 },
  });

  controller.start(task.id);
  await until("budget_exhausted", () => controller.get(task.id)?.status === "budget_exhausted");

  const stopped = controller.get(task.id)!;
  // Стоимость не пересчитывается таблицей цен, а берётся из данных omp как есть.
  expect(stopped.spend.costUsd).toBe(0.6);
  expect(stopped.stopReason?.kind).toBe("budget");
  expect(stopped.stopReason?.detail).toContain("Денежный лимит исчерпан");
  expect(link.prompts).toHaveLength(2);
});

test("approval паркует задачу, отказ пользователя даёт blocked", async () => {
  const link = new ScriptedLink()
    .pushApproval({ id: "apr-1", title: "bun install", detail: "bun add left-pad" })
    .pushTurn({ text: "Ставлю зависимость." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller);

  controller.start(task.id);
  await until("awaiting_approval", () => controller.get(task.id)?.status === "awaiting_approval");

  const parked = controller.get(task.id)!;
  expect(parked.approval?.requestId).toBe("apr-1");
  expect(parked.approval?.decision).toBe(null);
  expect(parked.stage).toContain("ожидает разрешения");
  expect(link.prompts).toHaveLength(1);

  controller.decideApproval(task.id, "deny");
  const refused = controller.get(task.id)!;
  expect(refused.status).toBe("blocked");
  expect(refused.stopReason?.kind).toBe("blocked");
  expect(refused.stopReason?.detail).toContain("bun install");
  expect(link.answered).toEqual([{ id: "apr-1", decision: "deny" }]);

  // Цикл завершился сам: связь закрыта — значит, новых ходов после отказа не будет.
  await until("цикл закрыл связь", () => link.closed);
  expect(link.prompts).toHaveLength(1);
});

test("действие из autoApprove не паркует задачу", async () => {
  const link = new ScriptedLink()
    .pushApproval({ id: "apr-2", title: "bun test", detail: "bun test gateway/autonomy" })
    .pushTurn({ text: "Прогнал тесты." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller, { autoApprove: ["bun test*"] });

  controller.start(task.id);
  await until("готово", () => controller.get(task.id)?.status === "done");

  expect(link.answered).toEqual([{ id: "apr-2", decision: "allow" }]);
  expect(controller.get(task.id)?.approval?.decision).toBe("allow");
  expect(link.prompts).toHaveLength(1);
});

test("cancel отменяет задачу, абортит связь и сохраняет частичный результат", async () => {
  const link = new ScriptedLink()
    .pushApproval({ id: "apr-3", title: "rm -rf build", detail: "rm -rf build" })
    .pushTurn({ text: "Чищу build." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = createTask(controller);

  controller.start(task.id);
  await until("ход зафиксирован", () => (controller.get(task.id)?.attempts[0]?.summary ?? "") !== "");

  controller.cancel(task.id);
  const cancelled = controller.get(task.id)!;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.stopReason?.kind).toBe("cancelled");
  expect(cancelled.pendingAction).toBe(null);
  expect(cancelled.attempts[0]?.summary).toBe("Чищу build.");

  await until("abort связи", () => link.aborts === 1);
  await until("цикл закрыл связь", () => link.closed);
  expect(controller.get(task.id)?.status).toBe("cancelled");
  expect(link.prompts).toHaveLength(1);
});

test("resumeAfterRestart не повторяет ход с неизвестным исходом", async () => {
  const link = new ScriptedLink();
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = store.save({
    id: "task-unknown",
    goal: "записать файл с побочным эффектом",
    cwd: dir,
    model: "test/model",
    status: "running",
    stopReason: null,
    createdAt: 1,
    updatedAt: 1,
    criteria: [{ id: "c1", statement: "файл есть", check: { command: "test -f f.txt" }, passed: false }],
    stage: "до рестарта",
    lastVerifiedResult: null,
    attempts: [],
    evidence: [],
    spend: emptySpend(),
    budget: bigBudget(),
    strategiesTried: [],
    noProgressStreak: 0,
    pendingAction: { at: Date.UTC(2026, 9, 18), kind: "prompt", detail: "создай f.txt", attempts: 1 },
    approval: null,
    autoApprove: [],
    turns: 1,
    nextInstruction: null,
  });

  controller.resumeAfterRestart();
  const blocked = controller.get(task.id)!;
  expect(blocked.status).toBe("blocked");
  expect(blocked.stopReason?.kind).toBe("blocked");
  expect(blocked.stopReason?.detail).toContain("исход неизвестен, нужно подтверждение");
  expect(link.prompts).toHaveLength(0);

  controller.resumeAfterRestart(); // повторный подъём уже остановленную не трогает
  expect(link.prompts).toHaveLength(0);
});

test("resumeAfterRestart применяет уже принятое решение по approval, а не виснет", async () => {
  const link = new ScriptedLink().pushTurn({ text: "Действие было разрешено до рестарта." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = store.save({
    id: "task-allowed",
    goal: "продолжить после разрешения",
    cwd: dir,
    model: "test/model",
    status: "awaiting_approval",
    stopReason: null,
    createdAt: 1,
    updatedAt: 1,
    criteria: [{ id: "c1", statement: "проверка проходит", check: { command: "true" }, passed: false }],
    stage: "ожидает разрешения: bun test",
    lastVerifiedResult: null,
    attempts: [],
    evidence: [],
    spend: emptySpend(),
    budget: bigBudget(),
    strategiesTried: [],
    noProgressStreak: 0,
    pendingAction: null,
    approval: { requestId: "apr-9", title: "bun test", detail: "bun test", requestedAt: 1, decision: "allow" },
    autoApprove: [],
    turns: 0,
    nextInstruction: null,
  });

  controller.resumeAfterRestart();
  await until("готово", () => controller.get(task.id)?.status === "done");
  expect(link.prompts).toHaveLength(1);
});

test("resumeAfterRestart поднимает задачу и не дублирует первый ход", async () => {
  const link = new ScriptedLink().pushTurn({ text: "Продолжаю." });
  const controller = new TaskController({ store, linkFactory: async () => link });
  const task = store.save({
    id: "task-resume",
    goal: "доделать после рестарта",
    cwd: dir,
    model: "test/model",
    status: "queued",
    stopReason: null,
    createdAt: 1,
    updatedAt: 1,
    criteria: [{ id: "c1", statement: "проверка проходит", check: { command: "true" }, passed: false }],
    stage: "до рестарта",
    lastVerifiedResult: null,
    attempts: [],
    evidence: [],
    spend: emptySpend(),
    budget: bigBudget(),
    strategiesTried: [],
    noProgressStreak: 0,
    pendingAction: null,
    approval: null,
    autoApprove: [],
    turns: 0,
    nextInstruction: null,
  });

  controller.resumeAfterRestart();
  controller.resumeAfterRestart();

  await until("готово", () => controller.get(task.id)?.status === "done");
  expect(link.prompts).toHaveLength(1);
  expect(controller.get(task.id)?.turns).toBe(1);
});
