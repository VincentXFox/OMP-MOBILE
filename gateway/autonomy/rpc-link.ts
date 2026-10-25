import type { UsageDelta } from "./budget.ts";
import type { AgentLink, ApprovalRequest, LinkFactory, TurnOutcome } from "./links.ts";
import type { Task } from "./types.ts";

/**
 * Настоящая связь с omp: процесс `omp --mode rpc-ui` и NDJSON по stdio.
 *
 * Почему rpc-ui, а не rpc: в `--mode rpc` у расширений `ctx.hasUI=false`, и
 * запросы на approval не отправляются вовсе — инструменты падают fail-closed
 * ещё до того, как контроллер увидит вопрос. `rpc-ui` включает extension-UI, и
 * approval приходит кадром `extension_ui_request`. `--no-ui` тоже не передаём:
 * он выключает extension UI (tool UI при этом остаётся), а approval-диалоги идут
 * именно через extension runner и без него fail-closed.
 *
 * Протокол остаётся v1: negotiate_protocol не шлём. В v2 крупные кадры приходят
 * кусками base64 (`rpc_chunk`), а нам нужен простой построчный JSON; в v1
 * гигантское событие просто усечётся, а ответ на команду станет success:false.
 *
 * Проверено живьём на omp v18.10.4: первый кадр — `{"type":"ready"}`,
 * `get_session_stats` отдаёт `tokens: {input,output,reasoning,cacheRead,cacheWrite,total}`
 * и `cost` в долларах, `get_state` — `isSettled`/`isStreaming`/`contextUsage`.
 */

/** Расход хода: счётчики omp плюс стоимость, которую посчитал сам omp.
 *  `TurnOutcome.usage` типизирован как `UsageDelta`, поэтому стоимость читается
 *  как `(outcome.usage as TurnUsage).costUsd` — контроллеру она нужна для бюджета. */
export interface TurnUsage extends UsageDelta {
  /** $ за ход по подсчёту omp (дельта `get_session_stats.cost`). */
  costUsd: number;
}

export interface OmpRpcLinkOptions {
  /** Путь к бинарю omp; по умолчанию ищется в PATH. */
  bin?: string;
  /** Рабочий каталог задачи (`--cwd`). */
  cwd: string;
  /** Модель (`--model`). */
  model: string;
  /** Сколько ждём кадр ready. */
  readyTimeoutMs?: number;
  /** Таймаут одной команды протокола (abort, get_session_stats, ...). */
  commandTimeoutMs?: number;
  /** Таймаут хода целиком (модель может работать долго). */
  turnTimeoutMs?: number;
  /** Сколько ждём выхода процесса после закрытия stdin. */
  closeTimeoutMs?: number;
}

type Json = Record<string, any>;
type ResolvedOptions = Required<Omit<OmpRpcLinkOptions, "bin">> & { bin: string };
type StdinSink = NonNullable<Bun.Subprocess<"pipe", "pipe", "pipe">["stdin"]>;

const READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 15 * 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** Сколько ещё ждём terminal `agent_end`, если `prompt_result` уже пришёл.
 *  По документации yield-кадр `agent_end` пишется ДО `prompt_result`, так что
 *  это только страховка от потерянного кадра; без неё ход ждал бы 15 минут. */
const END_GRACE_MS = 10_000;
/** Хвост stderr для диагностики: весь лог процесса не нужен и не должен расти. */
const STDERR_TAIL_BYTES = 8_192;
/** Текст упавшего инструмента режем: в отчёте нужна суть, а не мегабайт вывода. */
const TOOL_FAILURE_MAX = 400;

/** Транспорт/таймаут. Отличается от «модель ответила ошибкой»: здесь связь мертва. */
class RpcTransportError extends Error {
  readonly kind: "timeout" | "exit" | "protocol";

