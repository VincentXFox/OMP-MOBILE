import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  adoptLooseDirs,
  appendJournal,
  bindSession,
  crewRoot,
  deskByDir,
  deskOfSession,
  ensureDesk,
  isPlaceholderDesk,
  isSharedCwd,
  listDesks,
  pruneEmptyDesk,
  rewriteCrewIndex,
  syncAllCharters,
  sessionsOfDesk,
  slugFromRole,
  type Desk,
} from "./crew.ts";
import { listHosts, runOmp } from "./hosts.ts";
import type { OmpHost } from "./hosts.ts";

/**
 * Организатор штата: раз в сутки раскладывает агентов по папкам-столам и
 * фиксирует, кто за что отвечает.
 *
 * Решение принимает модель (это и есть «агент, который распределяет папки»):
 * получает дижест агентов с безымянных свалок (~, /tmp) и возвращает план
 * «стол → ответственность → агенты». Применение плана — детерминированный код:
 * каталоги, устав AGENTS.md, реестр, привязки. Так модель не имеет права удалять
 * или двигать чужие файлы, а результат проверяем.
 *
 * Модель недоступна или ответ не разобрался — работает честное правило
 * «один агент = один стол» (роль из заголовка сессии), а не «ничего не делать».
 */

const STATE_FILE = join(new URL(".", import.meta.url).pathname, "organizer-state.json");
const LOCK_FILE = join(crewRoot(), ".organizer.lock");
const LOG_FILE = join(crewRoot(), "organizer.md");

/** Сколько кандидатов отдаём модели: больше — это уже не «кто за что», а архив. */
const MAX_CANDIDATES = 40;
const LOCK_STALE_MS = 20 * 60_000;
/** Промпт — несколько килобайт русского текста, а omp в печатном режиме ещё и
 *  поднимает сессию: 180 с оказалось мало (модель не успевала ответить).
 *  Суточному таймеру спешить некуда, но интерактивная кнопка ждёт — держим
 *  бюджет 10 минут и режем дижест, чтобы модель не тонула в подробностях. */
const LLM_TIMEOUT_MS = 600_000;
const LLM_MAX_TIME = "480";

export type OrganizerMode = "llm" | "deterministic" | "noop";

export interface OrganizerState {
  lastRunAt: number | null;
  lastTrigger: string | null;
  lastMode: OrganizerMode | null;
  lastSummary: string | null;
  lastError: string | null;
  lastCandidates: number;
  lastDesks: number;
  running: boolean;
  /** Следующий автоматический прогон: суточный таймер, от последнего прогона. */
  nextRunAt: number | null;
}

export interface OrganizerReport {
  ok: boolean;
  mode: OrganizerMode;
  candidates: number;
  desks: { slug: string; role: string; sessions: string[]; created: boolean }[];
  bound: number;
  summary: string;
  errors: string[];
  durationMs: number;
}

interface Candidate {
  sessionId: string;
  title: string | null;
  preview: string | null;
  cwd: string;
  model: string;
  alive: boolean;
}

interface PlannedDesk {
  slug: string;
  role: string;
  brief: string;
  sessions: string[];
}

const EMPTY_STATE: OrganizerState = {
  lastRunAt: null,
  lastTrigger: null,
  lastMode: null,
  lastSummary: null,
  lastError: null,
  lastCandidates: 0,
  lastDesks: 0,
  running: false,
  nextRunAt: null,
};

function readState(): OrganizerState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed === null || typeof parsed !== "object") return { ...EMPTY_STATE };
    const raw = parsed as Partial<OrganizerState>;
    const mode = raw.lastMode === "llm" || raw.lastMode === "deterministic" || raw.lastMode === "noop" ? raw.lastMode : null;
    return {
      lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : null,
      lastTrigger: typeof raw.lastTrigger === "string" ? raw.lastTrigger : null,
      lastMode: mode,
      lastSummary: typeof raw.lastSummary === "string" ? raw.lastSummary : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
      lastCandidates: typeof raw.lastCandidates === "number" ? raw.lastCandidates : 0,
      lastDesks: typeof raw.lastDesks === "number" ? raw.lastDesks : 0,
      running: raw.running === true,
      nextRunAt: typeof raw.nextRunAt === "number" ? raw.nextRunAt : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(patch: Partial<OrganizerState>): OrganizerState {
  const next = { ...readState(), ...patch };
  try {
    mkdirSync(join(STATE_FILE, ".."), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, "\t"));
    renameSync(tmp, STATE_FILE);
  } catch {
    // состояние — подсказка для UI; прогон от него не зависит
  }
  return next;
}

