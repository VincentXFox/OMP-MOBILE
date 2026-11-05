/**
 * No-CJK stop guard (user rule, 2026-10-16).
 *
 * Пользователь: в текстах для него не должно быть азиатских символов — никогда,
 * даже в примерах и цитатах (описывать словами). Причина: срывы китайских моделей
 * (GLM/DeepSeek) в иероглифы; одно такое сообщение уже ушло пользователю.
 *
 * Контракт как у grandmaster-stop-gate: pi.on("session_stop") -> { decision:"block", reason }.
 * Блокируем не более MAX_BLOCKS раз на сессию; любые внутренние ошибки — fail-open.
 */

const MAX_BLOCKS = 2;

/** Han, CJK punctuation, kana, hangul, Myanmar, fullwidth forms. */
const CJK_RE =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff\u1000-\u109f\uff00-\uffef]/u;

function textOf(x: unknown): string {
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

interface StopGuardApi {
  on(
    event: "session_stop",
    handler: (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown,
  ): void;
}

export default function (pi: StopGuardApi): void {
  const blocksBySession: Record<string, number> = {};

  pi.on("session_stop", (event, ctx) => {
    try {
      const text = lastAssistantText(event);
      if (!text) return;
      const hit = CJK_RE.exec(text);
      if (!hit) return;
      const cp = hit[0].codePointAt(0);
      const key = String((event as Partial<StopEvent>)?.session_id ?? ctx.cwd);
      const used = blocksBySession[key] ?? 0;
      if (used >= MAX_BLOCKS) return;
      blocksBySession[key] = used + 1;
      return {
        decision: "block",
        reason:
          `Запрет иероглифов (${used + 1}/${MAX_BLOCKS}): в финальном ответе найден азиатский символ (U+${(
            cp ?? 0
          )
            .toString(16)
            .toUpperCase()
            .padStart(4, "0")}). Правило пользователя: ни одного CJK/азиатского символа в текстах для него — даже в примерах и цитатах; описывай словами. Перепиши финальный ответ без этих символов и заверши.`,
      };
    } catch {
      return; // fail-open: гейт никогда не должен ломать остановку сам по себе
    }
  });
}
