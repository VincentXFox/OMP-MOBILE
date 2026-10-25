/**
 * Демон рантайма: панели OMP Pocket без herdr.
 *
 * Панель — это настоящий PTY с интерактивным bash. Агент запускается внутрь
 * панели (`pane.run` печатает команду в свободную оболочку), поэтому:
 *   • выход omp не убивает панель — остаётся оболочка, в неё можно запустить
 *     восстановление или что угодно ещё;
 *   • перезапуск ШЛЮЗА не трогает агентов (панели живут в этом процессе);
 *   • перезапуск РАНТАЙМА поднимает панели из `panes.json` и возвращает
 *     агентов тем же `--restore`/`--resume`, что и recovery-пайплайн.
 *
 * Каждая панель имеет свою очередь операций: вывод PTY, чтение экрана, ввод и
 * resize сериализуются, иначе снимок мог бы попасть между двумя половинами
 * кадра, а клавиши — перемешаться с печатью команды.
 */

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Screen } from "./screen.ts";
import { PaneStore, type StoredPane } from "./store.ts";
import { isRunning, procStat, processInfo, sameProcess } from "./process.ts";
import { keySequence } from "./keys.ts";
import {
  MAX_FRAME,
  MAX_INPUT,
  MAX_STREAM_FRAME,
  PANE_STATUSES,
  RuntimeError,
  type PaneStatus,
  type ProcessInfo,
  type RuntimeHealth,
  type RuntimePane,
  type RuntimeStreamEvent,
} from "./protocol.ts";

/** Сколько байт вывода PTY терпим, прежде чем притормозить процессы панели:
 * эмулятор экрана не должен отставать бесконечно. */
const PENDING_PAUSE_BYTES = 4 * 1024 * 1024;
const PENDING_RESUME_BYTES = 1024 * 1024;
/** Запросов в очереди на одно соединение. */
const MAX_QUEUED_PER_SOCKET = 128;
/** Ожидание готовности оболочки после старта панели. */
const SHELL_READY_MS = 5_000;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface LivePane {
  meta: StoredPane;
  screen: Screen;
  proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
  startTime: string;
  seq: number;
  queue: Promise<unknown>;
  pendingBytes: number;
  paused: number[];
  subscribers: Set<Socket>;
  shellReady: boolean;
  launchCommitted: boolean;
  stopped: boolean;
}

export interface RuntimeOptions {
  socketPath: string;
  stateDir: string;
  /** Вызывается после восстановления панели с запущенным агентом. */
  onRestored?: (pane: RuntimePane) => Promise<void> | void;
}

export interface RuntimeHandle {
  socketPath: string;
  generation: string;
  ready: Promise<void>;
  panes(): RuntimePane[];
  stop(): Promise<void>;
}

function validString(value: unknown, label: string, max = MAX_INPUT): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || value.includes("\0")) {
    throw new RuntimeError("invalid_params", `invalid ${label}`);
  }
  return value;
}

function dimension(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > 500) {
    throw new RuntimeError("invalid_params", "size must be 2..500");
  }
  return Number(value);
}

function argvValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new RuntimeError("invalid_params", "argv must be a nonempty string array");
  }
  return value.map((item) => validString(item, "argv", 8192));
}

/** Флаги запуска, которые можно повторить при восстановлении. Всё остальное —
 * позиционные промпты, старые селекторы сессии, чужие аргументы — отвергается:
 * вслепую повторять сохранённую команду нельзя. */
const VALUE_FLAGS: Record<string, true> = { "--cwd": true, "--model": true, "--thinking": true, "--provider": true, "--session-dir": true };
const BOOL_FLAGS: Record<string, true> = { "--allow-home": true };
/** Одноразовые селекторы сессии БЕЗ значения (`-c`/`--continue` значения не берут). */
const BARE_ONESHOT: Record<string, true> = { "--continue": true, "-c": true, "--no-session": true, "--from-claude": true, "--from-codex": true };
/** Одноразовые селекторы сессии СО значением. */
const VALUE_ONESHOT: Record<string, true> = { "--resume": true, "-r": true, "--restore": true, "--session": true, "--fork": true, "--goal": true };

