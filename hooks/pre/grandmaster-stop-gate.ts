/**
 * GRANDMASTER 8.0 stop gate (7.5 certificate + 8.0 «оговорки не выход» + todo-ledger).
 *
 * 8.0 adds the two failure modes the owner kept hitting:
 *  - «ГОТОВО-С-ОГРАНИЧЕНИЯМИ» как способ закрыть недоделанное: теперь каждое ограничение
 *    обязано быть помечено тегом И подкреплено сообщением о реальной попытке; открытые
 *    пункты todo-плана сессии проверяются так же строго, как файловый реестр;
 *  - повтор «переформулировал и ушёл»: эскалация после третьего блока прямо говорит,
 *    что перепридумывание текста не поможет — закрывай пункты.
 *
 * Source of open items for 8.0: the `todo` tool result inside `event.messages`
 * («Remaining items (N): …» / «Remaining items: none»). План, который агент сам
 * поставил инструментом todo, — тот же контракт, что и TASKS.md/QUALITY.md.
 *
 * Original 7.5 contract follows.
 *
 * 7.5 adds the «не останавливайся на незавершённом» enforcement, matched to the published
 * failure mode (premature completion / premature commitment / evidence-carrying termination):
 *  - a DONE answer must carry an evidence line and zero open ledger items;
 *  - a CAVEATS answer (ГОТОВО-С-ОГРАНИЧЕНИЯМИ) must carry tagged limitations
 *    ([железо] / [чужие-доступы] / [нужно-согласие] / [провайдер] / [физически-нет]) and
 *    zero open ledger items — a caveat may not bury unfinished work;
 *  - PARTIAL / BLOCKED must name the blocker and the strategies already tried;
 *  - deferral wording ("осталось доделать", "не проверял", "по запросу", "позже", …) blocks;
 *  - the block limit rises to 6 with an escalating checklist, because a single reminder is
 *    exactly what research shows does not work ("be thorough" ≠ runtime-enforced gate).
 *
 * Honest limits: the gate checks shape, not truth. It cannot tell a fabricated evidence line
 * from a real run; it forces the claim to be explicit and re-checkable, which is what makes
 * premature completion visible instead of silent (README 7.5).
 *
 * Uses the `session_stop` event (OMP extension docs): a handler may return
 * { decision: "block", reason } to force another model-visible continuation.
 * Installed at USER level only — do not duplicate into project .omp/hooks.
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { join } from "node:path";

const MAX_BLOCKS = 6;
/** Напоминания протокола — не больше одного за сессию: это обучение формату, а не гейт. */
const protocolBlocks = new Map<string, number>();
/** Кому уже выдали последнее замечание про честный статус после исчерпания лимита. */
const finalWarned = new Set<string>();
const TEMPLATE_MARKER = "<!-- TEMPLATE -->";

import { parseStatus, statusConflict, stripQuoted, type Status } from "../lib/status.ts";
import { latestAcceptance, mayClaimDone, mayClaimDoneAny } from "../lib/gate-state.ts";
import { proofForProject } from "../lib/trusted-verification.ts";
import { mutateTaskState, readTaskState } from "../lib/task-state.ts";
import { appendEvidence } from "../lib/evidence.ts";
import { gmLabel } from "../lib/version.ts";

export { parseStatus, stripQuoted } from "../lib/status.ts";

/** Evidence line proving the claim was checked by a run, not asserted. */
const EVIDENCE_RE =
  /(?:^|\n)\s*(?:EVIDENCE|ДОКАЗАТЕЛЬСТВ[АО]|ПРОВЕРЕНО|ПРОВЕРКА|VERIFIED|TESTED)\s*[:\-]/iu;

/** Limitation tags: only physically/legally unreachable things may remain open. */
const CAVEAT_TAG_RE =
  /\[[^\]\n]{0,40}(?:желез|устройств|девайс|чужи|доступ|согласи|провайдер|физическ|внешн|аппарат)[^\]\n]{0,40}\]/iu;

/** A blocker must be named explicitly. */
const BLOCKER_RE = /(?:^|\n)\s*(?:БЛОКЕР|BLOCKER|ПРИЧИНА|НЕ\s+ХВАТАЕТ|ЗАБЛОКИРОВАНО)\s*[:\-]/iu;

/**
 * Универсальный протокол задач (разделы 2–3): у обратимых правок должен быть
 * назван откат, у многошаговой работы — след в документации. Проверяется форма:
 * строка есть или явно сказано, почему её не требуется.
 */
const NO_ROLLBACK_RE = /(?:необратим|откат\s+не\s+(?:требуется|нужен)|без\s+отката|изменения\s+только\s+в\s+памяти)/iu;
/** Любое внятное упоминание пути назад: строка ОТКАТ, бэкап, git revert, копия. */
const ROLLBACK_ANY_RE = /(?:откат|rollback|revert|бэкап|backup|резервн\w*\s+коп|точк\w*\s+восстановлен|восстановить\s+из)/iu;
/** След документации: файлы протокола, журнал стола или явный отказ от документов. */
const DOCS_RE = /(?:TASK_PLAN|TASK_REPORT|JOURNAL|ЖУРНАЛ|записал\s+в\s+журнал|отчёт\s+в)/iu;
const NO_DOCS_RE = /(?:документ\w*\s+не\s+(?:нужн|требу)|одна\s+правка|одношагов|без\s+документов|правка\s+одна)/iu;