  constructor(kind: "timeout" | "exit" | "protocol", message: string) {
    super(message);
    this.kind = kind;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new RpcTransportError("timeout", `${what}: таймаут ${ms} мс`)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Число из JSON, если это действительно число (а не строка/undefined). */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Текст любого сообщения (assistant/toolResult) — строка или блоки контента. */
function textOf(message: Json | null | undefined): string {
  if (message === null || message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

/** Однострочный хвост для отчёта: в toolFailures не должно быть простыни вывода. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Расход одного сообщения ассистента — запасной путь, если stats недоступны
 *  (или внезапно отдали нули, хотя модель явно работала). */
function usageOfMessage(message: Json | null | undefined): { usage: UsageDelta; cost: number } | null {
  const usage = message?.usage;
  if (usage === null || typeof usage !== "object") return null;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return {
    usage: {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead ?? 0,
      cacheWriteTokens: cacheWrite ?? 0,
    },
    cost: num(usage.cost?.total) ?? num(usage.cost) ?? 0,
  };
}

/** Токены/стоимость из ответа get_session_stats (v18: data.tokens + data.cost). */
function readStats(data: Json | null | undefined): { usage: UsageDelta; cost: number } | null {
  if (data === null || typeof data !== "object") return null;
  const tokens = (data.tokens ?? data.usage?.tokens ?? data.usage) as Json | undefined;
  if (tokens === null || typeof tokens !== "object") return null;
  const input = num(tokens.input) ?? num(tokens.inputTokens);
  const output = num(tokens.output) ?? num(tokens.outputTokens);
  const cacheRead = num(tokens.cacheRead) ?? num(tokens.cacheReadTokens);
  const cacheWrite = num(tokens.cacheWrite) ?? num(tokens.cacheWriteTokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return {
    usage: {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead ?? 0,
      cacheWriteTokens: cacheWrite ?? 0,
    },
    cost: num(data.cost) ?? num(data.usage?.cost) ?? 0,
  };
}

/** Метка варианта в approval-селекте. Метки не распознаны — null (=> отмена):
 *  угадывать «разрешить» нельзя, цена ошибки выше лишнего вопроса человеку. */
function pickOption(options: string[], decision: "allow" | "deny"): string | null {
  const re = decision === "allow" ? /^(?:ap+rove|allow|yes|y|да)\b/i : /^(?:deny|reject|no|n|нет|cancel)\b/i;
  for (const option of options) {
    if (re.test(option.trim())) return option;
  }
  return null;
}

function toApprovalRequest(frame: Json): ApprovalRequest {
  const rawTitle = typeof frame.title === "string" ? frame.title : "";
  // omp кладёт в title весь текст вопроса: первая строка — суть, дальше детали
  // (у approval: "Allow tool: bash\n<команда/причина>").
  const nl = rawTitle.indexOf("\n");
  const title = (nl >= 0 ? rawTitle.slice(0, nl) : rawTitle).trim();
  let detail = nl >= 0 ? rawTitle.slice(nl + 1).trim() : "";
  if (detail.length === 0 && typeof frame.message === "string") detail = frame.message;
  if (detail.length === 0 && Array.isArray(frame.options)) {
    detail = frame.options.filter((o: unknown): o is string => typeof o === "string").join(" / ");
  }
  return { id: String(frame.id), title: title.length > 0 ? title : "Требуется разрешение", detail };
}

interface StatsSnapshot {
  usage: UsageDelta;
  cost: number;
}

/**
 * Связь на один процесс omp. Один процесс — одна задача: у неё свой cwd, своя
 * модель и своя история; так ходы не смешиваются, а kill задачи не задевает соседей.
 */
export class OmpRpcLink implements AgentLink {
  #opts: ResolvedOptions;
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  #stdin: StdinSink | null = null;
  #alive = false;
  #exitCode: number | null = null;
  #stderrTail = "";
  #writeChain: Promise<void> = Promise.resolve();
  #readyDeferred: { resolve: () => void; reject: (err: Error) => void } | null = null;
  #ready = false;
  #seq = 0;
  #idSeq = 0;

  /** Ответы команд по id. */
  #pending = new Map<string, { resolve: (frame: Json) => void; reject: (err: Error) => void }>();
  /** `prompt_result` по id — единственный кадр, который знает, чей это ход. */
  #promptResults = new Map<string, { resolve: (frame: Json) => void; reject: (err: Error) => void }>();
  /** Ожидающие terminal `agent_end` (у кадра нет id, поэтому ждём «следующий»). */
  #endWaiters = new Set<(frame: Json) => void>();
  #lastTerminalEnd: { frame: Json; seq: number } | null = null;

  /** Approvals: id кадра → кадр, на который ждём человеческое решение. */
  #approvals = new Map<string, Json>();
  #approvalHandler: ((req: ApprovalRequest) => void) | null = null;

  /** Состояние текущего хода: события вне хода нас не интересуют. */
  #turn: { startSeq: number; toolFailures: string[]; assistants: Json[] } | null = null;

  #turnChain: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | null = null;

  constructor(opts: OmpRpcLinkOptions) {
    this.#opts = {
      bin: opts.bin ?? "omp",
      cwd: opts.cwd,
      model: opts.model,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      commandTimeoutMs: opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      turnTimeoutMs: opts.turnTimeoutMs ?? TURN_TIMEOUT_MS,
      closeTimeoutMs: opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
    };
  }

  get pid(): number | null {
    return this.#proc?.pid ?? null;
  }

  get alive(): boolean {
    return this.#alive;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  /** stderr процесса — только для отчёта об ошибке старта/смерти. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /**
   * Поднять процесс и дождаться ready. До ready команды не отправляем: omp
   * доказывает готовность только этим кадром, а команда, отправленная раньше,
   * может потеряться в инициализации.
   */
  async start(): Promise<this> {
    if (this.#proc !== null) return this;
    const bin = this.#opts.bin.includes("/") ? this.#opts.bin : (Bun.which(this.#opts.bin) ?? this.#opts.bin);
    const argv = [
      bin,
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--cwd",
      this.#opts.cwd,
      "--model",
      this.#opts.model,
    ];

    const readyGate = Promise.withResolvers<void>();
    this.#readyDeferred = { resolve: readyGate.resolve, reject: readyGate.reject };
    const ready = withTimeout(readyGate.promise, this.#opts.readyTimeoutMs, "готовность omp");

    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      // detached: процесс — лидер своей группы; kill(-pid) снимает и его детей
      // (bash-инструменты, background jobs), иначе они переживут задачу.
      proc = Bun.spawn(argv, {
        cwd: this.#opts.cwd,
        detached: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
    } catch (err) {
      this.#readyDeferred = null;
      throw new RpcTransportError(
        "exit",
        `не удалось запустить omp (${bin}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.#proc = proc;
    this.#stdin = proc.stdin;
    this.#alive = true;

    void this.#readStdout(proc.stdout);
    void this.#readStderr(proc.stderr);
    void proc.exited.then((code) => this.#onExit(code));

    try {
      await ready;
      return this;
    } catch (err) {
      // Без ready процесс бесполезен и не должен висеть в памяти шлюза.
      this.#kill();
      const tail = this.#stderrTail.trim();
      const reason = err instanceof Error ? err.message : String(err);
      throw new RpcTransportError("exit", tail.length > 0 ? `${reason}; stderr: ${oneLine(tail, 600)}` : reason);
    } finally {
      this.#readyDeferred = null;
    }
  }

  async prompt(text: string, opts?: { signal?: AbortSignal }): Promise<TurnOutcome> {
    // Ходы одного процесса строго последовательны: у agent_end нет id хода,
    // и два параллельных prompt превратили бы сборку outcome в лотерею.
    const run = this.#turnChain.then(() => this.#runTurn(text, opts?.signal));
    this.#turnChain = run.catch(() => undefined);
    return run;
  }

  async abort(): Promise<void> {
    if (!this.#alive) return;
    try {
      await this.#command({ type: "abort" }, this.#opts.commandTimeoutMs);
    } catch {
      // omp не ответил на abort — ждать нечего: снимаем группу процессов,
      // иначе ход повиснет до таймаута модели.
      this.#kill();
    }
  }

  async answerApproval(id: string, decision: "allow" | "deny"): Promise<void> {
    const frame = this.#approvals.get(id);
    if (frame === undefined) return; // неизвестный/устаревший id — no-op
    this.#approvals.delete(id);
    if (!this.#alive) return; // отвечать уже некому; не бросаем в контроллер
    const response = this.#approvalResponse(frame, decision);
    await this.#send(response);
  }

  onApproval(cb: (req: ApprovalRequest) => void): void {
    this.#approvalHandler = cb;
    // Запрос мог прийти между start() и регистрацией обработчика — отдаём его
    // сразу, иначе агент стоял бы на вопросе, которого никто не видит.
    for (const frame of this.#approvals.values()) cb(toApprovalRequest(frame));
  }

  async close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  async #doClose(): Promise<void> {
    const proc = this.#proc;
    if (proc === null) return;
    this.#alive = false;
    try {
      this.#stdin?.end();
    } catch {
      // уже закрыт
    }
    // Держим stdout читающим до конца: без этого omp не сможет дописать
    // выходные кадры и залипнет на backpressure.
    try {
      await withTimeout(proc.exited, this.#opts.closeTimeoutMs, "закрытие omp");
    } catch {
      this.#kill();
      await proc.exited.catch(() => undefined);
    }
    this.#failPending(new RpcTransportError("exit", "связь закрыта"));
  }

  // ── Транспорт ────────────────────────────────────────────────────────────

  #nextId(prefix: string): string {
    this.#idSeq += 1;
    return `${prefix}-${this.#idSeq}`;
  }

  #send(frame: Json): Promise<void> {
    const sink = this.#stdin;
    if (sink === null || !this.#alive) {
      return Promise.reject(new RpcTransportError("exit", "omp уже не запущен"));
    }
    const line = `${JSON.stringify(frame)}\n`;
    // Очередь записей: flush() асинхронный, а два кадра не должны перемешаться.
    this.#writeChain = this.#writeChain.catch(() => undefined).then(async () => {
      sink.write(line);
      await sink.flush();
    });
    return this.#writeChain;
  }

  #command(frame: Json, timeoutMs: number): Promise<Json> {
    const id = typeof frame.id === "string" ? frame.id : this.#nextId("cmd");
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new RpcTransportError("timeout", `команда ${String(frame.type)}: таймаут ${timeoutMs} мс`));
    }, timeoutMs);
    this.#pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    this.#send({ ...frame, id }).catch((err: unknown) => {
      const waiter = this.#pending.get(id);
      if (waiter === undefined) return;
      this.#pending.delete(id);
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    });
    return promise;
  }

  async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) this.#onLine(line);
          nl = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) this.#onLine(buffer);
    } catch (err) {
      if (this.#alive) {
        this.#failPending(
          new RpcTransportError("exit", `чтение stdout: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // stderr — только диагностика
    }
  }

  #onLine(line: string): void {
    let frame: Json;
    try {
      frame = JSON.parse(line) as Json;
    } catch {
      return; // битую строку omp пометил бы command:"parse"; нам она не нужна
    }
    if (frame === null || typeof frame !== "object") return;
    this.#seq += 1;
    switch (frame.type) {
      case "ready":
        if (!this.#ready) {
          this.#ready = true;
          this.#readyDeferred?.resolve();
        }
        return;
      case "response": {
        const id = frame.id;
        if (typeof id !== "string") return;
        const waiter = this.#pending.get(id);
        if (waiter === undefined) return;
        this.#pending.delete(id);
        waiter.resolve(frame);
        return;
      }
      case "prompt_result": {
        if (typeof frame.id !== "string") return;
        const waiter = this.#promptResults.get(frame.id);
        if (waiter === undefined) return;
        this.#promptResults.delete(frame.id);
        waiter.resolve(frame);
        return;
      }
      case "agent_end":
        // isTerminal:false — ретрай/компакция/продолжение, это не yield.
        if (frame.isTerminal === false) return;
        this.#lastTerminalEnd = { frame, seq: this.#seq };
        for (const waiter of this.#endWaiters) waiter(frame);
        this.#endWaiters.clear();
        return;
      case "message_end":
        if (this.#turn !== null && frame.message?.role === "assistant") this.#turn.assistants.push(frame.message);
        return;
      case "tool_execution_end":
        this.#onToolEnd(frame);
        return;
      case "extension_ui_request":
        this.#onUiRequest(frame);
        return;
      default:
        return; // presentation/queue/telemetry — контроллеру не нужны
    }
  }

  #onToolEnd(frame: Json): void {
    const turn = this.#turn;
    if (turn === null || frame.isError !== true) return;
    const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
    const result = frame.result as Json | undefined;
    const detail = textOf(result) || (typeof result?.error === "string" ? result.error : "") || "tool failed";
    turn.toolFailures.push(oneLine(`${name}: ${detail}`, TOOL_FAILURE_MAX));
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  #onUiRequest(frame: Json): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (id === null) return;
    const method = frame.method;
    if (method === "cancel") {
      // omp уже ответил сам (таймаут/abort) — поздний ответ игнорируется.
      if (typeof frame.targetId === "string") this.#approvals.delete(frame.targetId);
      return;
    }
    if (method === "select" || method === "confirm") {
      this.#approvals.set(id, frame);
      this.#approvalHandler?.(toApprovalRequest(frame));
      return;
    }
    // input/editor/ask — не approvals, но и висеть на них агенту незачем:
    // отвечаем отменой, чтобы диалог получил свой default, а не вечность.
    if (method === "input" || method === "editor" || method === "ask") {
      void this.#send({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  #approvalResponse(frame: Json, decision: "allow" | "deny"): Json {
    const id = String(frame.id);
    if (frame.method === "confirm") {
      return { type: "extension_ui_response", id, confirmed: decision === "allow" };
    }
    const options = Array.isArray(frame.options)
      ? frame.options.filter((o: unknown): o is string => typeof o === "string")
      : [];
    const picked = pickOption(options, decision);
    return picked === null
      ? { type: "extension_ui_response", id, cancelled: true }
      : { type: "extension_ui_response", id, value: picked };
  }

  // ── Ход ──────────────────────────────────────────────────────────────────

  async #runTurn(text: string, signal: AbortSignal | undefined): Promise<TurnOutcome> {
    if (!this.#alive) {
      return this.#failedOutcome(
        `omp не запущен${this.#stderrTail.trim().length > 0 ? `: ${oneLine(this.#stderrTail, 300)}` : ""}`,
      );
    }
    const turn = { startSeq: this.#seq, toolFailures: [] as string[], assistants: [] as Json[] };
    this.#turn = turn;
    // Снимок ДО хода: get_session_stats отдаёт накопленные счётчики сессии,
    // расход хода — только их дельта.
    const before = await this.#snapshotStats();
    const id = this.#nextId("prompt");

    const endGate = Promise.withResolvers<Json>();
    const endWaiter = endGate.resolve;
    this.#endWaiters.add(endWaiter);

    const resultGate = Promise.withResolvers<Json>();
    // Ветка «процесс умер до prompt_result» возвращается, не дожидаясь гейта:
    // без этого обработчика отклонение всплыло бы как unhandledRejection.
    resultGate.promise.catch(() => undefined);
    this.#promptResults.set(id, { resolve: resultGate.resolve, reject: resultGate.reject });

    const cleanup = () => {
      this.#promptResults.delete(id);
      this.#endWaiters.delete(endWaiter);
      if (this.#turn === turn) this.#turn = null;
    };

    const onAbort = () => {
      // Отмену хоста транслируем в abort, но исход всё равно берём из
      // prompt_result — его пишет сам omp.
      void this.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const deadline = Date.now() + this.#opts.turnTimeoutMs;
    try {
      const response = await this.#command({ id, type: "prompt", message: text }, this.#opts.turnTimeoutMs);
      if (response.success !== true) {
        return this.#failedOutcome(typeof response.error === "string" ? response.error : "omp отклонил prompt", before, turn);
      }
      if (response.data?.agentInvoked === false) {
        // Локальная команда: хода агента не будет, и agent_end тоже.
        return {
          status: "completed",
          text: "",
          usage: await this.#turnUsage(before, turn.assistants),
          toolFailures: [],
        };
      }

      const resultFrame = await withTimeout(resultGate.promise, Math.max(1, deadline - Date.now()), "prompt_result");

      // terminal agent_end по документации уже позади; номер кадра отсекает
      // чужой (прошлый) ход. Кадр не пришёл — короткий грейс, не весь таймаут.
      let endFrame: Json | null = null;
      if (this.#lastTerminalEnd !== null && this.#lastTerminalEnd.seq > turn.startSeq) {
        endFrame = this.#lastTerminalEnd.frame;
      } else {
        try {
          endFrame = await withTimeout(
            endGate.promise,
            Math.min(END_GRACE_MS, Math.max(1, deadline - Date.now())),
            "agent_end",
          );
        } catch {
          endFrame = this.#lastTerminalEnd?.frame ?? null;
        }
      }

      const status: TurnOutcome["status"] =
        resultFrame.status === "completed" || resultFrame.status === "aborted" ? resultFrame.status : "error";
      const messages: Json[] = Array.isArray(endFrame?.messages) ? endFrame.messages : [];
      let finalText = "";
      for (let i = messages.length - 1; i >= 0 && finalText.length === 0; i -= 1) {
        if (messages[i]?.role === "assistant") finalText = textOf(messages[i]);
      }
      for (let i = turn.assistants.length - 1; i >= 0 && finalText.length === 0; i -= 1) {
        finalText = textOf(turn.assistants[i]);
      }

      // Запасной источник расхода — usage самих сообщений ассистента; в
      // agent_end он полнее, чем в потоке message_end (v1 может усечь кадры).
      const endAssistants = messages.filter((message) => message?.role === "assistant");
      const usageSource = endAssistants.some((message) => usageOfMessage(message) !== null)
        ? endAssistants
        : turn.assistants;

      const outcome: TurnOutcome = {
        status,
        text: finalText,
        usage: await this.#turnUsage(before, usageSource),
        toolFailures: turn.toolFailures,
      };
      if (status === "error") {
        outcome.error =
          typeof resultFrame.error?.message === "string" ? resultFrame.error.message : "ompturn завершился ошибкой";
      }
      return outcome;
    } catch (err) {
      // prompt_result не придёт: процесс умер/убит или ход не уложился в бюджет.
      if (!this.#alive) {
        return this.#failedOutcome(
          `omp завершился во время хода${typeof this.#exitCode === "number" ? ` (код ${this.#exitCode})` : ""}`,
          before,
          turn,
        );
      }
      if (err instanceof RpcTransportError && err.kind === "timeout") {
        // Ход не уложился: снимаем процесс, иначе он доработает втихую и
        // следующий prompt получит чужой agent_end.
        this.#kill();
        return this.#failedOutcome(`ход не уложился в таймаут: ${err.message}`, before, turn);
      }
      return this.#failedOutcome(err instanceof Error ? err.message : String(err), before, turn);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
    }
  }

  /** Снимок суммарных счётчиков. Ошибка stats не валит ход: есть запасной путь. */
  async #snapshotStats(): Promise<StatsSnapshot | null> {
    try {
      const frame = await this.#command({ type: "get_session_stats" }, this.#opts.commandTimeoutMs);
      return frame.success === true ? readStats(frame.data) : null;
    } catch {
      return null;
    }
  }

  /** Расход именно хода. Никогда не отдаём нули, если данные о расходе есть. */
  async #turnUsage(before: StatsSnapshot | null, assistants: Json[]): Promise<TurnUsage> {
    const after = await this.#snapshotStats();
    let usage: UsageDelta = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let costUsd = 0;
    if (after !== null && before !== null) {
      usage = {
        inputTokens: Math.max(0, after.usage.inputTokens - before.usage.inputTokens),
        outputTokens: Math.max(0, after.usage.outputTokens - before.usage.outputTokens),
        cacheReadTokens: Math.max(0, after.usage.cacheReadTokens - before.usage.cacheReadTokens),
        cacheWriteTokens: Math.max(0, after.usage.cacheWriteTokens - before.usage.cacheWriteTokens),
      };
      costUsd = Math.max(0, after.cost - before.cost);
    }
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) {
      // stats недоступны — или счётчики не сдвинулись; тогда сумма usage
      // самих сообщений ассистента, если она вообще есть.
      let sum: UsageDelta = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let cost = 0;
      let seen = false;
      for (const message of assistants) {
        const measured = usageOfMessage(message);
        if (measured === null) continue;
        seen = true;
        sum = {
          inputTokens: sum.inputTokens + measured.usage.inputTokens,
          outputTokens: sum.outputTokens + measured.usage.outputTokens,
          cacheReadTokens: sum.cacheReadTokens + measured.usage.cacheReadTokens,
          cacheWriteTokens: sum.cacheWriteTokens + measured.usage.cacheWriteTokens,
        };
        cost += measured.cost;
      }
      if (seen) {
        usage = sum;
        costUsd = cost;
      }
    }
    return { ...usage, costUsd };
  }

  /** Ошибка хода, но с честно измеренным расходом: модель могла отработать часть. */
  async #failedOutcome(
    error: string,
    before?: StatsSnapshot | null,
    turn?: { assistants: Json[] },
  ): Promise<TurnOutcome> {
    const usage = before !== undefined && turn !== undefined
      ? await this.#turnUsage(before, turn.assistants)
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    return { status: "error", text: "", usage, toolFailures: [], error };
  }

  // ── Служебное ────────────────────────────────────────────────────────────

  #onExit(code: number): void {
    this.#exitCode = code;
    this.#alive = false;
    const err = new RpcTransportError(
      "exit",
      `omp завершился (код ${code})${this.#stderrTail.trim().length > 0 ? `: ${oneLine(this.#stderrTail, 300)}` : ""}`,
    );
    if (!this.#ready) this.#readyDeferred?.reject(err);
    this.#failPending(err);
  }

  #failPending(err: Error): void {
    for (const waiter of this.#pending.values()) waiter.reject(err);
    this.#pending.clear();
    for (const waiter of this.#promptResults.values()) waiter.reject(err);
    this.#promptResults.clear();
    for (const waiter of this.#endWaiters) {
      // Будим ждущих agent_end: иначе prompt() висел бы до таймаута на мёртвом процессе.
      waiter({ type: "agent_end", messages: [], isTerminal: true, dead: true });
    }
    this.#endWaiters.clear();
  }

  #kill(): void {
    const proc = this.#proc;
    if (proc === null) return;
    this.#alive = false;
    try {
      // detached-процесс — лидер группы: минус снимает и его детей.
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // уже мёртв
      }
    }
    this.#failPending(new RpcTransportError("exit", "omp убит"));
  }
}

/** Фабрика для контроллера: у задачи свой процесс, свой cwd и своя модель. */
export function rpcLinkFactory(opts: Omit<OmpRpcLinkOptions, "cwd" | "model"> = {}): LinkFactory {
  return async (task: Task): Promise<AgentLink> => {
    const link = new OmpRpcLink({ ...opts, cwd: task.cwd, model: task.model });
    await link.start();
    return link;
  };
}