/** Флаг и его записанное значение: `--resume=/x` и `--resume /x` — одно и то же. */
function splitFlag(arg: string): { flag: string; inlineValue: boolean } {
  const eq = arg.indexOf("=");
  if (eq > 0) return { flag: arg.slice(0, eq), inlineValue: true };
  return { flag: arg, inlineValue: false };
}

/** argv запуска без одноразовых селекторов сессии: их место при восстановлении
 * занимает свежий селектор, а повторять сохранённый вслепую нельзя. */
export function launchArgvOf(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const { flag, inlineValue } = splitFlag(arg);
    if (BARE_ONESHOT[flag] === true) continue;
    if (VALUE_ONESHOT[flag] === true) {
      if (!inlineValue) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** argv восстановления: сохранённые опции запуска + свежий селектор сессии. */
export function restorationArgv(pane: RuntimePane): string[] {
  const executable = pane.launchArgv[0];
  if (pane.sessionFile === null || executable === undefined) {
    throw new RuntimeError("restore_identity", "session file and executable are required");
  }
  const result = [executable];
  for (let i = 1; i < pane.launchArgv.length; i++) {
    const arg = pane.launchArgv[i];
    if (arg === undefined) continue;
    const { flag, inlineValue } = splitFlag(arg);
    if (BARE_ONESHOT[flag] === true) continue;
    if (VALUE_ONESHOT[flag] === true) {
      if (!inlineValue) i += 1;
      continue;
    }
    // Registry binding carries the current model; startup flags may be stale.
    if (pane.model && (flag === "--model" || flag === "--provider")) {
      if (!inlineValue) i += 1;
      continue;
    }
    if (VALUE_FLAGS[flag] === true) {
      const value = inlineValue ? arg.slice(arg.indexOf("=") + 1) : pane.launchArgv[++i];
      if (value === undefined) throw new RuntimeError("unsafe_restore_argv", `incomplete launch option ${arg}`);
      result.push(...(inlineValue ? [arg] : [arg, value]));
      continue;
    }
    if (BOOL_FLAGS[arg] === true) {
      result.push(arg);
      continue;
    }
    throw new RuntimeError("unsafe_restore_argv", `unsupported persisted launch argument at index ${i}; refusing automatic replay`);
  }
  if (pane.model) result.push("--model", pane.model);
  return [...result, pane.awaitingApproval === true || pane.status === "idle" ? "--resume" : "--restore", pane.sessionFile];
}

function safeSend(socket: Socket, frame: unknown): void {
  if (socket.destroyed) return;
  const packet = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(packet) > MAX_STREAM_FRAME || socket.writableLength > MAX_STREAM_FRAME) {
    // Медленный подписчик не должен раздувать память демона: он переподключится
    // и получит свежий снапшот.
    socket.destroy(new Error("slow runtime subscriber; resnapshot required"));
    return;
  }
  socket.write(packet);
}

function socketAlive(path: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(path);
  const timer = setTimeout(() => {
    socket.destroy();
    resolve(true);
  }, 500);
  socket.once("connect", () => {
    clearTimeout(timer);
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
  return promise;
}

export async function startRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  const store = new PaneStore(options.stateDir);
  const stored = new Map<string, StoredPane>(store.load().map((pane) => [pane.id, pane]));
  const panes = new Map<string, LivePane>();
  const clients = new Set<Socket>();
  const generation = randomUUID();
  const startedAt = Date.now();
  const health: RuntimeHealth = { version: 1, generation, pid: process.pid, startedAt, ready: false, panes: 0, restoreIssues: [] };
  let stopping = false;

  const lockPath = join(options.stateDir, "runtime.lock");
  if (existsSync(lockPath)) {
    // Битый или недописанный lock (обрыв питания, ENOSPC) — не повод для краш-лупа
    // юнита: читаем как «владельца нет» и перезабираем файл.
    let owner: { pid?: unknown; startTime?: unknown } = {};
    try {
      owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; startTime?: unknown };
    } catch {
      owner = {};
    }
    if (typeof owner.pid === "number" && typeof owner.startTime === "string" && sameProcess(owner.pid, owner.startTime)) {
      throw new Error("runtime state is already owned by a live daemon");
    }
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: procStat(process.pid)?.startTime ?? "" }));
  closeSync(lock);

  const inputrc = join(options.stateDir, "inputrc");
  writeFileSync(inputrc, "set enable-bracketed-paste on\n", { mode: 0o600 });

  const save = (): void => store.save([...stored.values()]);
  const publicPane = (pane: LivePane): RuntimePane => {
    const { desiredRunning, shellStartTime, ...rest } = pane.meta;
    return { ...rest, launchArgv: [...rest.launchArgv] };
  };
  /** Очередь панели: любые операции над PTY и экраном идут строго по одной. */
  const enqueue = <T>(pane: LivePane, fn: () => Promise<T> | T): Promise<T> => {
    const next = pane.queue.then(fn);
    pane.queue = next.catch(() => undefined);
    return next;
  };
  const emit = (pane: LivePane, event: RuntimeStreamEvent): void => {
    for (const client of pane.subscribers) safeSend(client, event);
  };

  function spawn(meta: StoredPane): LivePane {
    if (!isAbsolute(meta.cwd) || !statSync(meta.cwd).isDirectory()) {
      throw new RuntimeError("invalid_cwd", "pane cwd is not an absolute directory");
    }
    const screen = new Screen(meta.cols, meta.rows);
    // Готовность оболочки ловим собственным OSC-маркером в PROMPT_COMMAND: так
    // «оболочка свободна» — факт из потока PTY, а не догадка по таймауту.
    const token = randomUUID();
    const pane = {} as LivePane;
    screen.terminal.parser.registerOscHandler(777, (value) => {
      if (value !== token) return false;
      pane.shellReady = true;
      pane.launchCommitted = false;
      pane.meta.status = "shell";
      return true;
    });
    screen.terminal.onTitleChange((title) => {
      meta.title = title.slice(0, 256);
    });
    const proc = Bun.spawn(["/bin/bash", "--noprofile", "--norc", "-i"], {
      cwd: meta.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PS1: "$ ",
        PS2: "> ",
        PROMPT_COMMAND: `printf '\\033]777;${token}\\007'`,
        INPUTRC: inputrc,
        HISTFILE: "/dev/null",
      },
      terminal: {
        cols: meta.cols,
        rows: meta.rows,
        name: "xterm-256color",
        data(_terminal, bytes) {
          const copy = Uint8Array.from(bytes);
          pane.pendingBytes += copy.byteLength;
          if (pane.pendingBytes > PENDING_PAUSE_BYTES && pane.paused.length === 0) {
            for (const child of processInfo(pane.proc.pid, pane.startTime).foreground_processes) {
              try {
                process.kill(child.pid, "SIGSTOP");
                pane.paused.push(child.pid);
              } catch {
                // процесс уже завершился
              }
            }
          }
          void enqueue(pane, async () => {
            try {
              const text = await screen.write(copy);
              if (text !== "") emit(pane, { event: "data", paneId: meta.id, seq: ++pane.seq, data: { text } });
            } finally {
              pane.pendingBytes -= copy.byteLength;
              if (pane.pendingBytes < PENDING_RESUME_BYTES && pane.paused.length > 0) {
                for (const pid of pane.paused) {
                  try {
                    process.kill(pid, "SIGCONT");
                  } catch {
                    // уже мёртв
                  }
                }
                pane.paused = [];
              }
            }
          });
        },
      },
    });
    meta.shellPid = proc.pid;
    meta.shellStartTime = procStat(proc.pid)?.startTime ?? "";
    meta.status = "starting";
    meta.instanceId = null;
    Object.assign(pane, {
      meta,
      screen,
      proc,
      startTime: meta.shellStartTime,
      seq: 0,
      queue: Promise.resolve() as Promise<unknown>,
      pendingBytes: 0,
      paused: [] as number[],
      subscribers: new Set<Socket>(),
      shellReady: false,
      launchCommitted: false,
      stopped: false,
    } satisfies LivePane);
    panes.set(meta.id, pane);
    stored.set(meta.id, meta);
    void proc.exited.then((code) =>
      enqueue(pane, () => {
        if (pane.stopped) return;
        pane.shellReady = false;
        pane.meta.status = "closed";
        // Оболочка вышла (exit/Ctrl-D): панели больше нет, и восстанавливать
        // нечего — иначе рестарт демона воскрешал бы её вместе с агентом.
        pane.meta.desiredRunning = false;
        emit(pane, { event: "exit", paneId: meta.id, seq: ++pane.seq, data: { code } });
        panes.delete(meta.id);
        stored.delete(meta.id);
        if (!stopping) save();
      }),
    );
    return pane;
  }

  async function shellReady(pane: LivePane): Promise<void> {
    const end = Date.now() + SHELL_READY_MS;
    while (!pane.shellReady && !pane.stopped) {
      if (Date.now() > end) throw new RuntimeError("shell_busy", "shell is not ready");
      await Bun.sleep(10);
    }
    if (pane.stopped) throw new RuntimeError("pane_closed", "pane is closed");
  }

  function write(pane: LivePane, value: string): void {
    if (pane.stopped || pane.proc.terminal?.closed === true) throw new RuntimeError("pane_closed", "PTY is closed");
    pane.proc.terminal?.write(value);
  }

  async function run(pane: LivePane, params: Record<string, unknown>): Promise<unknown> {
    const sessionFile = params["sessionFile"] === undefined || params["sessionFile"] === null ? null : validString(params["sessionFile"], "sessionFile", 4096);
    if (sessionFile !== null) {
      // Та же сессия не должна подниматься дважды: это второй агент на одном
      // файле сессии (гонка восстановления), а не «ещё одна панель».
      const existing = [...panes.values()].find(
        (other) => other !== pane && other.meta.sessionFile === sessionFile && !other.stopped && (other.launchCommitted || !other.shellReady),
      );
      if (existing !== undefined) return { ok: true, alreadyRunning: true, paneId: existing.meta.id };
    }
    if (pane.launchCommitted) throw new RuntimeError("shell_busy", "pane already has a pending launch");
    await shellReady(pane);
    return enqueue(pane, () => {
      const info: ProcessInfo = processInfo(pane.proc.pid, pane.startTime);
      if (!pane.shellReady || pane.launchCommitted || (info.foreground_process_group_id !== null && info.foreground_process_group_id !== pane.proc.pid)) {
        throw new RuntimeError("shell_busy", "pane has an active foreground process");
      }
      if ((params["argv"] === undefined) === (params["command"] === undefined)) {
        throw new RuntimeError("invalid_params", "provide exactly one of argv or command");
      }
      const argv = params["argv"] === undefined ? null : argvValue(params["argv"]);
      const command = argv === null ? validString(params["command"], "command") : argv.map(quote).join(" ");
      if (command.includes("\n") || command.includes("\r")) {
        throw new RuntimeError("invalid_params", "run command must be one line");
      }
      if (argv !== null) pane.meta.launchArgv = launchArgvOf(argv);
      if (sessionFile !== null) pane.meta.sessionFile = sessionFile;
      pane.meta.status = "starting";
      pane.shellReady = false;
      pane.launchCommitted = true;
      save();
      // Сначала чистим строку ввода оболочки (Ctrl-U), потом печатаем ровно одну
      // экранированную команду: позиционный промпт так в аргументы не просочится.
      write(pane, `\x15${command}\r`);
      return { ok: true };
    });
  }

  async function terminate(pane: LivePane): Promise<void> {
    if (pane.stopped) return;
    pane.stopped = true;
    for (const pid of pane.paused) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // уже мёртв
      }
    }
    pane.paused = [];
    // Дерево снимаем ДО сигналов: как только оболочка умрёт, /proc перестанет
    // показывать её детей, и SIGKILL ушёл бы в пустоту — агент остался бы жить
    // без PTY (проверено вживую: `omp` переживал закрытие панели).
    const targets = processInfo(pane.proc.pid, pane.startTime)
      .foreground_processes.map((proc) => proc.pid)
      .reverse();
    for (const pid of targets) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // уже мёртв
      }
    }
    pane.proc.terminal?.close();
    await Promise.race([pane.proc.exited, Bun.sleep(1000)]);
    for (const pid of targets) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // уже мёртв
      }
    }
    await pane.queue;
    // Смерть процесса видна не мгновенно (SIGKILL + переуборка зомби), поэтому
    // даём секунду и только потом сообщаем о выжившем.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!targets.some((pid) => isRunning(pid))) break;
      await Bun.sleep(100);
    }
    const survived = targets.filter((pid) => isRunning(pid));
    if (survived.length > 0) console.error(`[runtime] панель ${pane.meta.id}: процессы дерева пережили закрытие: ${survived.join(", ")} (отвязавшиеся через setsid в дерево не входят)`);
    pane.screen.dispose();
    for (const client of pane.subscribers) client.end();
  }

  async function dispatch(method: string, params: Record<string, unknown>, socket: Socket): Promise<unknown> {
    if (method === "health") {
      health.panes = panes.size;
      return { ...health };
    }
    if (method === "pane.list") {
      return { panes: [...panes.values()].filter((pane) => !pane.stopped).map(publicPane) };
    }
    if (method === "pane.create") {
      const cwd = validString(params["cwd"], "cwd", 4096);
      if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) {
        throw new RuntimeError("invalid_cwd", "cwd must be an existing absolute directory");
      }
      const meta: StoredPane = {
        id: randomUUID(),
        name: params["name"] === undefined ? "terminal" : validString(params["name"], "name", 256),
        cwd: resolve(cwd),
        shellPid: 0,
        cols: dimension(params["cols"], 100),
        rows: dimension(params["rows"], 30),
        createdAt: Date.now(),
        title: null,
        sessionId: null,
        instanceId: null,
        sessionFile: null,
        launchArgv: [],
        status: "starting",
        desiredRunning: true,
        shellStartTime: "",
      };
      const pane = spawn(meta);
      save();
      await shellReady(pane);
      return { pane: publicPane(pane) };
    }
    const id = validString(params["paneId"], "paneId", 128);
    const pane = panes.get(id);
    if (pane === undefined || pane.stopped) throw new RuntimeError("pane_not_found", "pane not found");
    switch (method) {
      case "pane.get":
        return { pane: publicPane(pane) };
      case "pane.processInfo":
        return { process_info: processInfo(pane.proc.pid, pane.startTime) };
      case "pane.run":
        return run(pane, params);
      case "pane.read":
        return enqueue(pane, () => {
          const lines = params["lines"] === undefined ? pane.meta.rows : Number(params["lines"]);
          if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new RuntimeError("invalid_params", "invalid lines");
          const format = params["format"] === undefined ? "text" : String(params["format"]);
          if (format !== "text" && format !== "ansi") throw new RuntimeError("invalid_params", "invalid format");
          const source = params["source"] === undefined ? "visible" : String(params["source"]);
          if (source !== "visible" && source !== "recent") throw new RuntimeError("invalid_params", "invalid source");
          return {
            text: format === "ansi" ? pane.screen.ansi() : pane.screen.text(source as "visible" | "recent", lines),
            revision: pane.seq,
          };
        });
      case "pane.attach":
        return enqueue(pane, () => {
          safeSend(socket, {
            event: "snapshot",
            paneId: id,
            seq: pane.seq,
            data: { ansi: pane.screen.ansi(), cols: pane.meta.cols, rows: pane.meta.rows, generation },
          });
          pane.subscribers.add(socket);
          socket.once("close", () => pane.subscribers.delete(socket));
          return { ok: true };
        });
      case "pane.input":
        return enqueue(pane, () => {
          const provided = [params["text"], params["keys"], params["data"]].filter((value) => value !== undefined);
          if (provided.length !== 1) throw new RuntimeError("invalid_params", "provide text, keys or raw data");
          let data: string;
          if (params["keys"] !== undefined) {
            const keys = params["keys"];
            if (!Array.isArray(keys) || keys.length === 0 || keys.length > 128) throw new RuntimeError("invalid_params", "invalid keys");
            data = keys
              .map((key) => {
                if (typeof key !== "string") throw new RuntimeError("invalid_key", "key must be a string");
                const sequence = keySequence(key);
                if (sequence === null) throw new RuntimeError("invalid_key", `unsupported key: ${key}`);
                return sequence;
              })
              .join("");
          } else if (params["text"] !== undefined) {
            // Литеральный текст идёт bracketed paste: многострочный ввод не должен
            // превращаться в набор shell-команд, а ESC в тексте — в управление.
            const text = validString(params["text"], "text");
            if (text.includes("\x1b")) throw new RuntimeError("invalid_params", "literal paste may not contain ESC");
            data = `\x1b[200~${text}\x1b[201~`;
          } else {
            data = validString(params["data"], "data");
          }
          write(pane, data);
          return { ok: true };
        });
      case "pane.resize":
        return enqueue(pane, () => {
          const cols = dimension(params["cols"], pane.meta.cols);
          const rows = dimension(params["rows"], pane.meta.rows);
          pane.proc.terminal?.resize(cols, rows);
          pane.screen.resize(cols, rows);
          pane.meta.cols = cols;
          pane.meta.rows = rows;
          save();
          emit(pane, { event: "resize", paneId: id, seq: ++pane.seq, data: { cols, rows } });
          return { ok: true };
        });
      case "pane.rename":
        pane.meta.name = validString(params["name"], "name", 256);
        save();
        return { ok: true };
      case "pane.bind": {
        const next = { ...pane.meta };
        for (const field of ["sessionId", "instanceId", "sessionFile", "model"] as const) {
          if (params[field] === undefined) continue;
          next[field] = params[field] === null ? null : validString(params[field], field, 4096);
        }
        if (next.sessionFile !== null) {
          if (!isAbsolute(next.sessionFile)) throw new RuntimeError("invalid_params", "sessionFile must be absolute");
          const other = [...panes.values()].find((candidate) => candidate !== pane && !candidate.stopped && candidate.meta.sessionFile === next.sessionFile);
          if (other !== undefined) throw new RuntimeError("session_owned", "session already belongs to another pane");
        }
        if (params["launchArgv"] !== undefined) {
          // Пустой список — законное значение: «панель без агента», восстанавливать нечего.
          const argv = params["launchArgv"];
          if (!Array.isArray(argv) || argv.length > 128) throw new RuntimeError("invalid_params", "launchArgv must be a string array");
          next.launchArgv = argv.map((item) => validString(item, "launchArgv", 8192));
        }
        if (params["awaitingApproval"] !== undefined) {
          if (typeof params["awaitingApproval"] !== "boolean") throw new RuntimeError("invalid_params", "awaitingApproval must be boolean");
          next.awaitingApproval = params["awaitingApproval"];
        }
        if (params["restoredAt"] !== undefined) {
          if (params["restoredAt"] !== null && typeof params["restoredAt"] !== "number") throw new RuntimeError("invalid_params", "restoredAt must be number or null");
          next.restoredAt = params["restoredAt"] as number | null;
        }
        if (params["status"] !== undefined) {
          const status = String(params["status"]);
          if (!(PANE_STATUSES as readonly string[]).includes(status)) throw new RuntimeError("invalid_params", "invalid status");
          next.status = status as PaneStatus;
        }
        Object.assign(pane.meta, next);
        save();
        return { ok: true };
      }
      case "pane.close":
        pane.meta.desiredRunning = false;
        pane.meta.status = "closed";
        await terminate(pane);
        // Закрытая панель не нужна никому: PTY мёртв, процессов нет. Держим
        // panes.json ограниченным, а listPanes — честным списком живых панелей.
        panes.delete(id);
        stored.delete(id);
        save();
        return { ok: true };
      default:
        throw new RuntimeError("unknown_method", "unknown runtime method");
    }
  }

  const server = createServer((socket) => {
    clients.add(socket);
    let pending = Buffer.alloc(0);
    let requests: Promise<unknown> = Promise.resolve();
    let queued = 0;
    socket.on("error", () => undefined);
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      for (let nl = pending.indexOf(10); nl >= 0; nl = pending.indexOf(10)) {
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        let request: { id: string; method: string; params: Record<string, unknown> };
        try {
          const parsed = JSON.parse(line.toString("utf8")) as typeof request;
          if (
            parsed === null ||
            typeof parsed.id !== "string" ||
            parsed.id.length > 128 ||
            typeof parsed.method !== "string" ||
            parsed.params === null ||
            typeof parsed.params !== "object" ||
            Array.isArray(parsed.params)
          ) {
            throw new Error("bad frame");
          }
          request = parsed;
        } catch {
          socket.destroy();
          return;
        }
        if (++queued > MAX_QUEUED_PER_SOCKET) {
          socket.destroy();
          return;
        }
        requests = requests.then(async () => {
          try {
            const result = await dispatch(request.method, request.params, socket);
            safeSend(socket, { id: request.id, ok: true, result });
          } catch (error) {
            safeSend(socket, {
              id: request.id,
              ok: false,
              error: {
                code: error instanceof RuntimeError ? error.code : "runtime_error",
                message: error instanceof Error ? error.message : "runtime operation failed",
              },
            });
          } finally {
            queued -= 1;
          }
        });
      }
    });
  });

  try {
    mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(options.socketPath)) {
      if (!lstatSync(options.socketPath).isSocket() || (await socketAlive(options.socketPath))) {
        throw new Error("runtime socket already in use");
      }
      unlinkSync(options.socketPath);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      chmodSync(options.socketPath, 0o600);
      resolve();
    });
    await promise;
  } catch (error) {
    unlinkSync(lockPath);
    throw error;
  }

  // Восстановление панелей: PTY поднимается заново, агент возвращается тем же
  // селектором сессии. Живой процесс прошлого демона означает, что мы не одни
  // владеем панелью — такую панель помечаем blocked, а не запускаем вторую копию.
  const ready = (async () => {
    for (const meta of stored.values()) {
      if (!meta.desiredRunning) continue;
      try {
        if (meta.shellPid > 0 && sameProcess(meta.shellPid, meta.shellStartTime)) {
          throw new Error("prior PTY process still alive; operator reconciliation required");
        }
        const idle = meta.status === "idle";
        const passive = idle || meta.awaitingApproval === true;
        const pane = spawn(meta);
        await shellReady(pane);
        if (meta.launchArgv.length > 0) {
          // Селектор сессии нужен только когда есть файл сессии. У агента, не
          // сделавшего ни одного хода, файла нет — его возвращаем той же командой
          // запуска: терять нечего, а агент снова живой.
          const argv =
            meta.sessionFile === null
              ? [...meta.launchArgv]
              : (() => {
                  // existsSync до statSync: пропавший файл должен дать понятную
                  // причину, а не ENOENT из недр stat.
                  const file = meta.sessionFile as string;
                  if (!existsSync(file) || !statSync(file).isFile()) throw new Error("persisted session file is missing");
                  return restorationArgv({ ...meta, ...(idle ? { status: "idle" as const } : {}) });
                })();
          await run(pane, { argv, ...(meta.sessionFile === null ? {} : { sessionFile: meta.sessionFile }) });
          const end = Date.now() + 20_000;
          while (processInfo(pane.proc.pid, pane.startTime).foreground_processes.length <= 1) {
            if (Date.now() > end) throw new Error("restored child did not start");
            await Bun.sleep(50);
          }
          const child = processInfo(pane.proc.pid, pane.startTime).foreground_processes.find((proc) => proc.pid !== pane.proc.pid);
          console.log(`[runtime] панель ${pane.meta.id}: агент поднят (pid ${child?.pid ?? "?"}, ${child?.name ?? "?"})`);
          // Метка восстановления: шлюз по ней понимает, что сессия вернулась
          // после рестарта рантайма и турн надо дослать (continueAfterRestore).
          meta.restoredAt = passive ? null : Date.now();
          save();
          if (!passive) await options.onRestored?.(publicPane(pane));
        }
      } catch (error) {
        meta.status = "blocked";
        const message = error instanceof Error ? error.message : "restore failed";
        health.restoreIssues.push({ paneId: meta.id, sessionFile: meta.sessionFile, error: message });
        console.error(`[runtime] панель ${meta.id} не восстановлена: ${message}`);
      }
    }
    save();
    health.panes = panes.size;
    health.ready = true;
  })();

  return {
    socketPath: options.socketPath,
    generation,
    ready,
    panes: () => [...panes.values()].map(publicPane),
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      await ready;
      save();
      for (const client of clients) client.destroy();
      await Promise.all([...panes.values()].map((pane) => terminate(pane)));
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
      if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    },
  };
}
