#!/usr/bin/env bun
// harness-reflect — ежедневная рефлексия по сессиям: уроки с доказательствами.
//
// Идея взята из Harness² (google-research/harness2): второй уровень рекурсии —
// «улучшающий гарнесс». После задач остаются не только правила, но и библиотека
// уроков формата `cue / lesson / evidence / confidence`, а в промпт попадает
// только отобранный и ограниченный по объёму топ.
//
// Источник уроков — наблюдаемые факты из сессий за окно (по умолчанию сутки):
// блоки стоп-гейта, отказы todo-first, срабатывания loop-breaker, падения
// инструментов, финальные статусы, итоги автономных задач. Модель не имеет
// права выдумать урок без факта в диджесте: в промпте это сказано прямо, а
// невалидные записи отбрасываются.
//
// Запуск:
//   harness-reflect run [--dry-run] [--hours 24] [--model <id>]
//   harness-reflect status
//
// Файлы: ~/.omp/agent/harness/{LESSONS.md,reflect-state.json} и блок уроков
// в ~/.omp/agent/RULES.md между маркерами <!-- harness:lessons:begin/end -->.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runOmp } from "../gateway/hosts.ts";
import { listSessions } from "../gateway/sessions.ts";
import { tasksDir } from "../gateway/autonomy/store.ts";
import type { Task } from "../gateway/autonomy/types.ts";

const AGENT_DIR = join(homedir(), ".omp", "agent");
const HARNESS_DIR = join(AGENT_DIR, "harness");
const LESSONS_FILE = join(HARNESS_DIR, "LESSONS.md");
const STATE_FILE = join(HARNESS_DIR, "reflect-state.json");
const RULES_FILE = join(AGENT_DIR, "RULES.md");

const LESSON_BEGIN = "<!-- harness:lessons:begin -->";
const LESSON_END = "<!-- harness:lessons:end -->";

/** Каталог задач автономного контроллера (там же, где их пишет шлюз). */
const OMP_REPO_RELATIVE = "omp-mobile/gateway";

const MAX_SESSIONS = 25;
const TAIL_BYTES = 256 * 1024;
const MAX_LESSONS_PER_RUN = 5;
const LESSONS_IN_PROMPT = 8;
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const LLM_TIMEOUT_MS = 600_000;

type Confidence = "high" | "medium" | "low";

interface Lesson {
  cue: string;
  lesson: string;
  evidence: string;
  confidence: Confidence;
  added: string;
  sessions: string[];
}

interface DigestRow {
  sessionId: string;
  title: string;
  status: string;
  ageHours: number;
  counters: Record<string, number>;
  preview: string;
}

// ── сбор фактов ──────────────────────────────────────────────────────────────

const MARKERS: Record<string, RegExp> = {
  stopGate: /GRANDMASTER stop-gate/g,
  todoFirst: /GRANDMASTER 8 todo-first/g,
  loopBreaker: /loop-breaker:/g,
  toolErrors: /"isError":true/g,
  providerErrors: /Insufficient balance|rate limit|429|502 Bad Gateway/gi,
  statusDone: /СТАТУС:\s*ГОТОВО/g,
  statusCaveat: /СТАТУС:\s*ГОТОВО-С-ОГРАНИЧЕНИЯМИ/g,
  statusPartial: /СТАТУС:\s*(?:PARTIAL|BLOCKED)/g,
};

function countMarkers(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of Object.entries(MARKERS)) out[name] = [...text.matchAll(re)].length;
  return out;
}

