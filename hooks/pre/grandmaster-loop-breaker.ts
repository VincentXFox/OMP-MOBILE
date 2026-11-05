/**
 * GRANDMASTER 8.0 — loop breaker.
 *
 * Зачем: типовой сценарий «застрял и туплю» — агент повторяет один и тот же вызов,
 * получает ту же ошибку и повторяет ещё раз, вместо смены подхода. Инструкция
 * «не повторяй» в промпте не останавливает цикл; нужен счётчик в рантайме.
 *
 * Контракт:
 *  - подпись вызова = инструмент + стабильный отпечаток аргументов (bash → команда,
 *    read → путь+смещение, остальное → нормализованный JSON, обрезанный);
 *  - `tool_result` с isError увеличивает счётчик падений этой подписи, успех сбрасывает;
 *  - на 4-й попытке (3 падения) вызов БЛОКИРУЕТСЯ с требованием сменить стратегию;
 *    блокировок не больше MAX_BLOCKS на сессию — потом отпускаем, чтобы не запереть;
 *  - 8 успешных одинаковых вызовов подряд → не блок, а предупреждение (additionalContext):
 *    возможно, идёт перебор вместо проверки;
 *  - ошибки хука — fail-open.
 *
 * Границы: хук не знает смысла задачи. Он ловит именно повторяемость падений —
 * самый частый и самый дорогой вид цикла; смысловые тупики ловит стоп-гейт.
 */
import { createHash } from "node:crypto";


const FAILS_BEFORE_BLOCK = 3;
const REPEATS_BEFORE_WARN = 8;
const MAX_BLOCKS_PER_SESSION = 4;

interface SigState {
  fails: number;
  repeats: number;
  warned: boolean;
}

const STATE = new Map<string, Map<string, SigState>>();
const BLOCKS = new Map<string, number>();

interface Ctx {
  sessionManager?: { getSessionId?: () => unknown };
  cwd?: unknown;
}

function sessionKey(ctx: unknown): string {
  const c = ctx as Ctx | undefined;
  const id = c?.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id.length > 0) return id;
  return typeof c?.cwd === "string" ? c.cwd : "global";
}

/** Стабильный отпечаток аргументов: порядок ключей не должен порождать «новую» подпись. */
/**
 * Отпечаток аргументов вызова.
 *
 * Раньше вход обрезался (глубина 2, первые 6 элементов массива, 400 символов), из-за
 * чего разные длинные команды получали одинаковый отпечаток, и защита от циклов
 * срабатывала не там, где нужно (нашёл аудит). Теперь каноникализация полная:
 * ключи сортируются, значения обходятся целиком, результат хешируется — различия
 * в хвосте команды не исчезают.
 */
