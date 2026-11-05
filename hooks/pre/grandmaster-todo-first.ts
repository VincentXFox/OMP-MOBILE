/**
 * GRANDMASTER 8.0 — todo-first gate.
 *
 * Зачем: главный повторяющийся дефект прогонов — «начал делать сразу», без плана.
 * Инструкция «сначала todo» в промпте не работает (проверено на практике: правило
 * есть, туду всё равно появляется после половины работы). Значит — runtime-гейт.
 *
 * Контракт:
 *  - `before_agent_start` запоминает пользовательский запрос хода;
 *  - `tool_call` на `edit`/`write` без инициализированного в этой сессии todo
 *    БЛОКИРУЕТСЯ, если запрос похож на многошаговый (эвристика см. taskLike);
 *  - вызов `todo` в текущем ходе снимает запрет до следующего пользовательского
 *    батча: план проверяется НА КАЖДЫЙ ход (дефект 8.0: `todoSeen` жил всю сессию,
 *    и после первого плана любые следующие задачи правили файлы без туду);
 *  - блокировки считаются на сессию (MAX_BLOCKS_PER_SESSION), новые ходы их не сбрасывают;
 *  - read-only инструменты (read/grep/glob/web_search/eval-разведка) не блокируются:
 *    сначала посмотреть, потом планировать, потом менять — так и должно быть;
 *  - тривиальный запрос («ответь одним словом», «покажи версию») не трогаем;
 *  - ошибки хука — fail-open (планирование не должно ломать работу).
 *
 * Что это НЕ делает: не проверяет качество плана и не заставляет переписывать
 * существующий todo. Только требует, чтобы план существовал до первой правки файла.
 */

const MUTATING_TOOLS = new Set(["edit", "write"]);
const TODO_TOOL = "todo";
const MAX_BLOCKS_PER_SESSION = 3;

/** Запросы, которым план не нужен: короткие, одиночные, справочные.
 * ВАЖНО: без `\b` — в JS граница слова считается по ASCII, и `\bсколько`
 * не совпадает никогда (кириллица не word-char). Ловим разделитель вручную. */
const TRIVIAL_RES: readonly RegExp[] = [
  /^(?:что|кто|где|когда|сколько|какой|какая|какие|почему|зачем)(?=\s|$|[?,:;!])/iu,
  /^(?:покажи|выведи|скажи|ответь|напомни|переведи|объясни\s+одним)(?=\s|$)[^.\n]{0,80}$/iu,
  /(?:одной\s+строкой|одним\s+(?:словом|предложением)|без\s+пояснений|кратко\s+ответь)/iu,
  /^[/!]\S+$/u,
];

/** Глаголы действия — для подсказки в сообщении о блоке (какие шаги модель задумала). */
const ACTION_RE =
  /(?:собери|собрать|интегрируй|интегрировать|интегрируем|внедри|внедрить|внедряем|переделай|переписать|обнови|обновить|почини|починить|исправь|исправить|добавь|добавить|удали|удалить|убери|убрать|мигрируй|настрой|настроить|разверни|развернуть|сравни|сравнить|проанализируй|проанализировать|исследуй|исследовать|создай|создать|напиши|написать|сделай|сделать|проверь|проверить|запусти|запустить|закоммить|задокументируй|выясни|выяснить|разберись|разобрать)/giu;

/** Явный отказ от плана — уважаем, пользователь сам решил. */
const NO_PLAN_RES: readonly RegExp[] = [
  /(?:без\s+плана|без\s+todo|одно\s+действие|это\s+одна\s+команда)/iu,
];

