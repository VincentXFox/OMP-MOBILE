/**
 * GRANDMASTER adversarial review gate.
 *
 * Зачем: stop-gate 8.0 проверяет форму ответа (статус, EVIDENCE, теги, реестр), но не требует
 * попытки ОПРОВЕРГНУТЬ результат. Поэтому «всё работает» звучало одинаково и когда проверен
 * только счастливый путь, и когда результат действительно ломался под нагрузкой. Здесь —
 * обязательный шаг: перед ГОТОВО / ГОТОВО-С-ОГРАНИЧЕНИЯМИ в ответе должна быть строка
 * состязательной проверки, где есть (а) что пытались опровергнуть, (б) артефакт (команда, путь,
 * независимый ревизор), (в) вердикт.
 *
 * Принимается любой из вариантов:
 *   - `ADVERSARIAL: <гипотеза> → <команда/путь> → <PASS|FAIL|найдено …>`
 *   - «опровергнуть не удалось: <что пробовал> → <результат>»
 *   - независимый разбор субагентом reviewer / security-reviewer с вердиктом
 *   - прогон `gm-harness` (у сценария обязателен negative control) с результатом
 *
 * Граница (честно): хук проверяет наличие шага и артефакта, а не правдивость отчёта. Выдумать
 * строку дешевле, чем прогнать negative control, но в транскрипте это видно — а без строки
 * ответ не пройдёт вообще.
 *
 * Блокирует не больше 3 раз за сессию (антидедлок).
 */
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Сколько раз подряд один и тот же текст может быть заблокирован (антидедлок). */
const MAX_BLOCKS = 3;
/** Жёсткий потолок блокировок за сессию: даже при разных текстах не бесконечно. */
const MAX_BLOCKS_TOTAL = 10;

type Status = "DONE" | "CAVEATS" | "PARTIAL" | "BLOCKED";

import { proofForProject } from "../lib/trusted-verification.ts";
import { parseStatus } from "../lib/status.ts";

const LOCAL_STATUS_RE =
  /(?:СТАТУС|STATUS)[ \t]*:[ \t]*\**[ \t]*(ГОТОВО-С-ОГРАНИЧЕНИЯМИ|DONE-WITH-CAVEATS|ГОТОВО|DONE|PARTIAL|BLOCKED)/iu;

/** Анализируем только хвост ответа: огромные полотна не должны вешать event loop. */
const MAX_ANALYZED_CHARS = 200_000;
/** Сколько строк после метки считается телом состязательного разбора. */
const REVIEW_BLOCK_LINES = 6;