function fingerprint(input: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "number") return Number.isFinite(value) ? `n:${value}` : "n:nan";
    if (typeof value === "bigint") return `b:${value.toString()}`;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return `s:${value}`;
    if (typeof value === "function") return "fn";
    if (typeof value === "symbol") return `sym:${String(value)}`;
    const obj = value as object;
    if (seen.has(obj)) return "[cycle]";
    seen.add(obj);
    if (Array.isArray(value)) return `[${value.map(item => walk(item)).join(",")}]`;
    const entries = Object.entries(obj as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${walk(v)}`).join(",")}}`;
  };
  const canonical = walk(input);
  return `${canonical.length}:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function signatureOf(tool: string, input: unknown): string {
  return `${tool}|${fingerprint(input)}`;
}

function stateFor(ctx: unknown): Map<string, SigState> {
  const key = sessionKey(ctx);
  let map = STATE.get(key);
  if (map === undefined) {
    map = new Map();
    STATE.set(key, map);
  }
  return map;
}

/** Только для тестов: состояние подписи. */
export function gm8LoopState(sessionKeyOrName: string, signature: string): SigState | null {
  const map = STATE.get(sessionKeyOrName);
  if (map === undefined) return null;
  return map.get(signature) ?? null;
}

export function gm8Signature(tool: string, input: unknown): string {
  return signatureOf(tool, input);
}

interface LoopApi {
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => unknown): void;
  on(event: "tool_call", handler: (event: unknown, ctx: unknown) => unknown): void;
  on(event: "tool_result", handler: (event: unknown, ctx: unknown) => unknown): void;
}

const STRATEGY_TEXT =
  "Смена подхода, а не повтор: (1) прочитай фактическую ошибку целиком и назови причину одной строкой; " +
  "(2) смени уровень — конфиг → код → сеть → железо; другой инструмент вместо того же самого; " +
  "(3) если путь в принципе закрыт — делегируй субагенту с конкретным вопросом или проверь предпосылку заново; " +
  "(4) если два разных подхода не дали прогресса — отчёт PARTIAL с «БЛОКЕР: …» и списком попыток.";

export default function (pi: LoopApi): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      const key = sessionKey(ctx);
      STATE.delete(key);
      BLOCKS.delete(key);
    } catch {
      // fail-open
    }
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const e = event as { toolName?: unknown; input?: unknown };
      const tool = typeof e.toolName === "string" ? e.toolName : "";
      if (tool.length === 0) return undefined;
      const map = stateFor(ctx);
      const sig = signatureOf(tool, e.input);
      const st = map.get(sig);
      if (st === undefined) return undefined;
      const key = sessionKey(ctx);
      const blocks = BLOCKS.get(key) ?? 0;

      if (st.fails >= FAILS_BEFORE_BLOCK) {
        // Лимит одинаковых повторов прекращает БЕСПОЛЕЗНОЕ повторение одной операции,
        // но не закрывает задачу и не отдаёт её владельцу: исполнитель получает
        // историю попыток и обязан перейти к другому обоснованному действию.
        BLOCKS.set(key, blocks + 1);
        st.fails = 0; // после блокировки считаем заново: смена подхода обнулит и подпись
        const history = (st.history ?? []).slice(-3).map((h, i) => `${i + 1}) ${h}`).join("; ");
        const overBudget = blocks >= MAX_BLOCKS_PER_SESSION;
        return {
          block: true,
          reason:
            `ГРАНДМАСТЕР · защита от циклов: этот же вызов (${tool}) уже падал ${FAILS_BEFORE_BLOCK} раза с тем же результатом ` +
            `(блокировок по сессии: ${blocks + 1}). ${STRATEGY_TEXT}` +
            (history ? ` История попыток: ${history}.` : "") +
            (overBudget
              ? " Лимит повторов исчерпан — повтор этой операции больше не имеет смысла. Задача остаётся открытой: " +
                "проверь предпосылки (что именно падает и почему), прочитай диагностику, смени инструмент или уровень " +
                "(config → код → данные), локализуй проблему отдельной пробой либо привлеки отдельного проверяющего. " +
                "Отчёт PARTIAL не закрывает задачу и не требует владельца."
              : ""),
        };
      }
      if (st.repeats >= REPEATS_BEFORE_WARN && !st.warned) {
        st.warned = true;
        return {
          additionalContext:
            `ГРАНДМАСТЕР · защита от циклов (loop-breaker): одинаковый вызов (${tool}) повторился ${st.repeats} раз без изменения входа. ` +
            "Проверь, что ты реально получаешь новый результат: сравни с предыдущим выводом, и если он тот же — меняй стратегию, " +
            "а не число повторов.",
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const e = event as { toolName?: unknown; input?: unknown; isError?: unknown };
      const tool = typeof e.toolName === "string" ? e.toolName : "";
      if (tool.length === 0) return undefined;
      const map = stateFor(ctx);
      const sig = signatureOf(tool, e.input);
      const st = map.get(sig) ?? { fails: 0, repeats: 0, warned: false, history: []};
      if (e.isError === true) {
        st.fails += 1;
      } else {
        st.fails = 0;
        st.repeats += 1;
      }
      map.set(sig, st);
      // История попыток для исполнителя: что пробовали и чем кончилось. Её он
      // получает, когда повтор этой операции запрещён.
      if (e.isError === true) {
        if (!Array.isArray(st.history)) st.history = [];
        const what = String((e.input as { command?: unknown; path?: unknown })?.command ?? (e.input as { path?: unknown })?.path ?? "").slice(0, 60);
        st.history.push(`${tool}${what ? ` (${what})` : ""}`);
        if (st.history.length > 8) st.history.shift();
      }
      return undefined;
    } catch {
      return undefined;
    }
  });
}
