/**
 * Тесты рантайма: настоящие PTY, эмуляция экрана, сокет-протокол, восстановление.
 *
 * Проверяем то, на что опирается шлюз после отказа от herdr: живучая оболочка
 * панели, точная привязка сессии, безопасный argv восстановления, отсутствие
 * дублей агента и отсутствие инъекции через ввод.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, expect, test } from "bun:test";
import { startRuntime, launchArgvOf, restorationArgv, type RuntimeHandle } from "../server.ts";
import { runtimeRequest, runtimeSubscribe } from "../client.ts";
import { Screen } from "../screen.ts";
import { keySequence } from "../keys.ts";
import { isRunning } from "../process.ts";
import { runtimeBindingForHost } from "../../recovery/runtimeWatch.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

async function setup(): Promise<{ root: string; runtime: RuntimeHandle }> {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-test-"));
  process.env["OMP_RUNTIME_SOCKET"] = join(root, "runtime.sock");
  const runtime = await startRuntime({ socketPath: join(root, "runtime.sock"), stateDir: join(root, "state") });
  cleanups.push(() => runtime.stop());
  return { root, runtime };
}

async function createPane(root: string, cwd = root): Promise<string> {
  const created = await runtimeRequest<{ pane: { id: string } }>("pane.create", { cwd });
  return created.pane.id;
}

async function readPane(paneId: string, format: "text" | "ansi" = "text"): Promise<string> {
  const read = await runtimeRequest<{ text: string }>("pane.read", { paneId, format });
  return read.text;
}

test("экран собирает разрезанный UTF-8, применяет VT и не растёт бесконечно", async () => {
  const screen = new Screen(20, 5, 10);
  const bytes = Buffer.from("Привет");
  await screen.write(bytes.subarray(0, 3));
  await screen.write(bytes.subarray(3));
  await screen.write(Buffer.from("\r\x1b[31mOK\x1b[0m"));
  expect(screen.text()).toContain("OKивет");
  expect(screen.ansi()).toContain("\x1b[");
  for (let i = 0; i < 100; i++) await screen.write(Buffer.from(`\r\nline${i}`));
  expect(screen.text("recent", 1000).split("\n").length).toBeLessThanOrEqual(15);
  screen.dispose();
});

test("панель — живая оболочка: argv, литеральный ввод, resize, ключи и pid-изоляция", async () => {
  const { root } = await setup();
  const paneId = await createPane(root);
  expect(statSync(process.env["OMP_RUNTIME_SOCKET"] as string).mode & 0o777).toBe(0o600);

  // argv запускается без шелл-разбора: кавычка и `; echo BAD` — просто аргументы.
  await runtimeRequest("pane.run", { paneId, argv: ["printf", "%s\\n", "safe ' ; echo BAD"] });
  await until(async () => (await readPane(paneId)).includes("safe ' ; echo BAD"));

  // Литеральный ввод идёт bracketed paste: перевод строки не выполняет команду.
  await runtimeRequest("pane.input", { paneId, text: "touch unexpected\n" });
  // Ждём именно «ничего не произошло»: проверяем, что перевод строки в
  // литеральном вводе не выполнил команду. Условие негативное — таймер тут
  // единственный способ дать shell шанс её выполнить.
  await Bun.sleep(150);
  expect(existsSync(join(root, "unexpected"))).toBe(false);
  await runtimeRequest("pane.input", { paneId, keys: ["ctrl+c"] });
  await until(async () => (await readPane(paneId)).includes("unexpected"));

  await runtimeRequest("pane.resize", { paneId, cols: 90, rows: 24 });
  const resized = await runtimeRequest<{ pane: { cols: number; rows: number } }>("pane.get", { paneId });
  expect([resized.pane.cols, resized.pane.rows]).toEqual([90, 24]);

  // Оболочка панели переживает выход запущенной в ней команды: агент может
  // умереть, а панель остаётся — в неё запускается восстановление.
  await runtimeRequest("pane.run", { paneId, command: "true" });
  await until(async () => {
    const info = await runtimeRequest<{ process_info: { foreground_processes: unknown[] } }>("pane.processInfo", { paneId });
    return info.process_info.foreground_processes.length === 1;
  });
  await runtimeRequest("pane.run", { paneId, command: "echo AFTER-EXIT" });
  await until(async () => (await readPane(paneId)).includes("AFTER-EXIT"));
}, 20_000);

test("подписка: снапшот барьером, порядок seq, переподключение не трогает PTY", async () => {
  const { root } = await setup();
  const paneId = await createPane(root);
  const events: Array<{ event: string; seq: number; data: { text?: string; ansi?: string } }> = [];
  const subscription = await runtimeSubscribe(paneId, (event) => events.push(event as never));
  await runtimeRequest("pane.run", { paneId, command: "printf '\\033[31mПривет\\033[0m\\n'" });
  await until(() => events.some((event) => event.event === "data" && event.data.text?.includes("Привет") === true));
  expect(events[0]?.event).toBe("snapshot");
  for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
  subscription.close();

  const reconnected: Array<{ event: string; data: { ansi?: string } }> = [];
  const again = await runtimeSubscribe(paneId, (event) => reconnected.push(event as never));
  expect(reconnected[0]?.event).toBe("snapshot");
  expect(reconnected[0]?.data.ansi).toContain("Привет");
  const info = await runtimeRequest<{ process_info: { foreground_processes: Array<{ pid: number }> } }>("pane.processInfo", { paneId });
  expect(info.process_info.foreground_processes.some((proc) => proc.pid > 0)).toBe(true);
  again.close();
}, 20_000);

test("сокет отвергает битые и гигантские кадры и разводит параллельные запросы", async () => {
  const { runtime } = await setup();
  const health = await Promise.all(Array.from({ length: 25 }, () => runtimeRequest<{ version: number; ready: boolean }>("health")));
  expect(health.every((item) => item.version === 1 && item.ready)).toBe(true);
  await expect(runtimeRequest("unknown.method")).rejects.toThrow();
  expect(runtime.generation).toMatch(/^[0-9a-f-]{36}$/);

  for (const payload of ["bad\n", `${"x".repeat(1024 * 1024 + 1)}\n`]) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = connect(process.env["OMP_RUNTIME_SOCKET"] as string);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket did not reject frame"));
    }, 2000);
    socket.on("connect", () => socket.write(payload));
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    await promise;
  }
}, 20_000);

test("durable-состояние: закрытая панель не воскресает, живой агент поднимается ровно один раз", async () => {
  const { root, runtime } = await setup();
  const closed = await createPane(root);
  const kept = await createPane(root);
  const marker = join(root, "argv.json");
  const session = join(root, "session.jsonl");
  const fixture = join(root, "fixture.ts");
  writeFileSync(session, "{}\n");
  // Подставной «omp»: пишет свои argv и живёт, пока его не остановят.
  writeFileSync(
    fixture,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));setInterval(()=>{},1000);`,
  );
  chmodSync(fixture, 0o700);

  await runtimeRequest("pane.bind", { paneId: kept, sessionId: "session-id", instanceId: "old-instance", sessionFile: session, launchArgv: [fixture, "--cwd", root, "--allow-home", "--model", "m1", "--resume", "stale"] });
  // Одноразовые селекторы сессии в сохранённый argv не попадают: их место
  // занимает свежий `--restore <файл>`.
  await runtimeRequest("pane.run", { paneId: kept, argv: [fixture, "--cwd", root, "--allow-home", "--model", "m1", "--resume", session], sessionFile: session });
  await runtimeRequest("pane.close", { paneId: closed });
  await runtime.stop();

  const state = JSON.parse(readFileSync(join(root, "state", "panes.json"), "utf8")) as { panes: Array<{ id: string; desiredRunning: boolean }> };
  // Закрытая панель не остаётся в состоянии вовсе: PTY мёртв, процессов нет,
  // воскрешать нечего — иначе panes.json рос бы мёртвыми записями.
  expect(state.panes.some((pane) => pane.id === closed)).toBe(false);
  expect(state.panes.find((pane) => pane.id === kept)?.desiredRunning).toBe(true);

  const revived = await startRuntime({ socketPath: process.env["OMP_RUNTIME_SOCKET"] as string, stateDir: join(root, "state") });
  cleanups.push(() => revived.stop());
  await revived.ready;
  expect(revived.panes().some((pane) => pane.id === closed)).toBe(false);
  const restored = revived.panes().find((pane) => pane.id === kept);
  expect(restored?.sessionFile).toBe(session);
  // Одноразовые селекторы сессии не повторяются: в argv остаются только опции запуска.
  await until(() => existsSync(marker));
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["--cwd", root, "--allow-home", "--model", "m1", "--restore", session]);
  expect(restored?.restoredAt).toBeGreaterThan(0);
  expect(revived.panes().filter((pane) => pane.sessionFile === session).length).toBe(1);
}, 30_000);

test("закрытие панели убивает и оболочку, и процесс, игнорирующий SIGTERM", async () => {
  const { root } = await setup();
  const paneId = await createPane(root);
  const stubborn = join(root, "stubborn.ts");
  // Процесс ведёт себя как TUI агента: SIGTERM ловит и продолжает работать.
  writeFileSync(stubborn, `#!${process.execPath}\nprocess.on("SIGTERM", () => {});setInterval(()=>{},1000);`);
  chmodSync(stubborn, 0o700);
  await runtimeRequest("pane.run", { paneId, argv: [stubborn] });
  const shell = (await runtimeRequest<{ pane: { shellPid: number } }>("pane.get", { paneId })).pane.shellPid;
  let pid = 0;
  await until(async () => {
    const info = await runtimeRequest<{ process_info: { foreground_processes: Array<{ pid: number }> } }>("pane.processInfo", { paneId });
    pid = info.process_info.foreground_processes.find((proc) => proc.pid !== shell)?.pid ?? 0;
    return pid > 0;
  });
  // Дерево снимается до сигналов: после смерти оболочки /proc детей уже не
  // показывает, и агент пережил бы закрытие панели (так и было вживую).
  await runtimeRequest("pane.close", { paneId });
  await until(() => !isRunning(pid));
  expect(isRunning(pid)).toBe(false);
}, 30_000);

test("вышедшая оболочка закрывает панель: она не воскресает и не копится в состоянии", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-exit-"));
  const socketPath = join(root, "runtime.sock");
  const stateDir = join(root, "state");
  process.env["OMP_RUNTIME_SOCKET"] = socketPath;
  const first = await startRuntime({ socketPath, stateDir });
  cleanups.push(() => first.stop());
  const created = await runtimeRequest<{ pane: { id: string } }>("pane.create", { cwd: root });
  await runtimeRequest("pane.bind", { paneId: created.pane.id, sessionFile: join(root, "s.jsonl"), launchArgv: ["/bin/echo", "--cwd", root] });
  // Пользователь выходит из оболочки панели (exit/Ctrl-D).
  await runtimeRequest("pane.input", { paneId: created.pane.id, keys: ["ctrl+d"] });
  await until(async () => (await runtimeRequest<{ panes: unknown[] }>("pane.list")).panes.length === 0);
  expect(JSON.parse(readFileSync(join(stateDir, "panes.json"), "utf8")).panes).toEqual([]);
  await first.stop();

  const revived = await startRuntime({ socketPath, stateDir });
  cleanups.push(() => revived.stop());
  await revived.ready;
  expect(revived.panes().length).toBe(0);
});

test("битый lock не валит демон в краш-луп, а живой владелец защищает состояние", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-lock-"));
  const socketPath = join(root, "runtime.sock");
  const stateDir = join(root, "state");
  process.env["OMP_RUNTIME_SOCKET"] = socketPath;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "runtime.lock"), ""); // обрыв питания в момент записи
  const runtime = await startRuntime({ socketPath, stateDir });
  cleanups.push(() => runtime.stop());
  await runtime.ready;
  const health = await runtimeRequest<{ ready: boolean }>("health");
  expect(health.ready).toBe(true);
});

test("argv восстановления: bare-флаги и флаги со значением различаются", () => {
  // `-c`/`--continue` значения не берут: соседний `--cwd` не должен быть съеден.
  expect(launchArgvOf(["omp", "--continue", "--cwd", "/w", "--allow-home"])).toEqual(["omp", "--cwd", "/w", "--allow-home"]);
  // `-r <файл>` и `--resume=<файл>` — со значением, оба варианта записи.
  expect(launchArgvOf(["omp", "-r", "/s.jsonl", "--allow-home"])).toEqual(["omp", "--allow-home"]);
  expect(launchArgvOf(["omp", "--resume=/s.jsonl", "--cwd", "/w"])).toEqual(["omp", "--cwd", "/w"]);
  expect(restorationArgv({ id: "p", launchArgv: ["omp", "--cwd", "/w", "--allow-home"], sessionFile: "/s.jsonl" } as never)).toEqual([
    "omp",
    "--cwd",
    "/w",
    "--allow-home",
    "--restore",
    "/s.jsonl",
  ]);
});

test("пропавший файл сессии не даёт молчаливого успеха: панель blocked и запись в restoreIssues", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-runtime-negative-"));
  const socketPath = join(root, "runtime.sock");
  const stateDir = join(root, "state");
  process.env["OMP_RUNTIME_SOCKET"] = socketPath;
  const missing = join(root, "session-that-never-existed.jsonl");
  const first = await startRuntime({ socketPath, stateDir });
  cleanups.push(() => first.stop());
  const created = await runtimeRequest<{ pane: { id: string } }>("pane.create", { cwd: root });
  await runtimeRequest("pane.bind", { paneId: created.pane.id, sessionFile: missing, launchArgv: ["/bin/echo", "--cwd", root] });
  await first.stop();

  const revived = await startRuntime({ socketPath, stateDir });
  cleanups.push(() => revived.stop());
  await revived.ready;
  const pane = revived.panes()[0];
  // Отрицательный контроль: неверный файл сессии НЕ должен приводить к «всё хорошо».
  expect(pane?.status).toBe("blocked");
  const health = await runtimeRequest<{ restoreIssues: Array<{ paneId: string; error: string }> }>("health");
  expect(health.restoreIssues.some((issue) => issue.paneId === pane?.id && issue.error.includes("persisted session file is missing"))).toBe(true);
});

test("argv восстановления: незнакомый аргумент отвергается, подтверждение не проигрывается", () => {
  const base = { id: "p", launchArgv: ["omp", "--cwd", "/tmp", "--allow-home"], sessionFile: "/tmp/s.jsonl" } as const;
  expect(restorationArgv({ ...base, awaitingApproval: false } as never)).toEqual(["omp", "--cwd", "/tmp", "--allow-home", "--restore", "/tmp/s.jsonl"]);
  expect(restorationArgv({ ...base, awaitingApproval: true } as never)).toEqual(["omp", "--cwd", "/tmp", "--allow-home", "--resume", "/tmp/s.jsonl"]);
  expect(() => restorationArgv({ ...base, launchArgv: ["omp", "сделай то-то"] } as never)).toThrow("unsupported persisted launch argument");
  expect(() => restorationArgv({ ...base, sessionFile: null } as never)).toThrow("session file and executable are required");
});

test("idle handover restoration waits for input and uses registry model instead of old launch model", () => {
  const base = { id: "p", launchArgv: ["omp", "--cwd", "/work/a b", "--model", "old/model", "--provider=old"], sessionFile: "/sessions/a b.jsonl", model: "current/model" };
  expect(restorationArgv({ ...base, status: "idle" } as never)).toEqual(["omp", "--cwd", "/work/a b", "--model", "current/model", "--resume", "/sessions/a b.jsonl"]);
  expect(restorationArgv({ ...base, status: "working" } as never)).toEqual(["omp", "--cwd", "/work/a b", "--model", "current/model", "--restore", "/sessions/a b.jsonl"]);
  expect(restorationArgv({ ...base, status: "blocked", awaitingApproval: true } as never)).toEqual(["omp", "--cwd", "/work/a b", "--model", "current/model", "--resume", "/sessions/a b.jsonl"]);
});

test("live registry model switch changes persisted binding and the next restoration argv", () => {
  const pane = { id: "p", paneId: "p", instanceId: "instance", sessionId: "session", sessionFile: "/s.jsonl", status: "idle", awaitingApproval: false, model: "p/A", launchArgv: ["omp", "--cwd", "/w", "--model", "p/A"] };
  const host = { instanceId: "instance", sessionId: "session", sessionFile: "/s.jsonl", busy: false, inputRequired: false, model: { provider: "p", id: "A" } };
  expect(runtimeBindingForHost(pane as never, host as never)).toBeNull();
  const binding = runtimeBindingForHost(pane as never, { ...host, model: { provider: "p", id: "B" } } as never);
  expect(binding?.model).toBe("p/B");
  expect(restorationArgv({ ...pane, ...binding } as never)).toEqual(["omp", "--cwd", "/w", "--model", "p/B", "--resume", "/s.jsonl"]);
  expect(runtimeBindingForHost({ ...pane, ...binding } as never, { ...host, model: { provider: "p", id: "B" } } as never)).toBeNull();
});

test("словарь клавиш: старые токены приложения и одиночные символы", () => {
  expect(keySequence("enter")).toBe("\r");
  expect(keySequence("ctrl+c")).toBe("\x03");
  expect(keySequence("slash")).toBe("/");
  expect(keySequence("up")).toBe("\x1b[A");
  expect(keySequence("ж")).toBe("ж");
  expect(keySequence("нет-такой")).toBeNull();
});