/**
 * Нужен ли план. Решение инвертировано относительно 8.0: план требуется ПО
 * УМОЛЧАНИЮ, а не по эвристике «многошаговости».
 *
 * Почему: эвристика считала признаки (маркеры + глаголы) и пропускала короткие
 * деловые запросы — «А описание», «И уже выясни почему…»: правка файла шла без
 * todo, план оставался в прозе, а панель туду продолжала показывать борд прошлой
 * задачи. Снаружи это выглядело как «план есть, а туду нет».
 *
 * Исключения: явный отказ пользователя («без плана») и справочные запросы
 * (что/кто/где, «покажи версию», «ответь одной строкой») — в них нет правок,
 * поэтому гейт ничего не ломает.
 */
export function taskLike(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length === 0) return false;
  if (NO_PLAN_RES.some((re) => re.test(text))) return false;
  // Глагол действия сильнее справочной рамки: «покажи версию и почини X» — работа.
  if (planHints(text).length > 0) return true;
  if (TRIVIAL_RES.some((re) => re.test(text))) return false;
  return true;
}

/** Подсказка к сообщению о блоке: какие шаги модель, судя по тексту, задумала. */
export function planHints(prompt: string): string[] {
  return [...new Set((prompt.match(ACTION_RE) ?? []).map((v) => v.toLowerCase()))].slice(0, 4);
}

interface Gm8TodoState {
  /** Пользовательский запрос текущего хода. */
  prompt: string;
  /** В сессии уже был вызов todo (диагностика/совместимость). */
  todoSeen: boolean;
  /** План поставлен в ТЕКУЩЕМ ходе — именно он снимает блок правок. */
  turnTodoSeen: boolean;
  /** Сколько раз блокировали — чтобы не уйти в бесконечный отказ. */
  blocks: number;
  /** План заявлен вызовом todo, но результат ещё не подтверждён. */
  todoPending?: boolean;
  /** Идентификатор конкретного вызова todo, который ждёт результата. */
  todoCallId?: string;
  /** Отказы валидатора todo — для подсказки формата. */
  todoFails?: number;
}

const STATE = new Map<string, Gm8TodoState>();

function stateKey(ctx: unknown): string {
  const c = ctx as { sessionManager?: { getSessionId?: () => unknown }; cwd?: unknown } | undefined;
  const id = c?.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id.length > 0) return id;
  return typeof c?.cwd === "string" ? c.cwd : "global";
}

function stateOf(ctx: unknown): Gm8TodoState {
  const key = stateKey(ctx);
  let st = STATE.get(key);
  if (st === undefined) {
    st = { prompt: "", todoSeen: false, turnTodoSeen: false, blocks: 0 };
    STATE.set(key, st);
  }
  return st;
}

/** Только для тестов и диагностики. */
export function gm8TodoState(key?: string): Gm8TodoState | readonly [string, Gm8TodoState][] | null {
  if (key !== undefined) return STATE.get(key) ?? null;
  return [...STATE.entries()];
}


/** Пункт плана длиннее этого рвёт JSON у модели — режем заранее. */
const MAX_TASK_CHARS = 240;
/** Больше этого в один вызов не отдаём: длинный payload = битый payload. */
const MAX_TASKS_PER_PHASE = 12;

function clampTask(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_TASK_CHARS ? oneLine : `${oneLine.slice(0, MAX_TASK_CHARS - 1)}…`;
}

/** Строка/массив строк → массив задач; иначе null. */
function asTaskList(value: unknown): string[] | null {
  if (typeof value === "string") return value.trim() === "" ? null : [clampTask(value)];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") out.push(clampTask(item));
  }
  return out.length > 0 ? out.slice(0, MAX_TASKS_PER_PHASE) : null;
}

export interface TodoNormalizeResult {
  /** Починенный payload — его можно выполнять без ошибки валидации. */
  input: Record<string, unknown>;
  /** Было ли что-то исправлено. */
  repaired: boolean;
  /** Что осталось непоправимым (тогда вызов блокируем). */
  problem: string | null;
}