function tailOf(path: string): string {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function collectDigest(hours: number): DigestRow[] {
  const now = Date.now();
  const rows: DigestRow[] = [];
  for (const session of listSessions(new Set<string>())) {
    const ageHours = (now - session.modified) / 3_600_000;
    if (ageHours > hours) continue;
    const tail = tailOf(session.path);
    const counters = countMarkers(tail);
    const interesting =
      counters.stopGate + counters.todoFirst + counters.loopBreaker + counters.toolErrors + counters.providerErrors > 0 ||
      session.status === "interrupted" ||
      session.status === "aborted" ||
      session.status === "error";
    if (!interesting) continue;
    rows.push({
      sessionId: session.id,
      title: session.title ?? session.preview ?? "(без названия)",
      status: session.status,
      ageHours: Math.round(ageHours * 10) / 10,
      counters,
      preview: (session.preview ?? "").slice(0, 120),
    });
  }
  return rows.sort((a, b) => a.ageHours - b.ageHours).slice(0, MAX_SESSIONS);
}

function taskDigest(): string[] {
  const dir = tasksDir(join(homedir(), OMP_REPO_RELATIVE));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const name of names.slice(0, 15)) {
    try {
      const task = JSON.parse(readFileSync(join(dir, name), "utf8")) as Task;
      const spend = `${Math.round((task.spend?.inputTokens ?? 0) / 1000)}k in / ${Math.round((task.spend?.outputTokens ?? 0) / 1000)}k out`;
      lines.push(
        `- задача «${task.goal.slice(0, 90)}» → ${task.status}` +
          (task.stopReason ? ` (${task.stopReason.kind}: ${task.stopReason.detail.slice(0, 100)})` : "") +
          ` · ходов ${task.turns} · ${spend}`,
      );
    } catch {
      continue;
    }
  }
  return lines;
}

// ── библиотека уроков ────────────────────────────────────────────────────────

/** Урок не должен отменять базовые инварианты гарнесса. Модель иногда выводит
 *  из шума «делай без плана/без проверок» — такое отбрасываем с записью в лог:
 *  библиотека уроков уточняет гарнесс, а не сносит его. */
const CONFLICT_RES: readonly RegExp[] = [
  /без\s+(?:плана|планирования|todo|проверк|тестов|субагент)/iu,
  /не\s+(?:проверять|запускать|тестировать|планировать|делать\s+todo)/iu,
  /(?:пропустить|игнорировать|отключить)\s+(?:проверк|план|тест|todo)/iu,
  /без\s+расширенного\s+плана/iu,
];

function conflictsWithInvariants(lesson: Lesson): boolean {
  const text = `${lesson.cue} ${lesson.lesson}`;
  return CONFLICT_RES.some((re) => re.test(text));
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Разбор библиотеки. Формат блока: `- cue: <текст>`, далее строки `lesson:`/`evidence:`/
 *  `confidence:`/`added:`. Разбор идёт по «сырым» блокам: инвариантный veto применяется
 *  отдельно (readLessons), чтобы sanitize мог отчитаться о выброшенных. */
function readLessonsAll(): Lesson[] {
  if (!existsSync(LESSONS_FILE)) return [];
  const text = readFileSync(LESSONS_FILE, "utf8");
  const out: Lesson[] = [];
  for (const block of text.split(/^- cue:/m).slice(1)) {
    const lines = block.split("\n");
    const cue = (lines[0] ?? "").trim();
    const grab = (key: string): string => {
      const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(block);
      return m?.[1]?.trim() ?? "";
    };
    const confidence = grab("confidence");
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") continue;
    const lesson = grab("lesson");
    if (cue === "" || lesson === "") continue;
    out.push({
      cue,
      lesson,
      evidence: grab("evidence"),
      confidence,
      added: grab("added").split("·")[0]?.trim() ?? "",
      sessions: [],
    });
  }
  return out;
}

function readLessons(): Lesson[] {
  return readLessonsAll().filter((l) => !conflictsWithInvariants(l));
}

function writeLessonsFile(lessons: readonly Lesson[]): void {
  mkdirSync(HARNESS_DIR, { recursive: true });
  const head = `# Библиотека уроков гарнесса\n\n_Формат из Harness²: cue → lesson → evidence → confidence. Урок без доказательства\nне принимается; в промпт попадает только отобранный топ (см. \`bin/harness-reflect.ts\`)._\n`;
  const body = lessons
    .map(
      (l) =>
        `- cue: ${l.cue}\n  lesson: ${l.lesson}\n  evidence: ${l.evidence}\n  confidence: ${l.confidence}\n  added: ${l.added}${l.sessions.length > 0 ? ` · сессии: ${l.sessions.join(", ")}` : ""}`,
    )
    .join("\n\n");
  writeFileSync(LESSONS_FILE, `${head}\n${body}\n`);
}

function pickedForPrompt(lessons: readonly Lesson[]): Lesson[] {
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  const recentCut = Date.now() - 30 * 24 * 3_600_000;
  return lessons
    .filter((l) => l.confidence === "high" || (l.confidence === "medium" && Date.parse(l.added) >= recentCut))
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || Date.parse(b.added) - Date.parse(a.added))
    .slice(0, LESSONS_IN_PROMPT);
}