/** Метка состязательного шага (рус/англ). */
const REVIEW_HEAD_RE =
  /(?:^|\n)[ \t]*[-*_#\d.]*[ \t]*(?:ADVERSARIAL(?:\s+REVIEW)?|ОПРОВЕРЖЕНИЕ|СОСТЯЗАТЕЛЬН[\p{L}\p{N}_]*\s+ПРОВЕРК[\p{L}\p{N}_]*|СОПРОТИВЛЕНИЕ)[ \t]*[:\-—]/iu;

/** Вердикт: результат попытки, а не обещание проверить. Голое «ok» не считается:
 * принимается стрелка с исходом (PASS/FAIL/найдено N/провал) или явная формулировка
 * «опровергнуть не удалось … → результат». */
const VERDICT_RE =
  /(?:→|->)[ \t]*(?:\**[ \t]*)?(?:PASS|FAIL|ОК|ПРОВАЛ|провал|найдено[ \t]*\d+|нашли[ \t]*\d+|не[ \t]+удалось[ \t]+опроверг[\p{L}\p{N}_]*|exit[ \t]*=?[ \t]*\d+|код[ \t]+\d+)/iu;

/** Артефакт, который можно перепроверить: инструмент, субагент или путь с расширением. */
const ARTIFACT_RE =
  /(?:\b(?:bun|node|bash|git|curl|systemctl|gm-harness|chaos|reviewer|security-reviewer|субагент|subagent)\b|\b[\w./-]+\.(?:md|json|jsonl|ts|sh|log|txt)\b|--[a-z-]{3,})/iu;

const INSTRUCTION =
  "Перед статусом нужен состязательный шаг: попытайся ОПРОВЕРГНУТЬ результат, а не подтвердить его. " +
  "Минимум одно: (1) `gm-harness run <сценарий>` — сценарий обязан содержать negative control, иначе проверка пустая; " +
  "(2) независимый разбор субагентом `reviewer`/`security-reviewer` с вердиктом; " +
  "(3) свой контрпример: команда, которая должна сломать утверждение, и её фактический вывод. " +
  "В ответ добавь строку `ADVERSARIAL: <что пытался опровергнуть> → <команда/путь/агент> → <PASS|FAIL|найдено …>`.";

/** Номер строки, внутри ли она фенса (```) — маркер внутри кода не считается проверкой. */
function fenceFlags(lines: readonly string[]): boolean[] {
  const flags: boolean[] = [];
  let inside = false;
  for (const line of lines) {
    // Фенс — только строка, которая им начинается: «```» внутри текста цитатой не считается.
    const opensFence = /^[ \t]{0,3}(?:```|~~~)/.test(line);
    flags.push(inside || opensFence);
    if (opensFence) inside = !inside;
  }
  return flags;
}

/** Строка внутри цитаты («…», “…” или "…") — ссылка, а не собственный шаг.
 * Проверка линейная (lastIndexOf), без квадратичного регекспа на длинных вставках. */
function looksQuoted(line: string, markerIndex: number): boolean {
  const before = line.slice(0, markerIndex);
  const pairs: Array<[string, string]> = [
    ["«", "»"],
    ["“", "”"],
    ['"', '"'],
  ];
  for (const [open, close] of pairs) {
    const lastOpen = before.lastIndexOf(open);
    if (lastOpen < 0) continue;
    const lastClose = before.lastIndexOf(close, before.length - 1);
    if (lastClose < lastOpen) return true; // открыли и не закрыли — значит внутри цитаты
  }
  return false;
}

/** Блок состязательной проверки: сама строка-метка и следующие непустые строки.
 * Разбор идёт ТОЛЬКО по нему: иначе хвост вида `EVIDENCE: bun test → PASS` подпирал бы
 * метку чужими артефактом и вердиктом. */
/** Все кандидаты-блоки разбора: сначала метка, затем её строки до следующей секции. */
export function reviewBlocks(text: string): string[] {
  const bounded = text.length > MAX_ANALYZED_CHARS ? text.slice(-MAX_ANALYZED_CHARS) : text;
  const lines = bounded.split("\n");
  const fences = fenceFlags(lines);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const head = REVIEW_HEAD_RE.exec(line);
    if (head === null) continue;
    if (fences[i] === true) continue; // маркер внутри ``` — это цитата
    if (looksQuoted(line, head.index)) continue;
    const block: string[] = [line];
    for (let j = i + 1; j < lines.length && block.length < REVIEW_BLOCK_LINES; j++) {
      const next = lines[j] ?? "";
      if (next.trim() === "") break;
      // Следующая секция (статус, доказательства, блокер) — уже не часть разбора:
      // иначе чужой EVIDENCE подпирал бы метку своим артефактом и вердиктом.
      if (/^[ \t]*(?:СТАТУС|STATUS|EVIDENCE|ДОКАЗАТЕЛЬСТВ|ПАМЯТЬ|БЛОКЕР|ADVERSARIAL|ОПРОВЕРЖЕНИЕ|СОПРОТИВЛЕНИЕ)\b/iu.test(next)) break;
      block.push(next);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

/** Обратная совместимость: первый блок (для проб и отладки). */
export function reviewBlock(text: string): string | null {
  const blocks = reviewBlocks(text);
  return blocks.length === 0 ? null : (blocks[0] ?? null);
}

export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value !== null && typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("content" in value) return textOf(value.content);
  }
  return "";
}

export { parseStatus } from "../lib/status.ts";

function lastAssistantText(event: unknown): string {
  if (event !== null && typeof event === "object") {
    if ("last_assistant_message" in event) {
      const direct = textOf(event.last_assistant_message);
      if (direct.trim()) return direct;
    }
    if ("messages" in event) {
      const messages = event.messages;
      const list: unknown[] = Array.isArray(messages) ? messages : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry !== null && typeof entry === "object" && "role" in entry && entry.role === "assistant") return textOf(entry);
      }
    }
  }
  return "";
}

function sessionKeyOf(event: unknown, cwd: string): string {
  if (event !== null && typeof event === "object" && "session_id" in event) {
    const id = event.session_id;
    if (typeof id === "string" && id !== "") return id;
  }
  return cwd;
}

export interface ReviewVerdict {
  present: boolean;
  line: string | null;
  missing: string[];
}

/** Есть ли в ответе попытка опровержения с артефактом и вердиктом. */
export function inspectReview(text: string): ReviewVerdict {
  const blocks = reviewBlocks(text);
  if (blocks.length === 0) return { present: false, line: null, missing: ["строка ADVERSARIAL:", "артефакт", "вердикт"] };
  // Достаточно ОДНОГО полного блока: упоминание формата в начале ответа не должно мешать.
  let firstMissing: string[] = [];
  for (const block of blocks) {
    const missing: string[] = [];
    if (!ARTIFACT_RE.test(block)) missing.push("артефакт (команда, путь или независимый ревизор)");
    if (!VERDICT_RE.test(block)) missing.push("вердикт (PASS/FAIL/«опровергнуть не удалось» + результат)");
    if (missing.length === 0) {
      const firstLine = block.split("\n")[0] ?? "";
      return { present: true, line: firstLine.slice(0, 160), missing: [] };
    }
    if (firstMissing.length === 0) firstMissing = missing;
  }
  const firstLine = (blocks[0] ?? "").split("\n")[0] ?? "";
  return { present: false, line: firstLine.slice(0, 160), missing: firstMissing };
}

/** Причина блока или null, если ответ в порядке. */
const EVIDENCE_RE = /(?:^|\n)\s*(?:EVIDENCE|ДОКАЗАТЕЛЬСТВ[АО]|ПРОВЕРЕНО|ПРОВЕРКА|VERIFIED|TESTED)\s*[:\-]/iu;

/** Заявление о результате: если оно есть, честный PARTIAL тоже обязан показать разбор. */
const RESULT_CLAIM_RE =
  /(?:сделано|исправлено|добавлено|реализовано|настроено|работает|проверено|обновлено|исправил|добавил|сделал|починил|устранил|переписал|доделал|довёл|довел|собрал|перезапустил|запустил|готово[ \t]+к[ \t]+работе|implemented|fixed|added|works|verified|repaired|rewrote)/iu;

export function evaluateReview(text: string): string | null {
  const status = parseStatus(text);
  if (status === null) return null; // тривиальный ответ без статуса не проверяем
  // PARTIAL/BLOCKED без доказательств и без заявленного результата — там свои требования
  // (БЛОКЕР + попытки). Но если ответ предъявляет EVIDENCE или заявляет результат,
  // состязательный шаг обязателен: иначе «объявлю PARTIAL» — дешёвый обход гейта.
  if ((status === "PARTIAL" || status === "BLOCKED") && !EVIDENCE_RE.test(text) && !RESULT_CLAIM_RE.test(text)) return null;
  const verdict = inspectReview(text);
  if (verdict.present) return null;
  const detail =
    verdict.line === null
      ? "строка ADVERSARIAL: отсутствует"
      : `в строке «${verdict.line}» не хватает: ${verdict.missing.join(", ")}`;
  return `Нет состязательной проверки (${detail}). ${INSTRUCTION}`;
}

interface GmApi {
  on(event: "session_stop", handler: (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown): void;
}

type StopHandler = (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown;

/** Регистрация гейта: отдельная функция, чтобы регрессия могла взять обработчик напрямую. */
const MAX_TRACKED_SESSIONS = 200;

export function registerAdversarialGate(api: GmApi): void {
  const blocksBySession = new Map<string, { hash: string; same: number; total: number }>();
  api.on("session_stop", async (event, ctx) => {
    // Область действия — как у стоп-гейта: рабочий каталог владельца (стол в ~/OMP,
    // git-проект или каталог с .omp). Раньше признаком было ТОЛЬКО наличие
    // .omp/memory, из-за чего состязательная проверка молча выключалась в 22 столах
    // из 25 (нашёл аудит; это же было исходной жалобой владельца).
    const memoryDir = join(ctx.cwd, ".omp", "memory");
    let memoryReadable = false;
    try {
      accessSync(memoryDir, constants.R_OK | constants.X_OK);
      readdirSync(memoryDir);
      memoryReadable = true;
    } catch (err) {
      const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "";
      // Ошибка прав/типа каталога означает «контекст проверить нельзя»: блокируем.
      if (code !== "ENOENT") {
        process.stderr.write(`adversarial-review: память проекта недоступна (${code || "ошибка"}) — финал блокируется\n`);
        memoryReadable = true;
      }
    }
    const isWorkArea =
      memoryReadable ||
      existsSync(join(ctx.cwd, ".omp")) ||
      existsSync(join(ctx.cwd, ".git")) ||
      ctx.cwd === join(homedir(), "OMP") ||
      ctx.cwd.startsWith(join(homedir(), "OMP") + "/");
    if (!isWorkArea) return;
    let reason: string | null;
    try {
      reason = evaluateReview(lastAssistantText(event));
    } catch (err) {
      // Исключение внутри разбора не должно молча пропускать финал (B2).
      reason = `разбор ответа упал (${err instanceof Error ? err.message : String(err)}) — финал не подтверждён`;
    }
    // То же состояние приёмки, что у стоп-гейта: успех без подтверждения не проходит.
    const claimed = parseStatus(lastAssistantText(event));
    // Разговор без изменений файлов приёмки не требует — требование привязано к работе.
    const changed = /\"(?:edit|write)\"\s*:/.test(JSON.stringify((event as { messages?: unknown }).messages ?? []));
    if (changed && (claimed === "DONE" || claimed === "CAVEATS")) {
      const acceptanceResult = await proofForProject(ctx.cwd, "result");
      const acceptance = { ok: acceptanceResult.proof !== null, reason: acceptanceResult.reason };
      if (!acceptance.ok) reason = `приёмка не подтверждена: ${acceptance.reason} — поставь PARTIAL или BLOCKED с «БЛОКЕР: …»`;
    }
    if (reason === null) return;
    const key = sessionKeyOf(event, ctx.cwd);
    const text = lastAssistantText(event);
    const hash = String(Bun.hash(text));
    const state = blocksBySession.get(key) ?? { hash, same: 0, total: 0 };
    if (state.hash === hash) state.same += 1;
    else {
      state.hash = hash;
      state.same = 1; // текст изменился — это прогресс, счётчик дедлока начинается заново
    }
    state.total += 1;
    if (blocksBySession.size >= MAX_TRACKED_SESSIONS && !blocksBySession.has(key)) {
      const oldest = blocksBySession.keys().next().value;
      if (oldest !== undefined) blocksBySession.delete(oldest);
    }
    blocksBySession.set(key, state);
    if (state.same > MAX_BLOCKS || state.total > MAX_BLOCKS_TOTAL) {
      // Антидедлок: одинаковый текст блокировали MAX_BLOCKS раз подряд — дальше не блокируем,
      // но это видно в логе. Изменённый текст счётчик сбрасывает, так что «сжечь бюджет»
      // разными формулировками не выйдет (A1).
      process.stderr.write(`adversarial-review: ${state.same} одинаковых финалов подряд без разбора — пропускаю, но это не сертифицировано\n`);
      return;
    }
    const escalation =
      state.same >= 2
        ? " Это повторный блок: переписывание текста не поможет — прогони проверку (gm-harness/reviewer/контрпример) и приведи её вывод."
        : "";
    return { decision: "block", reason: `ГРАНДМАСТЕР · состязательная проверка (adversarial-review, ${state.same}/${MAX_BLOCKS}): ${reason}${escalation}` };
  });
}

export default function (pi: GmApi): void {
  registerAdversarialGate(pi);
}

/** Для gm-regression.sh: зарегистрированный обработчик session_stop. */
export function gmAdversarialHandler(): StopHandler | null {
  let handler: StopHandler | null = null;
  registerAdversarialGate({
    on(_event, h) {
      handler = h;
    },
  });
  return handler;
}