/** Пометка «правило протокола»: напоминание выдаётся один раз за сессию. */
const PROTOCOL_MARK = "ПРОТОКОЛ:";

/** Что сессия реально делала: правки файлов и общее число вызовов инструментов. */
export interface SessionWork {
  edits: number;
  calls: number;
}

/** Proof that a blocked claim had real attempts, not a first stumble. */
const ATTEMPT_RE = /(?:попытк|attempt|стратеги|strategy|пробовал|tried|проверял)/iu;

/** Приёмка (AGENT_QUALITY_GATE): контракт результата — без него нельзя заметить подмену критериев. */
const CONTRACT_RE = /(?:^|\n)\s*(?:CONTRACT|КОНТРАКТ|КРИТЕРИИ\s+ПРИЁМКИ|AC-\d)\s*[:\-]/iu;

/** Побочные эффекты: что перепроверено из ранее работавшего. */
const REGRESSION_RE = /(?:^|\n)\s*(?:REGRESSION|РЕГРЕССИ[ЯИ]|СМЕЖНЫЕ\s+ПРОВЕРКИ)\s*[:\-]/iu;

/** Неприкосновенные условия: доступ, секреты, данные. */
const INVARIANTS_RE = /(?:^|\n)\s*(?:INVARIANTS?|ИНВАРИАНТЫ)\s*[:\-]/iu;

/** Остаточные риски: честный список непроверенного. */
const RESIDUAL_RE = /(?:^|\n)\s*(?:RESIDUAL|ОСТАТОЧНЫЕ\s+РИСКИ|ОСТАЛОСЬ\s+НЕПРОВЕРЕННЫМ)\s*[:\-]/iu;

/** Снятое состояние до правки — там, где изменение обратимо только откатом. */
const BASELINE_RE = /(?:^|\n)\s*(?:BASELINE|БАЗОВАЯ\s+ЛИНИЯ|СОСТОЯНИЕ\s+ДО)\s*[:\-]/iu;

/** Реальное состояние системы после изменения: службы, логи, метрики. */
const OBSERVABILITY_RE = /(?:^|\n)\s*(?:OBSERVABILITY|НАБЛЮДАЕМОСТЬ|СОСТОЯНИЕ\s+ПОСЛЕ)\s*[:\-]/iu;

/** Путь возврата: проверенный откат отличается от плана. */
const ROLLBACK_RE = /(?:^|\n)\s*(?:ROLLBACK|ОТКАТ)\s*[:\-]/iu;

/** Независимая приёмка: вердикт того, кто не писал изменение. */
const REVIEW_RE = /(?:^|\n)\s*(?:INDEPENDENT\s+REVIEW|REVIEW|НЕЗАВИСИМАЯ\s+ПРОВЕРКА)\s*[:\-]/iu;

/** Рискованная работа: действия на живой системе, а не чтение её состояния. */
const RISKY_RE =
  /(?:systemctl\s+(?:--user\s+)?(?:start|stop|restart|reload|enable|disable|mask|daemon-reload)|sudo\s+\S|деплой|deploy\s|выкат|перезагруз|reboot|shutdown|обновил|обновление\s+(?:служб|систем|прода|сервера)|миграц|migrat|git\s+push)/iu;

/** Contradictory: a DONE answer that still admits uncovered work. */
const UNDONE_RE = /(?:не\s+проверен|не\s+покрыт|не\s+тестиров|не\s+запускал|незакрыт|осталось\s+доделат)/iu;

