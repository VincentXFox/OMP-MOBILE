/**
 * Клиент рантайма для шлюза: построчный JSON-RPC по unix-сокету.
 *
 * Каждый запрос — отдельное соединение (просто и без состояния), подписка на
 * панель — долгоживущее соединение со строгим порядком кадров: `snapshot` со
 * `seq`, затем только `seq+1`. Разрыв нумерации означает, что приложение должно
 * переподключиться и взять свежий снапшот — потерянный кадр терминала хуже
 * повторной отрисовки.
 */

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { MAX_FRAME, MAX_STREAM_FRAME, RuntimeError, runtimeSocketPath, type RuntimeHealth, type RuntimePane, type RuntimeStreamEvent } from "./protocol.ts";

export type { RuntimePane, RuntimeStreamEvent, RuntimeHealth, ProcessInfo } from "./protocol.ts";

/** Сколько ждём ответа по умолчанию. Операции панели (запуск команды, ввод)
 * живут дольше: у них свои таймауты на стороне вызова. */
const DEFAULT_TIMEOUT_MS = 10_000;

function readFrames(socket: Socket, onFrame: (frame: Record<string, unknown>) => void, onError: (error: Error) => void): void {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_STREAM_FRAME) {
      onError(new Error("runtime frame too large"));
      socket.destroy();
      return;
    }
    for (let nl = pending.indexOf(10); nl >= 0; nl = pending.indexOf(10)) {
      const line = pending.subarray(0, nl);
      pending = pending.subarray(nl + 1);
      try {
        onFrame(JSON.parse(line.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        onError(error instanceof Error ? error : new Error("invalid runtime frame"));
        socket.destroy();
        return;
      }
    }
  });
}

export function runtimeRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const id = randomUUID();
  const packet = `${JSON.stringify({ id, method, params })}\n`;
  if (Buffer.byteLength(packet) > MAX_FRAME) {
    reject(new RuntimeError("request_too_large", "runtime request too large"));
    return promise;
  }
  const socket = connect(runtimeSocketPath());
  let settled = false;
  const finish = (error?: Error, value?: T): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (error !== undefined) reject(error);
    else resolve(value as T);
  };
  const timer = setTimeout(() => finish(new RuntimeError("timeout", `runtime ${method} timed out; result may be uncertain`)), timeoutMs);
  socket.on("connect", () => socket.write(packet));
  socket.on("error", (error: Error) => finish(error));
  socket.on("close", () => finish(new RuntimeError("disconnected", "runtime disconnected")));
  readFrames(
    socket,
    (frame) => {
      if (frame["id"] !== id) return;
      if (frame["ok"] === true) {
        finish(undefined, frame["result"] as T);
        return;
      }
      const error = frame["error"] as { code?: unknown; message?: unknown } | undefined;
      finish(new RuntimeError(typeof error?.code === "string" ? error.code : "runtime_error", typeof error?.message === "string" ? error.message : "runtime request failed"));
    },
    (error) => finish(error),
  );
  return promise;
}

export interface RuntimeSubscription {
  close(): void;
}

export function runtimeSubscribe(
  paneId: string,
  onEvent: (event: RuntimeStreamEvent) => void,
  onClose?: (error?: Error) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RuntimeSubscription> {
  const { promise, resolve, reject } = Promise.withResolvers<RuntimeSubscription>();
  const socket = connect(runtimeSocketPath());
  const id = randomUUID();
  let ready = false;
  let closed = false;
  let lastSeq = -1;
  const timer = setTimeout(() => fail(new Error("runtime attach timeout")), timeoutMs);
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket.destroy();
  };
  const fail = (error: Error): void => {
    if (closed) return;
    close();
    if (ready) onClose?.(error);
    else reject(error);
  };
  socket.on("connect", () => socket.write(`${JSON.stringify({ id, method: "pane.attach", params: { paneId } })}\n`));
  socket.on("error", fail);
  socket.on("close", () => {
    if (!closed) fail(new Error("runtime subscription disconnected; resnapshot required"));
  });
  readFrames(
    socket,
    (frame) => {
      if (frame["id"] === id && frame["ok"] === false) {
        const error = frame["error"] as { code?: unknown; message?: unknown } | undefined;
        fail(new RuntimeError(typeof error?.code === "string" ? error.code : "runtime_error", typeof error?.message === "string" ? error.message : "attach failed"));
        return;
      }
      if (frame["event"] === undefined) return;
      const seq = frame["seq"];
      const event = frame["event"];
      if (frame["paneId"] !== paneId || (!ready && event !== "snapshot") || (ready && seq !== lastSeq + 1)) {
        fail(new Error("runtime sequence gap; resnapshot required"));
        return;
      }
      lastSeq = typeof seq === "number" ? seq : lastSeq;
      onEvent(frame as unknown as RuntimeStreamEvent);
      if (!ready) {
        ready = true;
        clearTimeout(timer);
        resolve({ close });
      }
    },
    fail,
  );
  return promise;
}

/** Доступен ли рантайм: проба для health/апдейтера, не бросает. */
export async function probeRuntime(timeoutMs = 5_000): Promise<{ ok: boolean; detail: string; health?: RuntimeHealth }> {
  try {
    const health = await runtimeRequest<RuntimeHealth>("health", {}, timeoutMs);
    const detail = `pid ${health.pid}, панелей ${health.panes}${health.restoreIssues.length > 0 ? `, проблем восстановления ${health.restoreIssues.length}` : ""}`;
    return { ok: health.ready, detail, health };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
