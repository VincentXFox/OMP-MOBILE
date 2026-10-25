import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLink, type AgentLink, type LinkFactory } from "../links.ts";
import { TaskController } from "../controller.ts";
import { TaskStore } from "../store.ts";
import { isTerminal, type BudgetLimit, type Criterion, type Task } from "../types.ts";

/**
 * Сценарии §7 из технического задания — на управляемых ответах модели.
 *
 * Каждый тест — это полный путь пользователя: цель → цикл → проверки →
 * остановка, и утверждения только про наблюдаемое состояние задачи/доказательств,
 * а не про внутренние переменные. Модель заменена ScriptedLink, проверки —
 * настоящими shell-командами (`true`/`false`), поэтому детерминированно.
 */

const BUDGET: BudgetLimit = { maxTokens: 1_000_000, reserveTokens: 0 };

let dir = "";
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autonomy-scn-"));
  store = new TaskStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function criterion(id: string, check: string, statement = `критерий ${id}`): Criterion {
  return { id, statement, check: { command: check }, passed: false };
}

/** Фабрика, отдающая один и тот же сценарный двойник (задач в тесте — одна). */
function factoryFor(link: ScriptedLink): { factory: LinkFactory; links: AgentLink[] } {
  const links: AgentLink[] = [link];
  const factory: LinkFactory = () => {
    const next = links.shift();
    if (next === undefined) throw new Error("лишний запрос на соединение");
    return Promise.resolve(next);
  };
  return { factory, links };
}

/** Ожидание терминального статуса — по событию store, без опроса и sleep-ов. */
async function waitTerminal(controller: TaskController, id: string, timeoutMs = 5_000): Promise<Task> {
  const task = await controller.waitFor(id, (t) => isTerminal(t.status), timeoutMs);
  if (task === null) throw new Error(`задача ${id} не дошла до терминального статуса`);
  return task;
}

describe("§7.1 преждевременное «готово» при проваленной приёмке", () => {
  test("модель сказала готово, проверка падает → новая попытка с текстом ошибки", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "Готово, всё сделано." }); // врёт: критерий не выполнен
    link.pushTurn({ text: "Починил: создал файл." }); // исправит (проверка ниже всё ещё false)
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "создать файл result.txt",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "test -f result.txt")],
      budget: BUDGET,
    });
    controller.start(task.id);
    const done = await waitTerminal(controller, task.id);

    // Оба хода пошли в работу, второй промпт несёт проблему проверки, а не «продолжай».
    expect(link.prompts.length).toBeGreaterThanOrEqual(2);
    expect(link.prompts[1]).toContain("c1");
    expect(link.prompts[1]).toContain("exit");
    // Задача не стала done: критерий так и не выполнен.
    expect(done.status).not.toBe("done");
    expect(done.evidence.length).toBeGreaterThan(0);
    expect(done.evidence[0]?.ok).toBe(false);
  });
});

describe("§3 критерии выводятся из цели и фиксируются до работы", () => {
  test("пустой criteria → плановый ход даёт JSON → критерии сохранены с derived", async () => {
    const link = new ScriptedLink();
    // Плановый ход: модель возвращает критерии JSON.
    link.pushTurn({
      text: 'Вот критерии: {"criteria":[{"id":"c1","statement":"файл result.txt есть","check":{"command":"test -f result.txt"}}]}',
    });
    // Рабочий ход.
    link.pushTurn({ text: "создал файл" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "создать result.txt",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [],
      budget: BUDGET,
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "result.txt"), "ok");

    controller.start(task.id);
    const done = await waitTerminal(controller, task.id);

    expect(done.criteria).toHaveLength(1);
    expect(done.criteria[0]?.derived).toBe(true);
    expect(done.criteria[0]?.check?.command).toBe("test -f result.txt");
    expect(done.status).toBe("done");
    // Первый промпт — планировщик, второй — рабочий: критерии зафиксированы ДО него.
    expect(link.prompts[0]).toContain("планировщик");
    expect(link.prompts[1]).toContain("Цель задачи: создать result.txt");
  });

  test("модель не вернула JSON → blocked, задача не начинает работу вслепую", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "не буду" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });
    const task = controller.create({ goal: "что-то", cwd: dir, model: "deepseek/deepseek-v4-flash", criteria: [], budget: BUDGET });
    controller.start(task.id);
    const done = await waitTerminal(controller, task.id);
    expect(done.status).toBe("blocked");
    expect(done.stopReason?.detail ?? "").toMatch(/критери/i);
    expect(link.prompts.length).toBe(1);
  });
});

describe("§7.2 полезные исправления ведут к следующему шагу, успешная приёмка завершает", () => {
  test("критерий закрывается после хода → полный прогон → done с доказательствами", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "создал" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    // Проверка смотрит на файл; сам «агент» его создаёт — так моделируется реальная работа.
    const task = controller.create({
      goal: "создать result.txt",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [{ id: "c1", statement: "файл есть", check: { command: "test -f result.txt" }, passed: false }],
      budget: BUDGET,
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "result.txt"), "ok");

    controller.start(task.id);
    const done = await waitTerminal(controller, task.id);
    expect(done.status).toBe("done");
    expect(done.stopReason?.kind).toBe("done");
    expect(done.criteria.every((c) => c.passed)).toBe(true);
    expect(done.evidence.some((e) => e.ok)).toBe(true);
  });
});

