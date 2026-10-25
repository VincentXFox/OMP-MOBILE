#!/usr/bin/env bun
// local-ask — узкие вопросы к локальной модели по HTTP, без агентной обёртки.
//
// Идея взята из чужого omp-AGENTS.md (dump omp-llm-request-*.json, машина gwushor):
// там измерено, что «ризонер/решатель через агента» — 4 мин 34 с и галлюцинации
// вызовов инструментов, а тот же вопрос скриптом — 11 с и чистая строка ответа.
// У нас та же картина: `omp -p` тратит 2–4 мин на подъём сессии, а прямой
// /v1/chat/completions к локальному серверу — секунды.
//
// Когда использовать: извлечение полей, классификация, да/нет, сжатие,
// «прочитай эти файлы и верни факты», выбор из перечисленных вариантов.
// Когда НЕ использовать: широкие знания, многошаговые агентные задачи,
// всё, что нельзя проверить глазами за минуту.
//
//   local-ask "вопрос" [--model <id>] [--base http://127.0.0.1:8080/v1] [--json]
//   echo "текст" | local-ask --stdin "..."
//
// Код возврата: 0 — есть ответ, 1 — сервер недоступен/ошибка модели, 2 — плохой ввод.

const DEFAULT_BASE = process.env.LOCAL_ASK_BASE ?? "http://127.0.0.1:8080/v1";
const DEFAULT_MODEL = process.env.LOCAL_ASK_MODEL ?? "qwen3-vl-4b";
const TIMEOUT_MS = Number(process.env.LOCAL_ASK_TIMEOUT_MS ?? 120_000);

function usage(): void {
  process.stdout.write(`local-ask — узкий вопрос к локальной модели по HTTP

  local-ask "<вопрос>" [--model <id>] [--base <url>] [--json] [--system "<текст>"]
  echo "<контекст>" | local-ask --stdin "<вопрос>"

Переменные: LOCAL_ASK_BASE, LOCAL_ASK_MODEL, LOCAL_ASK_TIMEOUT_MS.
`);
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
  usage();
  process.exit(argv.length === 0 ? 2 : 0);
}

let question = "";
let model = DEFAULT_MODEL;
let base = DEFAULT_BASE;
let jsonMode = false;
let system = "Отвечай кратко и по делу. Если ответа нет в данных — скажи об этом прямо.";
let useStdin = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model") model = argv[++i] ?? fail("--model требует значение", 2);
  else if (a === "--base") base = argv[++i] ?? fail("--base требует значение", 2);
  else if (a === "--system") system = argv[++i] ?? fail("--system требует значение", 2);
  else if (a === "--json") jsonMode = true;
  else if (a === "--stdin") useStdin = true;
  else if (!a.startsWith("--")) question = a;
  else fail(`неизвестный флаг: ${a}`, 2);
}

if (useStdin) {
  const piped = await Bun.stdin.text();
  question = `${piped.trim()}\n\nВопрос: ${question}`.trim();
}
if (question.trim().length === 0) fail("пустой вопрос", 2);

const messages = [
  { role: "system", content: system },
  { role: "user", content: question },
];

let res: Response;
try {
  res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 800, stream: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (err) {
  fail(`локальный сервер недоступен (${base}): ${err instanceof Error ? err.message : String(err)}`, 1);
}
if (!res.ok) fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 1);

const data = (await res.json()) as {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
const text = data.choices?.[0]?.message?.content?.trim() ?? "";
if (text.length === 0) fail("модель вернула пустой ответ", 1);

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({ model, base, text, usage: data.usage ?? null })}\n`);
} else {
  process.stdout.write(`${text}\n`);
}