// Promises of future work in the final answer = deferral of feasible work (rule 7.2).
const DEFERRAL_RES: readonly RegExp[] = [
  /после\s+(?:этого\s+)?отч[её]та/iu,
  /(?:сделаю|выполню|пересоберу|отправлю|продолжу|кликну|проверю|доделаю|допишу|дособеру)[^.\n]{0,60}(?:по\s+запросу|по\s+слову|если\s+скажешь|если\s+нужно|если\s+захочешь|позже|потом|в\s+следующий\s+раз|дальше)/iu,
  /(?:по\s+запросу|по\s+слову|если\s+скажешь|если\s+нужно)[^.\n]{0,40}(?:сделаю|выполню|пересоберу|отправлю|продолжу|кликну|проверю|доделаю)/iu,
  /(?:осталось|остаётся)\s+(?:только\s+)?(?:доделать|дописать|проверить|собрать|залить|прогнать|исправить|перезапустить)/iu,
  /(?:не\s+успел|не\s+стал\s+(?:проверять|запускать)|не\s+проверял|не\s+запускал|не\s+тестировал)/iu,
  /(?:требует|требуют|нужна|нужно)\s+(?:ещё\s+|еще\s+)?(?:проверк|додел|доработ)/iu,
  /(?:доделаю|доделать|доработаю|доработать)\s+позже/iu,
  /(?:в\s+следующий\s+раз|следующим\s+шагом\s+можно|дальше\s+можно\s+(?:доделать|доработать)|потом\s+можно)/iu,
  /\b(?:will\s+do\s+(?:it\s+)?(?:on\s+request|later|after|next)|after\s+(?:this|the)\s+report|let\s+me\s+know\s+if\s+you'?d\s+like\s+me\s+to|left\s+to\s+do|not\s+yet\s+verified)\b/iu,
];

interface GmMemoryState {
  checksum: string;
  prev: string;
  /** Labels staged earlier in the session (grandmaster-memory.ts keeps the last five). */
  recent?: string[];
  injectedAt: string;
}

/** «ПАМЯТЬ: <12 hex>» staged by grandmaster-memory.ts; exactly 12 hex chars, no more. */
const MEMORY_ACK_RE = /ПАМЯТЬ\s*:\s*\**\s*([0-9a-f]{12})(?![0-9a-f])/i;

/** 7.4: missing or stale memory ack in a status-bearing answer, or null when acceptable. */
export function memoryAckReason(
  text: string,
  memoryExists: boolean,
  state: GmMemoryState | undefined,
): string | null {
  if (!memoryExists || !state || !state.checksum) return null;
  if (parseStatus(text) === null) return null; // trivial answers are never blocked by the ack rule
  const m = MEMORY_ACK_RE.exec(text);
  if (!m)
    return "В ответе со строкой СТАТУС нет подтверждения чтения памяти: добавь сразу после строки статуса «ПАМЯТЬ: <метка>; цель: <одна строка из CURRENT.md>», где метка — значение MEMORY-CHECKSUM из блока PROJECT MEMORY (<<<GM-MEMORY … GM-MEMORY>>>) в системном промпте.";
  // Any label this session ever received counts: memory files change during work (the agent
  // edits CURRENT/EVIDENCE), which rotates the checksum mid-run and must not deadlock the gate.
  const allowed = [state.checksum, state.prev, ...(state.recent ?? [])]
    .filter((x): x is string => typeof x === "string" && /^[0-9a-f]{12}$/.test(x))
    .map((x) => x.toLowerCase())
    .filter((x, i, all) => all.indexOf(x) === i);
  if (!allowed.includes(m[1].toLowerCase()))
    return `Метка ПАМЯТЬ: ${m[1]} не совпадает с последними вставками памяти (ожидалось: ${allowed.join(" или ")}). Перечитай блок PROJECT MEMORY в системном промпте и укажи актуальную метку MEMORY-CHECKSUM.`;
  return null;
}

export function textOf(x: unknown): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(textOf).join("\n");
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if ("content" in o) return textOf(o.content);
  }
  return "";
}

interface StopEvent {
  last_assistant_message?: unknown;
  messages?: unknown;
  session_id?: unknown;
}

function lastAssistantText(event: unknown): string {
  const e = event as Partial<StopEvent>;
  const direct = textOf(e?.last_assistant_message);
  if (direct.trim()) return direct;
  const msgs: unknown[] = Array.isArray(e?.messages) ? e.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown } | undefined;
    if (m?.role === "assistant") return textOf(msgs[i]);
  }
  return "";
}

/**
 * Считает по сообщениям сессии, сколько было правок файлов (`edit`/`write`)
 * и вызовов инструментов вообще. Формат сообщений терпимый: блоки `toolCall`
 * в content, поля `toolName`/`name`. Незнакомый формат просто даёт нули —
 * гейт из-за этого падать не должен.
 */
/** Текст последнего пользовательского сообщения: к нему привязывается приёмка. */
function lastUserText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { role?: unknown; content?: unknown };
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content.map((part) => (typeof part === "string" ? part : (part as { text?: unknown })?.text)).filter((x): x is string => typeof x === "string").join("\n");
			if (text.trim() !== "") return text;
		}
	}
	return "";
}

export function sessionWorkFrom(messages: unknown): SessionWork {
  const work: SessionWork = { edits: 0, calls: 0 };
  const list: unknown[] = Array.isArray(messages) ? messages : [];
  const countCall = (name: unknown): void => {
    if (typeof name !== "string" || name === "") return;
    work.calls += 1;
    if (name === "edit" || name === "write") work.edits += 1;
  };
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const wrapped = "message" in entry ? (entry as { message?: unknown }).message : entry;
    if (wrapped === null || typeof wrapped !== "object") continue;
    const m = wrapped as { role?: unknown; content?: unknown; toolName?: unknown; name?: unknown };
    // Результаты инструментов не считаем: это ответ на вызов, а не вызов.
    if (m.role === "toolResult" || m.role === "tool_result") continue;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as { type?: unknown; toolName?: unknown; name?: unknown };
        const kind = typeof b.type === "string" ? b.type : "";
        if (kind !== "toolCall" && kind !== "tool_call") continue;
        countCall(typeof b.toolName === "string" ? b.toolName : b.name);
      }
    }
    // Одиночная запись вызова без блоков (упрощённый формат сообщений).
    if (m.role === "assistant" && m.toolName !== undefined) countCall(m.toolName);
  }
  return work;
}