/** Переписать блок уроков в RULES.md, не трогая остальной текст правил. */
function syncRules(lessons: readonly Lesson[]): number {
  const picked = pickedForPrompt(lessons);
  const original = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, "utf8") : "";
  let rules = original;
  const begin = rules.indexOf(LESSON_BEGIN);
  const end = rules.indexOf(LESSON_END);
  if (begin >= 0 && end > begin) rules = `${rules.slice(0, begin).trimEnd()}\n${rules.slice(end + LESSON_END.length).trimStart()}`;
  const block =
    picked.length === 0
      ? ""
      : `\n${LESSON_BEGIN}\n## Уроки из практики (автоотбор, ${picked.length} из ${lessons.length})\n` +
        picked.map((l) => `- ${/^когда/i.test(l.cue) ? l.cue : `Когда ${l.cue}`} — ${l.lesson} (${l.confidence}, ${l.added}).`).join("\n") +
        `\nПолная библиотека: ~/.omp/agent/harness/LESSONS.md.\n${LESSON_END}\n`;
  // Сравниваем с ИСХОДНЫМ файлом, а не с уже очищенной локальной копией:
  // иначе удаление блока не записывается (next === stripped rules).
  const next = `${rules.trimEnd()}\n${block}`;
  if (next !== original) writeFileSync(RULES_FILE, next);
  return picked.length;
}

// ── модель ───────────────────────────────────────────────────────────────────

function promptFor(rows: readonly DigestRow[], tasks: readonly string[], existing: readonly Lesson[]): string {
  const digest =
    rows.length === 0
      ? "(сессий с инцидентами за окно нет)"
      : rows
          .map((r) => {
            const counters = Object.entries(r.counters)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            return `- ${r.sessionId.slice(0, 8)} · ${r.ageHours} ч назад · ${r.status} · «${r.title.slice(0, 80)}»${counters ? ` · ${counters}` : ""}${r.preview ? ` · запрос: ${r.preview}` : ""}`;
          })
          .join("\n");
  const known =
    existing.length === 0 ? "(пусто)" : existing.slice(0, 12).map((l) => `- ${l.lesson}`).join("\n");
  return `Ты ведёшь библиотеку уроков для агента-кодера. Уроки извлекаются ТОЛЬКО из наблюдаемых фактов ниже; придумывать общие советы («пиши тесты», «будь внимателен») запрещено.

Факты за окно (агрегаты по сессиям, маркеры посчитаны по логу):
${digest}

Автономные задачи:
${tasks.length === 0 ? "(нет)" : tasks.join("\n")}

Уже известные уроки (не повторяй их, нужны только новые):
${known}

Сформулируй до ${MAX_LESSONS_PER_RUN} уроков. Для каждого нужен конкретный факт из диджеста, который его подтверждает.

Ответ — ТОЛЬКО JSON без пояснений:
{"lessons":[{"cue":"когда <условие>","lesson":"<что делать конкретно>","evidence":"<факт из диджеста: сессия/маркер/цифра>","confidence":"high|medium|low"}]}

Если фактов для нового урока нет — верни {"lessons":[]}.`;
}

function parseLessons(text: string, rows: readonly DigestRow[], existing: readonly Lesson[]): Lesson[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || !("lessons" in parsed)) return [];
  const list = (parsed as { lessons: unknown }).lessons;
  if (!Array.isArray(list)) return [];
  const known = new Set(existing.map((l) => norm(l.lesson)));
  const out: Lesson[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const raw of list.slice(0, MAX_LESSONS_PER_RUN)) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const cue = typeof rec.cue === "string" ? rec.cue.trim() : "";
    const lesson = typeof rec.lesson === "string" ? rec.lesson.trim() : "";
    const evidence = typeof rec.evidence === "string" ? rec.evidence.trim() : "";
    const confidence = typeof rec.confidence === "string" ? rec.confidence.trim() : "";
    if (cue === "" || lesson === "" || evidence === "") continue; // урок без факта — не урок
    // Доказательство должно ссылаться на факт из диджеста: маркер, цифру или id сессии.
    const factual =
      /(?:stopGate|todoFirst|loopBreaker|toolErrors|providerErrors|status(?:Done|Caveat|Partial))/i.test(evidence) ||
      /\b[0-9a-f]{8}\b/i.test(evidence) ||
      /\d/.test(evidence);
    if (!factual) continue;
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") continue;
    if (known.has(norm(lesson))) continue;
    known.add(norm(lesson));
    out.push({
      cue: cue.slice(0, 200),
      lesson: lesson.slice(0, 240),
      evidence: evidence.slice(0, 240),
      confidence,
      added: today,
      sessions: rows.slice(0, 4).map((r) => r.sessionId.slice(0, 8)),
    });
  }
  return out;
}