describe("§7.3 повторение неудач без прогресса", () => {
  test("порог → смена стратегии в промпте → остановка no_progress с причиной", async () => {
    const link = new ScriptedLink();
    for (let i = 0; i < 8; i++) link.pushTurn({ text: `попытка ${i}, ничего не изменилось` });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory, noProgressThreshold: 2, strategiesBeforeStop: 1 });

    const task = controller.create({
      goal: "починить несуществующее",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: BUDGET,
    });
    controller.start(task.id);
    const stopped = await waitTerminal(controller, task.id);

    expect(stopped.status).toBe("no_progress");
    expect(stopped.stopReason?.kind).toBe("no_progress");
    // Смена стратегии видна агенту, а не только в логах.
    expect(link.prompts.some((p) => /Смени подход|стратег/i.test(p))).toBe(true);
    expect(stopped.strategiesTried.length).toBeGreaterThan(0);
  });
});

describe("§7.4 исчерпание бюджета", () => {
  test("новые запросы блокируются, счётчики сохраняются и остаются в задаче", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "раз", usage: { inputTokens: 900, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    link.pushTurn({ text: "два" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "бесконечная работа",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: { maxTokens: 1_000, reserveTokens: 0 },
    });
    controller.start(task.id);
    const stopped = await waitTerminal(controller, task.id);

    expect(stopped.status).toBe("budget_exhausted");
    expect(stopped.spend.inputTokens).toBe(900);
    expect(stopped.spend.outputTokens).toBe(200);
    // После исчерпания модель больше не звали.
    expect(link.prompts.length).toBe(1);
  });
});

describe("§7.5 телефон отключён — работа продолжается", () => {
  test("цикл живёт без клиента; после рестарта шлюза задача поднимается из store", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "первый ход" });
    link.pushTurn({ text: "второй ход" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "долгая работа без телефона",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: BUDGET,
    });
    controller.start(task.id);
    await controller.waitFor(task.id, (t) => t.turns > 0, 3_000);
    controller.pause(task.id);

    // Никакой клиент не участвовал: состояние читается с диска новым экземпляром.
    const revived = new TaskStore(dir).get(task.id);
    expect(revived).not.toBeNull();
    expect(revived?.goal).toBe("долгая работа без телефона");
    expect(revived?.turns).toBeGreaterThan(0);
  });
});

describe("§7.6 сбой сервера и повторная доставка не создают двойное выполнение", () => {
  test("неизвестный исход хода после падения → blocked, без повторного вызова модели", async () => {
    const link = new ScriptedLink();
    link.pushTurn({ text: "ход, который оборвался" });
    const { factory } = factoryFor(link);
    const first = new TaskController({ store, linkFactory: factory });
    const task = first.create({
      goal: "работа с побочным эффектом",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: BUDGET,
    });

    // Имитация падения посреди хода: в store остаётся pendingAction.
    const stored = store.get(task.id);
    expect(stored).not.toBeNull();
    if (stored !== null) {
      stored.status = "running";
      stored.pendingAction = { at: Date.now(), kind: "prompt", detail: "ход на середине", attempts: 1 };
      store.save(stored);
    }

    const link2 = new ScriptedLink();
    const second = new TaskController({ store, linkFactory: factoryFor(link2).factory });
    second.resumeAfterRestart();
    const after = await waitTerminal(second, task.id);

    expect(after.status).toBe("blocked");
    expect(after.stopReason?.detail ?? "").toMatch(/неизвестен|подтвержд/i);
    expect(link2.prompts.length).toBe(0); // побочное действие не повторили
  });
});

describe("§7.7 разрешение до действия; блокер не маскируется «готово»", () => {
  test("approval паркует задачу; отказ пользователя → blocked с причиной", async () => {
    const link = new ScriptedLink();
    link.pushApproval({ id: "req-1", title: "Allow tool: bash", detail: "rm -rf build/" });
    link.pushTurn({ text: "удалил" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "почистить сборку",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: BUDGET,
    });
    controller.start(task.id);

    // Дождаться парковки по событию, затем отклонить.
    const parked = await controller.waitFor(task.id, (t) => t.status === "awaiting_approval", 3_000);
    expect(parked?.status).toBe("awaiting_approval");
    expect(controller.get(task.id)?.approval?.detail).toContain("rm -rf");
    controller.decideApproval(task.id, "deny");

    const stopped = await waitTerminal(controller, task.id);
    expect(stopped.status).toBe("blocked");
    expect(link.answered.some((a) => a.id === "req-1" && a.decision === "deny")).toBe(true);
  });

  test("разрешённое по autoApprove действие не паркует задачу", async () => {
    const link = new ScriptedLink();
    link.pushApproval({ id: "req-2", title: "Allow tool: bash", detail: "bun test gateway/" });
    link.pushTurn({ text: "прогнал тесты" });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "прогнать тесты",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "true")],
      budget: BUDGET,
      autoApprove: ["bun test*"],
    });
    controller.start(task.id);
    const done = await waitTerminal(controller, task.id);
    expect(link.answered.some((a) => a.id === "req-2" && a.decision === "allow")).toBe(true);
    expect(done.status).toBe("done");
  });
});

describe("§7.8 отмена пользователя", () => {
  test("cancel прекращает новые действия и сохраняет доступный результат", async () => {
    const link = new ScriptedLink();
    for (let i = 0; i < 5; i++) link.pushTurn({ text: `ход ${i}` });
    const { factory } = factoryFor(link);
    const controller = new TaskController({ store, linkFactory: factory });

    const task = controller.create({
      goal: "долгая задача",
      cwd: dir,
      model: "deepseek/deepseek-v4-flash",
      criteria: [criterion("c1", "false")],
      budget: BUDGET,
    });
    controller.start(task.id);
    await controller.waitFor(task.id, (t) => t.turns > 0, 3_000);
    controller.cancel(task.id);
    const stopped = await waitTerminal(controller, task.id);

    expect(stopped.status).toBe("cancelled");
    expect(link.aborts).toBeGreaterThan(0);
    expect(stopped.attempts.length).toBeGreaterThan(0); // частичный результат сохранён
  });
});