/** Статус для UI: последний прогон, режим, следующий по расписанию.
 *  «running» вычисляется по живому lock-файлу, а не по полю в state —
 *  упавший процесс иначе оставлял бы вечный «распределяю…». */
export function organizerStatus(): OrganizerState {
  const state = readState();
  return { ...state, running: lockHeld() };
}

/** Код errno из ошибки ФС/процесса: узкое место, где unknown превращается в строку. */
function errnoCode(err: unknown): string | null {
  if (err instanceof Error && "code" in err && typeof err.code === "string") return err.code;
  return null;
}

function lockHeld(): boolean {
  try {
    const raw = readFileSync(LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    if (Date.now() - at > LOCK_STALE_MS) return false;
    const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
    if (pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = процесс живёт, но чужой; ESRCH = процесса нет, lock протух
      return errnoCode(err) === "EPERM";
    }
  } catch {
    return false;
  }
}

function takeLock(): boolean {
  if (lockHeld()) return false;
  try {
    mkdirSync(crewRoot(), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function dropLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // уже снят
  }
}

/** Кандидаты: живые агенты, чья папка — свалка (дом/tmp) и которые ещё не в столе. */
function collectCandidates(hosts: readonly OmpHost[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const host of hosts) {
    if (typeof host.sessionId !== "string" || host.sessionId.length === 0) continue;
    if (seen.has(host.sessionId)) continue;
    if (host.alive === false) continue;
    if (!isSharedCwd(host.cwd)) continue;
    // Агент в столе-заглушке (старт без роли) — тоже кандидат: настоящую зону
    // ответственности определяет организатор, а не «Новый стол 17.10».
    const bound = deskOfSession(host.sessionId) ?? deskByDir(host.cwd);
    if (bound !== null && !isPlaceholderDesk(bound)) continue;
    seen.add(host.sessionId);
    out.push({
      sessionId: host.sessionId,
      title: host.sessionTitle?.trim() || host.sessionName?.trim() || null,
      preview: host.sessionPreview?.trim() || null,
      cwd: host.cwd,
      model: `${host.model.provider}/${host.model.id}`,
      alive: true,
    });
  }
  // Свежие/именованные первыми: именно они — «кто за что отвечает», остальное хвост.
  out.sort((a, b) => Number(b.title !== null) - Number(a.title !== null));
  return out.slice(0, MAX_CANDIDATES);
}

function digest(candidates: readonly Candidate[]): string {
  return candidates
    .map((c, i) => {
      const title = c.title ?? "(без названия)";
      const preview = c.preview !== null && c.preview !== title ? ` · первый запрос: ${c.preview.slice(0, 100)}` : "";
      return `${i + 1}. id=${c.sessionId} · папка=${c.cwd} · модель=${c.model} · ${title}${preview}`;
    })
    .join("\n");
}

const EXISTING_HINT = (desks: readonly Desk[]): string =>
  desks.length === 0
    ? "Столов пока нет."
    : desks.map((d) => `- ${d.slug} → ${d.role}${d.brief.length > 0 ? ` (${d.brief})` : ""}`).join("\n");

function promptFor(candidates: readonly Candidate[], desks: readonly Desk[]): string {
  return `Ты — организатор штата агентов. Твоя работа: разложить агентов по папкам-столам так, чтобы у каждого был понятный участок ответственности, и никто не сидел в общей куче.

Агенты без стола (${candidates.length}):
${digest(candidates)}

Уже существующие столы:
${EXISTING_HINT(desks)}

Правила:
- Один стол = один участок работы. Агенты, которые возятся с одной темой (например «камеры и видеонаблюдение» или «память агентов»), идут в ОДИН стол.
- Разные темы — разные столы. Не сваливай всё в «разное»: у каждого стола должна быть конкретная зона.
- role — по-русски, до 40 символов, без слов «агент» и «задачи»: «Камеры и видеонаблюдение», «Дизайн PWA», «Память и контекст».
- brief — одно-два предложения: что входит в зону и чего в ней точно нет.
- slug — латиница в нижнем регистре, дефисы, до 28 символов (это имя папки).
- Используй существующий стол, если тема совпадает: тогда slug из списка выше.
- Каждый id из списка должен попасть ровно в один стол. Ничего не выдумывай.

Ответ — ТОЛЬКО JSON, без пояснений и без markdown:
{"desks":[{"slug":"kamery","role":"Камеры и видеонаблюдение","brief":"Роутеры, прошивки, QR-каналы. Не занимается дизайном приложения.","sessions":["<id>"]}]}`;
}

/** Достаёт JSON-объект из ответа модели: чистое тело, ```json-блок или текст вокруг. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1]?.trim() ?? text.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Модель может вернуть префикс id, полный id или id в кавычках-ёлочках. */
function matchCandidate(candidates: readonly Candidate[], raw: string): Candidate | null {
  const needle = raw.replace(/[^0-9a-zA-Z-]/g, "").toLowerCase();
  if (needle.length < 6) return null;
  for (const c of candidates) {
    const id = c.sessionId.toLowerCase();
    if (id === needle) return c;
    if (id.startsWith(needle) || needle.startsWith(id)) return c;
    if (needle.length >= 8 && id.slice(0, 8) === needle.slice(0, 8)) return c;
  }
  return null;
}

/** Разбор плана модели в проверяемую структуру: неизвестные id и пустые столы отбрасываются. */
function parsePlan(raw: unknown, candidates: readonly Candidate[]): PlannedDesk[] {
  if (raw === null || typeof raw !== "object" || !("desks" in raw)) return [];
  const list = raw.desks;
  if (!Array.isArray(list)) return [];
  const assigned = new Set<string>();
  const out: PlannedDesk[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    if (!("role" in entry) || typeof entry.role !== "string" || entry.role.trim().length === 0) continue;
    if (!("sessions" in entry) || !Array.isArray(entry.sessions)) continue;
    const sessions: string[] = [];
    for (const rawId of entry.sessions) {
      if (typeof rawId !== "string") continue;
      const hit = matchCandidate(candidates, rawId);
      if (hit === null || assigned.has(hit.sessionId)) continue;
      assigned.add(hit.sessionId);
      sessions.push(hit.sessionId);
    }
    if (sessions.length === 0) continue;
    const role = entry.role.trim().slice(0, 48);
    const slugRaw = "slug" in entry && typeof entry.slug === "string" ? entry.slug.trim() : "";
    const brief = "brief" in entry && typeof entry.brief === "string" ? entry.brief.trim().slice(0, 240) : "";
    const slug = /^[a-z][a-z0-9-]{1,28}$/.test(slugRaw) ? slugRaw : slugFromRole(role);
    out.push({ slug, role, brief, sessions });
  }
  return out;
}

/** Честный запасной план: один агент = один стол с ролью из его заголовка. */
function fallbackPlan(candidates: readonly Candidate[]): PlannedDesk[] {
  return candidates.map((c) => {
    const role = (c.title ?? c.preview ?? "Новый стол").replace(/\s+/g, " ").trim().slice(0, 48) || "Новый стол";
    return { slug: slugFromRole(role), role, brief: c.preview !== null && c.preview !== c.title ? c.preview.slice(0, 200) : "", sessions: [c.sessionId] };
  });
}

function titleMapOf(candidates: readonly Candidate[], desks: readonly Desk[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const c of candidates) map.set(c.sessionId, c.title);
  for (const desk of desks) for (const sessionId of sessionsOfDesk(desk.slug)) if (!map.has(sessionId)) map.set(sessionId, null);
  return map;
}

export interface OrganizerRunOptions {
  trigger?: string;
  dryRun?: boolean;
  model?: string;
  /** Уведомление пользователю (push). Ошибки уведомления прогон не ломают. */
  notify?: (payload: { title: string; body: string; url: string }) => Promise<unknown>;
}

/** Один прогон раскладки. Параллельные вызовы (таймер + кнопка в приложении)
 *  гасятся файловым lock-файлом: два организатора одновременно завели бы дубли столов. */
export async function runOrganizer(opts: OrganizerRunOptions = {}): Promise<OrganizerReport> {
  const started = Date.now();
  const trigger = opts.trigger ?? "manual";
  const errors: string[] = [];
  if (!takeLock()) {
    return {
      ok: false,
      mode: "noop",
      candidates: 0,
      desks: [],
      bound: 0,
      summary: "Организатор уже распределяет агентов — второй прогон не нужен",
      errors: ["locked"],
      durationMs: Date.now() - started,
    };
  }
  writeState({ running: true, lastTrigger: trigger });
  try {
    adoptLooseDirs();
    // Уставы столов синхронизируем до раскладки: если раскладывать нечего,
    // состав агентов в AGENTS.md всё равно должен быть актуальным.
    syncAllCharters();
    const hostsOut = await listHosts();
    const candidates = collectCandidates(hostsOut.hosts);
    const desksBefore = listDesks();

    if (candidates.length === 0) {
      rewriteCrewIndex();
      const summary = desksBefore.length === 0 ? "Штат пуст: агентов в общих папках нет" : `Всё разложено: ${desksBefore.length} столов, бесхозных агентов нет`;
      writeState({ running: false, lastRunAt: Date.now(), lastMode: "noop", lastSummary: summary, lastError: null, lastCandidates: 0, lastDesks: desksBefore.length, nextRunAt: Date.now() + 24 * 3_600_000 });
      return { ok: true, mode: "noop", candidates: 0, desks: [], bound: 0, summary, errors, durationMs: Date.now() - started };
    }

    let mode: OrganizerMode = "llm";
    let plan: PlannedDesk[] = [];
    const prompt = promptFor(candidates, desksBefore);
    const workDir = join(crewRoot(), ".organizer");
    try {
      mkdirSync(workDir, { recursive: true });
      const args = ["-p", prompt, "--cwd", workDir, "--auto-approve", "--no-session", "--no-title", "--max-time", LLM_MAX_TIME];
      // Модель раскладки: флаг CLI → переменная окружения → модель omp по умолчанию.
      const model = opts.model?.trim() || process.env.OMP_POCKET_ORGANIZER_MODEL?.trim() || "";
      if (model.length > 0) args.push("--model", model);
      const res = await runOmp(args, LLM_TIMEOUT_MS);
      if (res.code !== 0) throw new Error(res.stderr.trim().slice(0, 300) || `exit ${res.code}`);
      plan = parsePlan(extractJson(res.stdout), candidates);
      if (plan.length === 0) throw new Error("модель вернула план без столов");
    } catch (err) {
      errors.push(`модель: ${err instanceof Error ? err.message : String(err)}`);
      mode = "deterministic";
      plan = fallbackPlan(candidates);
    }

    // Всё, что модель забыла, добираем правилом «свой стол»: агент не должен
    // остаться в общей куче молча.
    const planned = new Set(plan.flatMap((d) => d.sessions));
    const leftovers = candidates.filter((c) => !planned.has(c.sessionId));
    if (leftovers.length > 0) {
      if (mode === "llm") errors.push(`модель не разложила ${leftovers.length} агент(ов) — заведены отдельные столы`);
      plan = [...plan, ...fallbackPlan(leftovers)];
    }

    const titles = titleMapOf(candidates, desksBefore);
    const applied: OrganizerReport["desks"] = [];
    let bound = 0;
    if (!opts.dryRun) {
      for (const item of plan) {
        const existing = listDesks().find((d) => d.slug === item.slug);
        const members = item.sessions.map((sessionId) => ({ sessionId, title: titles.get(sessionId) ?? null }));
        const desk = ensureDesk({ slug: item.slug, role: item.role, brief: item.brief, by: "organizer", members });
        for (const sessionId of item.sessions) {
          if (bindSession(sessionId, desk.slug, "organizer") !== null) bound++;
        }
        appendJournal(desk.slug, `организатор (${mode}): стол собран из ${item.sessions.length} агент(ов)`);
        applied.push({ slug: desk.slug, role: desk.role, sessions: item.sessions, created: existing === undefined });
      }
      // Состав и устав остальных столов тоже синхронизируем: агента могли
      // перепривязать/закрыть, а устав стола должен показывать факт.
      for (const desk of listDesks()) {
        if (applied.some((a) => a.slug === desk.slug)) continue;
        const members = sessionsOfDesk(desk.slug).map((sessionId) => ({ sessionId, title: titles.get(sessionId) ?? null }));
        ensureDesk({ slug: desk.slug, role: desk.role, brief: desk.brief, by: desk.assignedBy, members });
      }
      rewriteCrewIndex(titles);
    } else {
      for (const item of plan) {
        applied.push({ slug: item.slug, role: item.role, sessions: item.sessions, created: desksBefore.every((d) => d.slug !== item.slug) });
      }
    }

    // Пустые столы-заглушки после переезда агентов убираем: иначе ~/OMP
    // зарастает каталогами «Новый стол» без единого агента.
    const pruned: string[] = [];
    if (!opts.dryRun) {
      for (const desk of listDesks()) {
        if (!isPlaceholderDesk(desk)) continue;
        if (applied.some((a) => a.slug === desk.slug)) continue;
        if (pruneEmptyDesk(desk.slug)) pruned.push(desk.slug);
      }
      if (pruned.length > 0) rewriteCrewIndex(titles);
    }

    const created = applied.filter((d) => d.created).length;
    const summary = opts.dryRun
      ? `Проверка: ${candidates.length} агент(ов) → ${applied.length} стол(ов), новых ${created}`
      : `${candidates.length} агент(ов) разложены по ${applied.length} стол(ам)${created > 0 ? `, новых ${created}` : ""}${pruned.length > 0 ? `, убрано пустых ${pruned.length}` : ""}`;

    if (!opts.dryRun) {
      writeState({
        running: false,
        lastRunAt: Date.now(),
        lastMode: mode,
        lastSummary: summary,
        lastError: errors[0] ?? null,
        lastCandidates: candidates.length,
        lastDesks: listDesks().length,
        nextRunAt: Date.now() + 24 * 3_600_000,
      });
      try {
        mkdirSync(crewRoot(), { recursive: true });
        const line = `\n## ${new Date().toISOString().replace("T", " ").slice(0, 16)} · ${trigger} · ${mode}\n${applied.map((d) => `- ${d.role} (\`${d.slug}\`) ← ${d.sessions.length} агент(ов)`).join("\n")}\n`;
        if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, `# Журнал организатора\n${line}`);
        else appendFileSync(LOG_FILE, line);
      } catch {
        // журнал не критичен
      }
      if (opts.notify !== undefined) {
        try {
          await opts.notify({ title: "Штаб разложен", body: summary, url: "#/agents" });
        } catch {
          // push — уведомление, а не часть раскладки
        }
      }
    }

    return { ok: true, mode, candidates: candidates.length, desks: applied, bound, summary, errors, durationMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeState({ running: false, lastError: message, lastRunAt: Date.now(), lastSummary: "Раскладка не удалась" });
    return { ok: false, mode: "noop", candidates: 0, desks: [], bound: 0, summary: `Раскладка не удалась: ${message}`, errors: [message], durationMs: Date.now() - started };
  } finally {
    dropLock();
    const state = readState();
    if (state.running) writeState({ running: false });
  }
}