/** Open (unverified) ledger items from QUALITY.md and TASKS.md; template-only files are ignored. */
export function openItems(files: ReadonlyArray<{ name: string; raw: string }>): string[] {
  const out: string[] = [];
  for (const { name, raw } of files) {
    if (raw.trimStart().startsWith(TEMPLATE_MARKER)) continue;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (/^-\s*\[\s\]\s*\S/.test(t)) out.push(`${name}: ${t.slice(0, 100)}`);
      if (!t.startsWith("|") || /^\|[\s:|-]+\|?$/.test(t)) continue;
      const c = t.split("|").slice(1, -1).map((cell) => cell.trim());
      if (name === "QUALITY.md" && c.length >= 2 && /^(PENDING|FAILED)$/i.test(c[c.length - 1]) && c[0])
        out.push(`${name}: ${c[0].slice(0, 80)} -> ${c[c.length - 1].toUpperCase()}`);
      if (name === "TASKS.md" && c.length >= 3 && /^(TODO|DOING)$/i.test(c[2]) && c[1])
        out.push(`${name}: ${c[0]} ${c[1].slice(0, 80)} -> ${c[2].toUpperCase()}`);
    }
  }
  return out;
}

export interface TodoLedger {
  open: number;
  items: string[];
}

/** Последний результат инструмента `todo` в сессии: сколько пунктов осталось.
 *  Формат текста инструмента: «Remaining items: none.» либо
 *  «Remaining items (N):\n  - <пункт> [status] (фаза)». Незнакомый формат —
 *  возвращаем null: гейт не должен падать из-за смены текста инструмента. */
export function todoLedgerFrom(messages: unknown): TodoLedger | null {
  const list: unknown[] = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry === null || typeof entry !== "object") continue;
    const wrapped = "message" in entry ? (entry as { message?: unknown }).message : entry;
    if (wrapped === null || typeof wrapped !== "object") continue;
    const m = wrapped as { role?: unknown; toolName?: unknown; content?: unknown };
    if (m.role !== "toolResult" || m.toolName !== "todo") continue;
    const text = textOf(m.content);
    if (/Remaining items:\s*none/i.test(text)) return { open: 0, items: [] };
    const head = /Remaining items\s*\((\d+)\)/i.exec(text);
    if (head === null) continue;
    const open = Number(head[1]);
    const items: string[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("- ") || items.length >= 6) continue;
      items.push(t.replace(/^-\s*/, "").slice(0, 110));
    }
    return { open: Number.isFinite(open) ? open : items.length, items };
  }
  return null;
}

/** Quoted spans, code fences and inline code are citations, not promises: strip before scanning. */

/** The checklist handed to the model at the decisive moment (harness-side, not advice). */
const CHECKLIST =
  "Чек-лист перед итогом: 1) перечитай цель из CURRENT.md и критерии приёмки; " +
  "2) каждый критерий должен иметь строку EVIDENCE: с командой/наблюдением и результатом; " +
  "3) незакрытых пунктов в TASKS.md/QUALITY.md быть не должно — закрой их или пометь BLOCKED с БЛОКЕР:; " +
  "4) ГОТОВО-С-ОГРАНИЧЕНИЯМИ допустим только для того, что помечено тегом [железо]/[чужие-доступы]/[нужно-согласие]/[провайдер]/[физически-нет]; " +
  "5) «потом», «по запросу», «если скажешь» — запрещены: сделай сейчас; " +
  "6) каждый тег ограничения [ … ] обязан иметь рядом доказательство попытки: что именно пробовал и почему путь закрыт.";