// ── команды ──────────────────────────────────────────────────────────────────

async function run(opts: { hours: number; model: string; dryRun: boolean }): Promise<void> {
  const rows = collectDigest(opts.hours);
  const tasks = taskDigest();
  const existing = readLessons();
  console.log(`окно ${opts.hours} ч · сессий с инцидентами: ${rows.length} · задач: ${tasks.length} · уроков в библиотеке: ${existing.length}`);
  if (rows.length === 0 && tasks.length === 0) {
    console.log("нечего рефлексировать: инцидентов за окно нет");
    return;
  }
  const prompt = promptFor(rows, tasks, existing);
  if (opts.dryRun) {
    console.log("--- prompt ---");
    console.log(prompt);
    return;
  }
  const workDir = join(HARNESS_DIR, "work");
  mkdirSync(workDir, { recursive: true });
  const res = await runOmp(
    ["-p", prompt, "--cwd", workDir, "--auto-approve", "--no-session", "--no-title", "--max-time", "480", "--model", opts.model],
    LLM_TIMEOUT_MS,
  );
  if (res.code !== 0) {
    console.error(`модель не ответила: ${res.stderr.trim().slice(0, 300) || `exit ${res.code}`}`);
    process.exitCode = 1;
    return;
  }
  const fresh = parseLessons(res.stdout, rows, existing);
  const merged = [...fresh, ...existing];
  if (fresh.length > 0) {
    writeLessonsFile(merged);
  }
  const inPrompt = syncRules(merged);
  const state = {
    lastRunAt: new Date().toISOString(),
    windowHours: opts.hours,
    sessionsSeen: rows.length,
    lessonsAdded: fresh.length,
    lessonsTotal: merged.length,
    lessonsInPrompt: inPrompt,
  };
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`);
  appendFileSync(join(HARNESS_DIR, "reflect.log"), `${state.lastRunAt} +${fresh.length} (всего ${merged.length}, в промпте ${inPrompt})\n`);
  console.log(`новых уроков: ${fresh.length} · всего: ${merged.length} · в промпте: ${inPrompt}`);
  for (const l of fresh) console.log(`  + [${l.confidence}] ${l.lesson}`);
}

function status(): void {
  const lessons = readLessons();
  const state = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>) : null;
  console.log(`библиотека: ${LESSONS_FILE}`);
  console.log(`уроков: ${lessons.length} · в промпт попадает: ${pickedForPrompt(lessons).length}`);
  if (state !== null) console.log(`последний прогон: ${String(state.lastRunAt)} · добавлено ${String(state.lessonsAdded)}`);
  for (const l of pickedForPrompt(lessons)) console.log(`  - [${l.confidence}] ${l.lesson}`);
}

const [command = "run", ...rest] = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (command === "sanitize") {
  const all = readLessons();
  writeLessonsFile(all);
  const inPrompt = syncRules(all);
  console.log(`библиотека переписана: ${all.length} уроков, в промпте ${inPrompt}`);
  for (const dropped of readLessonsAll()) {
    if (conflictsWithInvariants(dropped)) console.log(`  - veto: ${dropped.lesson.slice(0, 90)}`);
  }
} else if (command === "status") {
  status();
} else if (command === "run") {
  const hours = Number(arg("--hours") ?? 24);
  await run({
    hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    model: arg("--model") ?? process.env.OMP_POCKET_ORGANIZER_MODEL ?? DEFAULT_MODEL,
    dryRun: rest.includes("--dry-run"),
  });
} else {
  console.error("usage: harness-reflect run [--dry-run] [--hours 24] [--model <id>] | status");
  process.exitCode = 5;
}