/**
 * Починка payload'а `todo` ДО валидации инструмента.
 *
 * Реальный отказ (12 повторов в логах): модель ломает JSON на длинных
 * кириллических строках, и ключ приезжает как `"{\"phase\"": "…"` — фазы нет,
 * вызов падает, план не создаётся. Здесь мы вытаскиваем фазу/пункты из любого
 * разумного места (ключ, похожий на phase; одиночная строка вместо массива;
 * лишние ключи с пунктами) и отдаём инструменту нормальный объект.
 */
export function normalizeTodoInput(raw: unknown): TodoNormalizeResult {
  const empty = { input: {}, repaired: false, problem: "аргументы не объект" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let repaired = false;

  const pickTop = (key: string): unknown => src[key];

  if (Array.isArray(pickTop("list"))) {
    const phases: Array<Record<string, unknown>> = [];
    for (let i = 0; i < (pickTop("list") as unknown[]).length; i++) {
      const entry = (pickTop("list") as unknown[])[i];
      if (typeof entry === "string") {
        repaired = true;
        phases.push({ phase: entry.trim() || `Фаза ${i + 1}`, items: ["пункт"] });
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        repaired = true;
        phases.push({ phase: `Фаза ${i + 1}`, items: ["пункт"] });
        continue;
      }
      const e = entry as Record<string, unknown>;
      let phase = typeof e.phase === "string" ? e.phase.trim() : "";
      let items = asTaskList(e.items);
      const stray: string[] = [];
      for (const [key, value] of Object.entries(e)) {
        if (key === "phase" || key === "items") continue;
        const asItems = asTaskList(value);
        if (/phase/i.test(key) && typeof value === "string" && phase === "") {
          phase = value.trim();
          repaired = true;
          continue;
        }
        if (asItems !== null) {
          stray.push(...asItems);
          repaired = true;
          continue;
        }
        repaired = true; // посторонний ключ — выбрасываем
      }
      if (items === null) items = stray.length > 0 ? stray : null;
      if (items === null) {
        repaired = true;
        items = ["пункт"];
      }
      if (phase === "") {
        // Фаза потерялась: берём текст из имени ключа, если он на неё похож.
        repaired = true;
        phase = `Фаза ${i + 1}`;
      }
      phases.push({ phase, items });
    }
    out.list = phases;
  } else {
    const items = asTaskList(pickTop("items"));
    if (items !== null) out.items = items;
  }

  for (const key of ["task", "phase", "reason", "op", "i"] as const) {
    const value = pickTop(key);
    if (value !== undefined && value !== null) out[key] = value;
  }
  if (Object.keys(out).length === 0) return { input: {}, repaired, problem: "пустой payload" };
  return { input: out, repaired, problem: null };
}

interface ToolCallEvent {
  toolName?: unknown;
  input?: unknown;
  toolCallId?: unknown;
}

/**
 * Проверка payload'а `todo` до вызова инструмента. Модель иногда ломает JSON
 * на длинных кириллических строках: ключ приезжает как `"{"phase"": "…"`,
 * и встроенная валидация отвечает длинной простынёй с null-ами. Ловим это
 * здесь и отдаём короткое предписание, как перевызвать.
 * Возвращает текст проблемы или null, если аргументы в порядке.
 */
export function todoPayloadProblem(input: unknown): string | null {
  if (input === null || typeof input !== "object") return "аргументы не объект";
  const args = input as Record<string, unknown>;
  const list = args.list;
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list)) return "list должен быть массивом";
    for (let i = 0; i < list.length; i++) {
      const entry: unknown = list[i];
      if (entry === null || typeof entry !== "object") return `list[${i}] — не объект`;
      const e = entry as Record<string, unknown>;
      if (typeof e.phase !== "string" || e.phase.trim() === "") return `list[${i}].phase отсутствует или пуст`;
      if (!Array.isArray(e.items) || e.items.length === 0) return `list[${i}].items должен быть непустым массивом строк`;
      const junk = Object.keys(e).filter((k) => k !== "phase" && k !== "items");
      if (junk.length > 0) return `list[${i}] содержит посторонний ключ ${JSON.stringify(junk[0])}`;
    }
    return null;
  }
  const items = args.items;
  if (items !== undefined && items !== null && !Array.isArray(items)) return "items должен быть массивом строк";
  return null;
}

