/**
 * Демон рантайма в chaos-мире: тест и фейковый `systemctl` поднимают и гасят
 * НАСТОЯЩИЙ `bun gateway/runtime/main.ts`, а не подделку — иначе сценарии
 * проверяли бы фейк, а не тот код, что работает в проде.
 *
 * RPC здесь свой, минимальный: клиент шлюза берёт сокет из env своего процесса, а
 * тесту нужно адресовать сокет конкретного chaos-корня, которых в прогоне много.
 */

import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";

export interface RuntimeDaemonSpec {
  /** Сокет демона (`OMP_RUNTIME_SOCKET`): по нему его ищут шлюз и апдейтер. */
  socket: string;
  /** Каталог состояния демона (`OMP_RUNTIME_STATE_DIR`): там `panes.json` и lock. */
  stateDir: string;
  /** Интерпретатор и точка входа демона. */
  bun: string;
  main: string;
  /** Лог демона: он переживает тест, поэтому пишем в файл, а не в никуда. */
  logPath: string;
  /** Env мира для панелей демона (HOME, PATH, OMP_CHAOS_ROOT, …). */
  env: Record<string, string>;
}

/** Живой (не зомби) процесс: зомби ещё занимает pid, но уже не работает.
 * `kill(pid, 0)` на нём успешен, поэтому проверяем состояние в /proc. */
function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Запуск демона. Готовности НЕ ждём: её ждёт `waitRuntimeHealth` — как боевой
 * `waitRuntimeReady` после `systemctl restart` (демон поднимается секундами позже). */
export function spawnRuntimeDaemon(spec: RuntimeDaemonSpec, delayMs = 0): number {
  const logFd = openSync(spec.logPath, "a", 0o600);
  const start = `${quote(spec.bun)} ${quote(spec.main)}`;
  // `exec` оставляет тот же pid, поэтому записанный pid — сразу pid демона.
  const command = delayMs > 0 ? `sleep ${(delayMs / 1000).toFixed(2)}; exec ${start}` : `exec ${start}`;
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    env: { ...process.env, ...spec.env, OMP_RUNTIME_SOCKET: spec.socket, OMP_RUNTIME_STATE_DIR: spec.stateDir },
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
  });
  proc.unref();
  closeSync(logFd);
  return proc.pid;
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, name);
  } catch {
    // уже мёртв
  }
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running(pid) && Date.now() < deadline) await Bun.sleep(50);
  return !running(pid);
}

/** Остановка демона: SIGTERM (он штатно гасит панели и снимает сокет), затем SIGKILL. */
export async function stopRuntimeDaemon(pid: number, timeoutMs = 8_000): Promise<void> {
  if (!running(pid)) return;
  signal(pid, "SIGTERM");
  if (await waitExit(pid, timeoutMs)) return;
  signal(pid, "SIGKILL");
  await waitExit(pid, 2_000);
}

/** Замок вокруг правки файла мира: пишут несколько процессов сразу, запись —
 * read-modify-write целого файла, поэтому без замка часть правок терялась бы. */
export function withFileLock<T>(lockPath: string, work: () => T): T {
  const deadline = Date.now() + 5_000;
  let fd = 0;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`chaos: замок ${lockPath} не освободился за 5 с`);
      Bun.sleepSync(5);
    }
  }
  try {
    return work();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

let callSeq = 0;

/** RPC к конкретному сокету: тест общается с рантаймом своего корня. */
export function runtimeCall<T = unknown>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const id = `chaos-${process.pid}-${(callSeq += 1)}`;
  const client = connect(socketPath);
  let pending = Buffer.alloc(0);
  let settled = false;
  const finish = (error?: Error, value?: T): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.destroy();
    if (error !== undefined) reject(error);
    else resolve(value as T);
  };
  const timer = setTimeout(() => finish(new Error(`рантайм ${method}: нет ответа за ${timeoutMs} мс`)), timeoutMs);
  client.on("connect", () => client.write(`${JSON.stringify({ id, method, params })}\n`));
  client.on("error", (error: Error) => finish(error));
  client.on("close", () => finish(new Error(`рантайм ${method}: соединение закрыто`)));
  client.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let nl = pending.indexOf(10); nl >= 0; nl = pending.indexOf(10)) {
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      let frame: { id?: string; ok?: boolean; result?: T; error?: { message?: string } };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        finish(new Error(`рантайм ${method}: битый кадр`));
        return;
      }
      if (frame.id !== id) continue;
      if (frame.ok === true) finish(undefined, frame.result as T);
      else finish(new Error(frame.error?.message ?? "запрос рантайма отклонён"));
      return;
    }
  });
  return promise;
}

/** Готовность демона: сокет отвечает на health. */
export async function waitRuntimeHealth(socketPath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await runtimeCall<{ ready: boolean }>(socketPath, "health", {}, 2_000);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`демон рантайма не ответил на ${socketPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await Bun.sleep(50);
    }
  }
}

/** Спецификация демона из env процесса-драйвера (фейковый `systemctl` наследует
 * env оркестратора, поэтому пути к bun и к `main.ts` приходят переменными). */
export function runtimeSpecFromEnv(): RuntimeDaemonSpec {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`chaos: не задан ${name}`);
    return value;
  };
  return {
    socket: required("OMP_RUNTIME_SOCKET"),
    stateDir: required("OMP_RUNTIME_STATE_DIR"),
    bun: required("OMP_CHAOS_BUN"),
    main: required("OMP_CHAOS_RUNTIME_MAIN"),
    logPath: required("OMP_CHAOS_RUNTIME_LOG"),
    env: {},
  };
}