export function evaluate(
  text: string,
  open: string[],
  ack?: { memoryExists: boolean; state?: GmMemoryState },
  todo?: TodoLedger | null,
  work?: SessionWork,
): string[] {
  const status = parseStatus(text);
  const reasons: string[] = [];

  // 7.5: no terminal status may hide open ledger items — except an explicit BLOCKED/PARTIAL.
  if ((status === "DONE" || status === "CAVEATS") && open.length > 0)
    reasons.push(
      `Статус ${status === "DONE" ? "ГОТОВО" : "ГОТОВО-С-ОГРАНИЧЕНИЯМИ"}, но в реестре незакрытые пункты: ${open
        .slice(0, 6)
        .join("; ")}. Доведи их до проверенного состояния в этом же прогоне; если пункт физически недостижим — статус BLOCKED и строка «БЛОКЕР: …».`,
    );

  // 8.0: план сессии (todo) — такой же реестр, как TASKS.md/QUALITY.md.
  if ((status === "DONE" || status === "CAVEATS") && todo !== undefined && todo !== null && todo.open > 0)
    reasons.push(
      `Статус ${status === "DONE" ? "ГОТОВО" : "ГОТОВО-С-ОГРАНИЧЕНИЯМИ"}, а в todo-плане этой сессии ${todo.open} открытых пункт(ов): ${todo.items.join("; ") || "см. борд"}. ` +
        "Это твоя собственная декомпозиция: закрой пункты в этом же прогоне, обнови борд и покажи проверку. Если пункт физически недоступен — сними его статусом BLOCKED с «БЛОКЕР: …».",
    );

  // Протокол задач: обратимая правка обязана назвать откат — иначе «готово»
  // оставляет владельца без пути назад.
  if (
    (status === "DONE" || status === "CAVEATS") &&
    (work?.edits ?? 0) > 0 &&
    !ROLLBACK_RE.test(text) &&
    !ROLLBACK_ANY_RE.test(text) &&
    !NO_ROLLBACK_RE.test(text)
  )
    reasons.push(
      PROTOCOL_MARK +
        " файлы менялись, а пути назад в ответе нет. Напиши «ОТКАТ: <как вернуть исходное>» " +
        "(подойдёт и упоминание бэкапа/git revert; если правка необратима — скажи это прямо).",
    );

  // Протокол задач: многошаговая работа оставляет след в документации проекта.
  if (
    (status === "DONE" || status === "CAVEATS") &&
    ((work?.edits ?? 0) >= 2 || (work?.calls ?? 0) >= 12) &&
    !DOCS_RE.test(text) &&
    !NO_DOCS_RE.test(text)
  )
    reasons.push(
      PROTOCOL_MARK +
        " работа многошаговая, а следа документации нет. Скажи, куда записано: «JOURNAL.md» в папке стола, " +
        "«TASK_REPORT.md» — или прямо «документы не нужны: одна правка».",
    );

  // 8.0: оговорка без доказанной попытки — это не ограничение, а несделанная работа.
  if (status === "CAVEATS" && !ATTEMPT_RE.test(text))
    reasons.push(
      "В ответе с ГОТОВО-С-ОГРАНИЧЕНИЯМИ нет ни одного упоминания попытки. Ограничением считается только то, до чего реально дошёл: напиши «пробовал: <что именно> → <результат>» рядом с тегом причины.",
    );

  // 7.5: DONE carries proof; a claim without a run is a guess.
  if (status === "DONE" && !EVIDENCE_RE.test(text))
    reasons.push(
      "Статус ГОТОВО без доказательства. Добавь строку «EVIDENCE: <команда/наблюдение> → <результат>» по каждому критерию приёмки.",
    );

  // 7.5: DONE that still admits uncovered work is self-contradictory.
  if (status === "DONE" && UNDONE_RE.test(text))
    reasons.push(
      "Статус ГОТОВО, но в тексте признано непроверенное/незакрытое. Либо проверь и закрой, либо ставь ГОТОВО-С-ОГРАНИЧЕНИЯМИ с тегом причины или BLOCKED с «БЛОКЕР:».",
    );

  // AGENT_QUALITY_GATE: статус — сертификат. Без контракта нельзя увидеть подмену критериев,
  // без регрессии — побочные поломки, без инвариантов — нарушений, без остатка — скрытые риски.
  if (status === "DONE" || status === "CAVEATS") {
    const missing: string[] = [];
    if (!CONTRACT_RE.test(text)) missing.push("CONTRACT: <измеримые критерии приёмки, AC-01…>");
    if (!REGRESSION_RE.test(text)) missing.push("REGRESSION: <смежные проверки → результат>");
    if (!INVARIANTS_RE.test(text)) missing.push("INVARIANTS: <что проверено как незыблемое → соблюдён>");
    if (!RESIDUAL_RE.test(text)) missing.push("RESIDUAL: <что осталось непроверенным и почему>");
    if (missing.length > 0)
      reasons.push(
        `Статус выставлен без сертификата приёмки: нет строк ${missing.join(", ")}. ` +
          "Критерии нельзя понижать по ходу работы: сначала контракт, потом доказательства по каждому пункту, затем честный остаток.",
      );

    if (RISKY_RE.test(text)) {
      const riskyMissing: string[] = [];
      if (!BASELINE_RE.test(text)) riskyMissing.push("BASELINE: <состояние до изменения>");
      if (!OBSERVABILITY_RE.test(text)) riskyMissing.push("OBSERVABILITY: <службы/логи после → результат>");
      if (!ROLLBACK_RE.test(text)) riskyMissing.push("ROLLBACK: <точка возврата → TESTED/PLANNED/UNAVAILABLE>");
      if (!REVIEW_RE.test(text)) riskyMissing.push("REVIEW: <независимая проверка → вердикт> + путь сертификата");
      if (riskyMissing.length > 0)
        reasons.push(
          `В ответе заявлено рискованное изменение (живая система/обновление/выкатка), но нет строк ${riskyMissing.join(", ")}. ` +
            "Для рискованной работы сертификат полный; самопроверка не заменяет REVIEW — привлекай reviewer/security-reviewer или gm-harness.",
        );
    }
  }

  // 7.5: a caveat must be tagged as physically unreachable.
  if (status === "CAVEATS" && !CAVEAT_TAG_RE.test(text))
    reasons.push(
      "ГОТОВО-С-ОГРАНИЧЕНИЯМИ без тега причины. Каждое ограничение помечай тегом: [железо], [чужие-доступы], [нужно-согласие], [провайдер], [физически-нет]. Всё, что можно сделать самому, — сделай и не перечисляй как ограничение.",
    );

  // 7.5: honest non-success needs a named blocker and evidence of real attempts.
  if (status === "PARTIAL" || status === "BLOCKED") {
    if (!BLOCKER_RE.test(text))
      reasons.push(
        "Статус PARTIAL/BLOCKED без строки «БЛОКЕР: <чего именно не хватает: доступ, файл, железо, чужие данные>».",
      );
    if (!ATTEMPT_RE.test(text))
      reasons.push(
        "Статус PARTIAL/BLOCKED без описания испробованных путей. Перечисли, что уже пробовал (≥2 разные стратегии), прежде чем объявлять блокер.",
      );
  }

  // 7.2: deferral of feasible work is forbidden in a terminal answer. Quoted/code spans are
  // citations (documentation, test fixtures), not promises — they are stripped first.
  if (status !== "PARTIAL" && status !== "BLOCKED" && DEFERRAL_RES.some((re) => re.test(stripQuoted(text))))
    reasons.push(
      "В ответе есть обещание сделать выполнимую работу позже («осталось доделать», «не проверял», «по запросу», «если скажешь» и т.п.). Выполни её сейчас и подтверди выводом. В «не покрыто» допустимо только физически недоступное, с тегом причины.",
    );

  const ackReason = memoryAckReason(text, ack?.memoryExists ?? false, ack?.state);
  if (ackReason) reasons.push(ackReason);
  return reasons;
}