interface TodoFirstApi {
  on(
    event: "before_agent_start",
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
  ): void;
  on(
    event: "tool_call",
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
  ): void;
  on(
    event: "tool_result",
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
  ): void;
  on(
    event: "session_start",
    handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
  ): void;
}

export default function (pi: TodoFirstApi): void {
  // Новая сессия — новый план: состояние не наследуем от предыдущей.
  pi.on("session_start", (_event, ctx) => {
    try {
      STATE.delete(stateKey(ctx));
    } catch {
      // fail-open
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const prompt = (event as { prompt?: unknown }).prompt;
      const st = stateOf(ctx);
      if (typeof prompt === "string") st.prompt = prompt;
      // План свежий на КАЖДЫЙ ход: новый пользовательский батч требует нового или
      // обновлённого todo до первой правки файла. Счётчик блокировок не сбрасываем.
      st.turnTodoSeen = false;
      // Новая задача — старое ожидание недействительно: результат вызова прошлой
      // задачи не должен открывать правки в этой (воспроизведённый обход).
      const taskId = typeof prompt === "string" ? prompt.trim().slice(0, 500) : "";
      if (st.taskId !== undefined && st.taskId !== taskId) {
        st.todoPending = false;
        st.todoCallId = undefined;
      }
      st.taskId = taskId;
      // Блокировки считаем на сессию, а не на ход: после трёх отказов
      // инструмент отпускаем — иначе агент застрянет на пороге работы.
      return undefined;
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const e = event as ToolCallEvent;
      const tool = typeof e.toolName === "string" ? e.toolName : "";
      const st = stateOf(ctx);
      if (tool === TODO_TOOL) {
        const planIsEmpty = (input: unknown): boolean => {
          const list = (input as { list?: unknown }).list;
          const items = (input as { items?: unknown }).items;
          const groups = Array.isArray(list) ? list : [];
          const flat = Array.isArray(items) ? items : [];
          const count =
            groups.reduce((sum: number, group) => {
              const entries = (group as { items?: unknown })?.items;
              return sum + (Array.isArray(entries) ? entries.filter((x) => typeof x === "string" && x.trim() !== "").length : 0);
            }, 0) + flat.filter((x) => typeof x === "string" && x.trim() !== "").length;
          return count === 0;
        };

        // Пустой план (нет пунктов или только пустые строки) прав не даёт —
        // ни в нормализованном, ни в «починенном» виде.
        if (planIsEmpty(e.input)) {
          st.todoPending = false;
          st.todoCallId = undefined;
          return {
            block: true,
            reason:
              "todo: пустой план прав не даёт. Перечисли хотя бы один содержательный пункт: " +
              '{"list":[{"phase":"Фаза","items":["пункт"]}]}.',
          };
        }

        // Разрешение выдаётся НЕ здесь: сначала посмотрим результат вызова
        // (tool_result). Пустой план, ошибка инструмента и устаревшее событие
        // не должны открывать правки — это нашёл аудит дефектов.
        const fixed = normalizeTodoInput(e.input);
        if (fixed.problem === null) {
          st.todoPending = true;
          st.todoTaskId = st.taskId;
          const callId = (e as { toolCallId?: unknown }).toolCallId;
          st.todoCallId = typeof callId === "string" ? callId : undefined;
          if (fixed.repaired) {
            return {
              input: fixed.input,
              additionalContext:
                "todo: payload был битым и исправлен автоматически (нормализованы фазы/пункты). " +
                "Следующие вызовы шли короткими пунктами — по одному-два на строку.",
            };
          }
          return undefined;
        }
        const problem = todoPayloadProblem(e.input);
        if (problem !== null) {
          return {
            block: true,
            reason:
              `todo: аргументы битые — ${problem}. ` +
              'Перевызови одним объектом: {"list":[{"phase":"Фаза","items":["пункт 1","пункт 2"]}]} ' +
              '(плоский список — {"items":["пункт"]}). Не повторяй тот же вызов: длины строк в одном вызове лучше сократить.',
          };
        }
        st.todoPending = true;
        return undefined;
      }
      if (!MUTATING_TOOLS.has(tool)) return undefined;
      if (st.turnTodoSeen) return undefined;
      if (st.blocks >= MAX_BLOCKS_PER_SESSION) return undefined;
      if (!taskLike(st.prompt)) return undefined;

      st.blocks += 1;
      return {
        block: true,
        reason:
          "ГРАНДМАСТЕР · план до правок (todo-first): в этом ходе ещё нет todo-плана. " +
          "Первым действием вызови инструмент `todo`: init с фазами и конкретными пунктами " +
          "(что, в каком порядке, чем проверю) — или обнови существующий план под новую задачу. " +
          "План нужен и для одной правки: один пункт — зато панель туду показывает эту задачу, а не прошлую. " +
          "И только потом правь файлы. " +
          "Разведку (read/grep/glob) можно делать до плана. " +
          `Это предупреждение ${st.blocks}/${MAX_BLOCKS_PER_SESSION}; после него инструмент будет отпущен.`,
      };
    } catch {
      return undefined; // fail-open: план не должен блокировать работу из-за ошибки хука
    }
  });

  // Второй контур: если инструмент всё равно упал (не удалось починить вход),
  // даём модели готовую форму — один перевызов вместо длинной простыни с null.
  pi.on("tool_result", (event, ctx) => {
    try {
      const e = event as { toolName?: unknown; isError?: unknown; content?: unknown; toolCallId?: unknown };
      if (e.toolName !== TODO_TOOL) return undefined;
      const st = stateOf(ctx);
      // Подтверждение требует ОБОИХ идентификаторов: идентификатор вызова обязан
      // быть и совпадать, задача — та же. Результат без id (или от прошлой задачи)
      // прав не открывает — раньше отсутствие id проходило проверку.
      const resultCallId = typeof e.toolCallId === "string" ? e.toolCallId : "";
      if (st.todoPending !== true) return undefined;
      if (resultCallId === "" || st.todoCallId === undefined || resultCallId !== st.todoCallId) return undefined;
      if (st.todoTaskId !== undefined && st.taskId !== undefined && st.todoTaskId !== st.taskId) {
        st.todoPending = false;
        st.todoCallId = undefined;
        return undefined;
      }
      if (e.isError !== true) {
        // План реально принят инструментом: только теперь правки разрешены.
        if (st.todoPending === true) {
          st.todoSeen = true;
          st.turnTodoSeen = true;
          st.todoPending = false;
          st.todoCallId = undefined;
        }
        return undefined;
      }
      // Ошибка валидатора: заявка снимается, разрешение не выдаётся.
      st.todoPending = false;
      st.todoCallId = undefined;
      st.todoFails = (st.todoFails ?? 0) + 1;
      const flat = st.todoFails >= 2;
      return {
        additionalContext: flat
          ? 'todo: второй отказ подряд — перевызови МИНИМАЛЬНЫМ плоским payload: ' +
            '{"items":["пункт"]}. Без фаз, без длинных строк; пункты добавляй отдельными вызовами.'
          : 'todo: вызов отклонён валидатором. Перевызови СЕЙЧАС с точной формой: ' +
            '{"list":[{"phase":"Фаза","items":["пункт"]}]} или {"items":["пункт"]}. ' +
            "Пункты — короткие, без переносов строк, не больше восьми за вызов.",
      };
    } catch {
      return undefined;
    }
  });
}