interface StopGateApi {
  on(
    event: "session_stop",
    handler: (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown,
  ): void;
}

/**
 * Независимая приёмка должна быть артефактом, а не словом: ссылка на сертификат quality-gate
 * с вердиктом PASS, логами проверок и независимым ревьюером. Проверяется структура файла,
 * близость к проекту и свежесть — иначе подложенный JSON из одной строки проходит как PASS.
 */
/** Стабильная сериализация: порядок ключей не должен менять подпись. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** Запрос к независимому верификатору: он один знает ключ и решает, что PASS. */
async function askVerifier(cwd: string, slug: string): Promise<{ ok: boolean; detail: string } | null> {
  const socket = process.env.OMP_VERIFIER_SOCKET ?? "/run/omp-verifier/verify.sock";
  try {
    const response = await fetch("http://verifier/", {
      method: "POST",
      unix: socket,
      body: JSON.stringify({ action: "check", project: cwd, slug }),
      signal: AbortSignal.timeout(5000),
    });
    const parsed = (await response.json()) as { ok?: unknown; detail?: unknown };
    return { ok: parsed.ok === true, detail: String(parsed.detail ?? "") };
  } catch {
    return null;
  }
}

/** Подпись проверяется тем же ключом вне проекта: правка JSON ломает MAC. */
function signatureProblem(cert: Record<string, unknown>): string | null {
  const signature = cert.signature as { mac?: string; keyPath?: string } | null | undefined;
  if (!signature || typeof signature.mac !== "string") return "сертификат не подписан";
  const keyPath = process.env.QUALITY_GATE_KEY ?? join(homedir(), ".omp", "gate-key");
  if (!existsSync(keyPath)) return "нет ключа подписи: целостность артефакта не подтверждена";
  const protectedFields = [
    "slug",
    "task",
    "risk",
    "certifiedAt",
    "criteria",
    "baseline",
    "checks",
    "probes",
    "invariants",
    "after",
    "regression",
    "reviews",
    "review",
    "residual",
    "residualNone",
    "security",
    "adversarial",
    "goldfish",
    "artifacts",
    "status",
  ];
  const payload: Record<string, unknown> = {};
  for (const field of protectedFields) payload[field] = cert[field];
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  const expected = createHmac("sha256", key).update(canonical(payload)).digest("hex");
  return expected === signature.mac ? null : "подпись не сходится: артефакт изменён после прогона";
}

export async function reviewCertificateReason(text: string, cwd: string): Promise<string | null> {
  const status = parseStatus(text);
  if (status !== "DONE" && status !== "CAVEATS") return null;
  if (!RISKY_RE.test(text)) return null;
  if (!REVIEW_RE.test(text)) return null; // отсутствие строки ловит evaluate()
  const citation = /(?:^|[\s(«"'`])([\w./-]*\.omp\/gate\/[\w.-]+\/certificate\.json)/u.exec(text)?.[1];
  if (!citation) {
    return (
      "Строка REVIEW есть, но не ссылается на сертификат: независимая проверка должна оставить артефакт. " +
      "Запусти `bun bin/quality-gate.ts review <slug> --spawn` и укажи путь .omp/gate/<slug>/certificate.json."
    );
  }
  const normalized = normalize(citation).replaceAll("\\", "/");
  if (normalized.startsWith("..") || isAbsolute(citation)) {
    return `Сертификат ${citation} лежит вне проекта: приёмка должна подтверждаться артефактом этого проекта (.omp/gate/<slug>/certificate.json).`;
  }
  const full = join(cwd, normalized);
  let parsed: Partial<CertificateShape> | null = null;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8")) as Partial<CertificateShape>;
  } catch {
    return `Сертификат ${citation} не читается: прогони quality-gate run в этом проекте.`;
  }
  const problems: string[] = [];
  const sigProblem = signatureProblem(parsed as Record<string, unknown>);
  if (sigProblem) problems.push(sigProblem);
  if (parsed.status === "FAILED") problems.push("статус сертификата FAILED");
  // Уровни: безопасность, состязательная проверка, целостность артефактов, аттестация.
  const security = Array.isArray(parsed.security) ? parsed.security : [];
  const securityFailed = security.filter((item) => item?.ok === false);
  if (securityFailed.length > 0) problems.push(`безопасность: ${securityFailed.map((item) => item?.name ?? "?").join(", ")}`);
  if (parsed.risk === "high" && (!Array.isArray(parsed.adversarial) || parsed.adversarial.length === 0))
    problems.push("нет состязательной проверки (adversarial)");
  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
  const changed = artifacts.filter((item) => {
    try {
      const data = readFileSync(join(cwd, String(item?.path ?? "")));
      return createHash("sha256").update(data).digest("hex") !== item?.sha256;
    } catch {
      return true;
    }
  });
  if (changed.length > 0) problems.push(`артефакты изменились после проверки: ${changed.map((item) => item?.path ?? "?").join(", ")}`);
  if (parsed.risk === "high") {
    // Аттестацию проверяет только независимый сервис: ключ верификатора недоступен агенту.
    const attestationPath = join(cwd, ".omp", "gate", String(parsed.slug ?? ""), "attestation.json");
    if (!existsSync(attestationPath)) problems.push("нет аттестации независимым верификатором");
    else {
      const verdict = await askVerifier(cwd, String(parsed.slug ?? ""));
      if (verdict === null) problems.push("верификатор недоступен: PASS без него не выдаётся");
      else if (!verdict.ok) problems.push(`аттестат не подтверждён: ${verdict.detail}`);
    }
  }
  const certifiedAt = Date.parse(String(parsed.certifiedAt ?? ""));
  if (!Number.isFinite(certifiedAt) || Date.now() - certifiedAt > 24 * 60 * 60 * 1000) problems.push("сертификат старше суток");
  if (problems.length > 0) return `Сертификат ${citation} не подтверждает приёмку: ${problems.join(", ")}.`;
  return null;
}

interface CertificateShape {
  status: string;
  certifiedAt: string;
  criteria: unknown[];
  checks: { name?: string; cmd?: string; logFile?: string; ok?: boolean; blocking?: boolean; exitCode?: number | null; expectExit?: number; covers?: string[] }[];
  security?: { name?: string; ok?: boolean }[];
  adversarial?: unknown[];
  artifacts?: { path?: string; sha256?: string }[];
  review: { verdict?: string; independent?: boolean; by?: string; at?: string; supersedesFail?: boolean } | null;
  reviews?: { by?: string; at?: string; verdict?: string; supersedesFail?: boolean }[];
  signature?: { mac?: string } | null;
  residual?: unknown[];
  residualNone?: string | null;
  slug?: string;
  task?: string;
  risk?: string;
  baseline?: unknown;
  probes?: unknown;
  invariants?: unknown;
  after?: unknown;
  regression?: unknown;
}

export default function (pi: StopGateApi): void {
  const blocksBySession: Record<string, number> = {};

  pi.on("session_stop", async (event, ctx) => {
    const root = join(ctx.cwd, ".omp", "memory");
    const files: { name: string; raw: string }[] = [];
    let kitProject = false;
    let memoryExists = false;
    // All six ledger files: kitProject = at least one exists; memoryExists = at least one holds
    // real (non-template, non-empty) content — only then is the 7.4 memory-ack rule enforced.
    for (const name of ["CURRENT.md", "TASKS.md", "QUALITY.md", "EVIDENCE.md", "DECISIONS.md", "FAILURES.md"]) {
      try {
        const raw = await readFile(join(root, name), "utf8");
        files.push({ name, raw });
        kitProject = true;
        if (!raw.trimStart().startsWith(TEMPLATE_MARKER) && raw.trim().length > 0) memoryExists = true;
      } catch (err) {
        if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) throw err;
      }
    }
    // Где гейт действует: любой рабочий каталог владельца — стол в ~/OMP,
  // git-проект или каталог с .omp. Раньше проверка выключалась там, где нет
  // .omp/memory, и столы без реестра работали без грандмастера — отсюда
  // расхождение «у одних агентов есть, у других нет». Реестр теперь влияет
  // только на правило памяти (memory-ack), а не на сам факт проверки.
  // Случайные каталоги (например /tmp) не трогаем: там гейт был бы шумом.
  const isWorkArea =
    kitProject ||
    existsSync(join(ctx.cwd, ".git")) ||
    ctx.cwd === join(homedir(), "OMP") ||
    ctx.cwd.startsWith(join(homedir(), "OMP") + "/");
  if (!isWorkArea) return;

    const key = String((event as Partial<StopEvent>)?.session_id ?? ctx.cwd);
    const todo = todoLedgerFrom((event as Partial<StopEvent>)?.messages);
    const used = blocksBySession[key] ?? 0;
    // Лимит блокировок — это НЕ разрешение объявить успех (нашёл аудит: после шести
    // блоков гейт молча пропускал любой финал). Когда лимит исчерпан, требуем ровно
    // один раз честный итог: BLOCKED/PARTIAL с «БЛОКЕР:» и списком попыток. После
    // этого отпускаем — бесконечной ловушки нет, но и тихого PASS тоже.
    const exhausted = used >= MAX_BLOCKS;

    const finalText = lastAssistantText(event);
    const reasons = evaluate(
      finalText,
      openItems(files),
      { memoryExists, state: (globalThis as typeof globalThis & { __gmMemory?: GmMemoryState }).__gmMemory },
      todo,
      sessionWorkFrom((event as { messages?: unknown }).messages),
    );
    const certReason = await reviewCertificateReason(finalText, ctx.cwd);
    if (certReason) reasons.push(certReason);
    // Единое состояние приёмки: ГОТОВО/оговорки принимаются только по подтверждению
    // доверенного верификатора И при неизменённом предмете. Число попыток и
    // формулировка ответа на это не влияют.
    const finalStatus = parseStatus(finalText);
    // Требование приёмки — только для работы с изменениями: разговор без правок
    // не обязан проходить независимую проверку (иначе золотой молоток).
    const work = sessionWorkFrom((event as { messages?: unknown }).messages);
    const didChangeFiles = work.edits > 0 || work.writes > 0 || work.files > 0;
    if (didChangeFiles && (finalStatus === "DONE" || finalStatus === "CAVEATS")) {
      const taskText = lastUserText((event as { messages?: unknown }).messages);
      const acceptanceResult = await proofForProject(ctx.cwd, "result", taskText);
      const acceptance = { ok: acceptanceResult.proof !== null, reason: acceptanceResult.reason };
      if (!acceptance.ok) {
        reasons.push(
          `ПРИЁМКА: успех не подтверждён — ${acceptance.reason}. ` +
            "Пройди независимую проверку (Goldfish) и подтверждение верификатора; до этого честный итог — СТАТУС: PARTIAL или BLOCKED с «БЛОКЕР: …».",
        );
      }
    }
    // Правила протокола — один раз за сессию: дальше не мешаем работать.
    const protocolUsed = protocolBlocks.get(key) ?? 0;
    const protocolReasons = reasons.filter(r => r.startsWith("ПРОТОКОЛ:"));
    const otherReasons = reasons.filter(r => !r.startsWith("ПРОТОКОЛ:"));
    const emittedProtocol = protocolUsed < 1 ? protocolReasons : [];
    if (emittedProtocol.length > 0) protocolBlocks.set(key, protocolUsed + 1);
    reasons.length = 0;
    reasons.push(...otherReasons, ...emittedProtocol);
    if (reasons.length === 0) return;
    // Приёмка не подчиняется бюджету блокировок: исчерпание попыток — это про
    // напоминания о форме, а не разрешение объявить успех без проверки.
    const acceptanceReasons = reasons.filter((r) => r.startsWith("ПРИЁМКА:"));
    if (exhausted && acceptanceReasons.length > 0) {
      const status = parseStatus(finalText);
      if (status === "PARTIAL" || status === "BLOCKED") return;
      blocksBySession[key] = used + 1;
      return {
        decision: "block",
        reason:
          "ГРАНДМАСТЕР · приёмка не подтверждена (" + used + "): " + acceptanceReasons.join(" ") +
          " Успех не принимается ни при каком числе попыток — поставь СТАТУС: PARTIAL или BLOCKED с «БЛОКЕР: …».",
      };
    }
    if (exhausted) {
      // Последнее требование честного статуса уже выдавалось: гейт больше не может
      // влиять на ответ, но обязан оставить след — иначе «успех без проверки»
      // проходил молча. Ответ отпускается, а в журнал уходит запись gate-gave-up.
      if (finalWarned.has(key)) {
        appendEvidence({
          kind: "gate-gave-up",
          at: new Date().toISOString(),
          session: key,
          blocks: used,
          status: parseStatus(finalText) ?? null,
          text: finalText.slice(0, 300),
        });
        return;
      }
      const status = parseStatus(finalText);
      // Честные статусы проходят всегда: BLOCKED и PARTIAL — это не «успех».
      // Но они НЕ закрывают задачу: состояние переводится в needs-fix, и работа
      // продолжается без участия владельца (цель — автономное доведение).
      const honest = status === "BLOCKED" || status === "PARTIAL";
      if (honest) {
        const pending = reasons.filter((r) => !r.startsWith("ПРИЁМКА:"));
        if (pending.length > 0) {
          await mutateTaskState(ctx.cwd, (state) => {
            state.status = "needs-fix";
            state.attempts += 1;
            state.findings = pending.slice(0, 5);
            state.open = Array.from(new Set([...state.open, ...pending.map((r) => r.slice(0, 120))])).slice(0, 12);
          });
        }
        return;
      }
      finalWarned.add(key);
      return {
        decision: "block",
        reason:
          "ГРАНДМАСТЕР · стоп-гейт: лимит блокировок исчерпан, но финал всё ещё не оформлен честно. " +
          "Переформулировка не поможет: поставь СТАТУС: BLOCKED или PARTIAL, добавь строку «БЛОКЕР: <что именно мешает>» " +
          "и перечисли испробованные стратегии. Это последнее замечание — дальше гейт не мешает.",
      };
    }
    blocksBySession[key] = used + 1;
    await mutateTaskState(ctx.cwd, (state) => {
      state.status = "needs-fix";
      state.attempts += 1;
      state.findings = reasons.slice(0, 5);
      state.open = Array.from(new Set([...state.open, ...reasons.map((r) => r.slice(0, 120))])).slice(0, 12);
    });
    const escalation =
      used + 1 >= 3
        ? " Ты уже блокировался несколько раз в этой сессии: переформулировка ответа не поможет — закрой открытые пункты (todo/реестр), " +
          "проверь результат запуском и только потом ставь статус. Если путь закрыт — смени стратегию или отчитайся PARTIAL с «БЛОКЕР: …» и списком попыток."
        : "";
    return {
      decision: "block",
      reason:
        `${gmLabel()} · стоп-гейт (${used + 1}/${MAX_BLOCKS}): ` + reasons.join(" ") + " " + CHECKLIST + escalation,
    };
  });
}
