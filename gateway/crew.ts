import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findSessionFile, parseSessionHead } from "./sessions.ts";

/**
 * Штат: у каждого агента своя папка и закреплённая за ним ответственность.
 *
 * Проблема, которую это решает: сессии omp хранятся по cwd, и «Новый агент» из
 * приложения по умолчанию стартовал в домашней папке — два десятка совершенно
 * разных агентов (Cudy, дизайн, память, QR-каналы) лежали в одном каталоге,
 * одного цвета, без ответа на вопрос «кто за что отвечает».
 *
 * Единица владения — папка (стол). Стол = каталог + AGENTS.md (устав: за что
 * отвечаю, где границы) + запись в реестре. Агент (сессия) привязывается к
 * столу по sessionId: instanceId умирает вместе с процессом, а sessionId
 * переживает resume и перезапуск шлюза.
 *
 * Файлы:
 *   ~/OMP/<slug>/AGENTS.md   — устав стола (нативный файл правил omp: сессия,
 *                              стартующая в папке, читает его сама; генерируемый
 *                              блок + ручная часть ниже границы)
 *   ~/OMP/<slug>/JOURNAL.md  — что стол сделал (пишет агент, дополняется применениями)
 *   ~/OMP/CREW.md            — индекс: кто за что отвечает
 *   gateway/crew.json        — реестр (столы + привязки сессий)
 */

/** Реестр штата. `OMP_POCKET_CREW_DB` перекрывает путь — тестам и разовым
 *  проверкам нельзя писать в живой реестр шлюза (каталоги столов при этом
 *  уже перекрываются `OMP_POCKET_CREW_ROOT`). */
function crewFile(): string {
  const fromEnv = process.env.OMP_POCKET_CREW_DB;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(new URL(".", import.meta.url).pathname, "crew.json");
}

/** Корень штата. Перекрывается OMP_POCKET_CREW_ROOT — тесты не должны писать в домашний каталог. */
export function crewRoot(): string {
  const fromEnv = process.env.OMP_POCKET_CREW_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim().replace(/\/+$/, "");
  return join(homedir(), "OMP");
}

export interface Desk {
  slug: string;
  dir: string;
  /** Короткое имя ответственности («Камеры и видеонаблюдение»), кириллица разрешена. */
  role: string;
  /** 1–2 предложения: что входит в зону, чего не касаться. */
  brief: string;
  createdAt: number;
  updatedAt: number;
  /** Автор раскладки: организатор, старт агента, ручное создание. */
  assignedBy: "organizer" | "start" | "manual" | "adopted";
  /** Откуда взят устав: id промпта из библиотеки (null — устав сгенерирован). */
  charterSource?: string | null;
}

export interface Binding {
  slug: string;
  at: number;
  by: Desk["assignedBy"] | "organizer";
}

interface CrewDb {
  version: 1;
  desks: Record<string, Desk>;
  bindings: Record<string, Binding>;
}

const MAX_ROLE_CHARS = 48;
const MAX_BRIEF_CHARS = 240;
const MAX_JOURNAL_LINE = 400;

let loaded = false;
let db: CrewDb = { version: 1, desks: {}, bindings: {} };
/** Отпечаток crew.json на момент нашего чтения/записи. Реестр правит не только
 *  шлюз: суточный организатор и ручной CLI — отдельные процессы. Без сверки
 *  mtime шлюз жил бы со своей копией и показывал удалённый стол как живой. */
let stamp: { mtimeMs: number; size: number } | null = null;

function fileStamp(): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(crewFile());
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function emptyDb(): CrewDb {
  return { version: 1, desks: {}, bindings: {} };
}

function isDeskLike(value: unknown): value is Desk {
  if (value === null || typeof value !== "object") return false;
  const d = value as Partial<Desk>;
  return (
    typeof d.slug === "string" &&
    d.slug.length > 0 &&
    typeof d.dir === "string" &&
    d.dir.length > 0 &&
    typeof d.role === "string" &&
    typeof d.brief === "string" &&
    typeof d.createdAt === "number" &&
    typeof d.updatedAt === "number"
  );
}

function load(): void {
  const now = fileStamp();
  const changed = now === null ? stamp !== null : stamp === null || now.mtimeMs !== stamp.mtimeMs || now.size !== stamp.size;
  if (loaded && !changed) return;
  loaded = true;
  stamp = now;
  db = emptyDb();
  try {
    const parsed: unknown = JSON.parse(readFileSync(crewFile(), "utf8"));
    if (parsed === null || typeof parsed !== "object") return;
    const raw = parsed as { desks?: unknown; bindings?: unknown };
    const next = emptyDb();
    if (raw.desks !== null && typeof raw.desks === "object" && !Array.isArray(raw.desks)) {
      for (const [slug, value] of Object.entries(raw.desks as Record<string, unknown>)) {
        if (!isDeskLike(value)) continue;
        next.desks[slug] = {
          ...value,
          assignedBy: value.assignedBy === "organizer" || value.assignedBy === "start" || value.assignedBy === "manual" || value.assignedBy === "adopted" ? value.assignedBy : "organizer",
        };
      }
    }
    if (raw.bindings !== null && typeof raw.bindings === "object" && !Array.isArray(raw.bindings)) {
      for (const [sessionId, value] of Object.entries(raw.bindings as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const b = value as { slug?: unknown; at?: unknown; by?: unknown };
        if (typeof b.slug !== "string" || !(b.slug in next.desks)) continue;
        const by = b.by === "start" || b.by === "manual" || b.by === "adopted" ? b.by : "organizer";
        next.bindings[sessionId] = { slug: b.slug, at: typeof b.at === "number" ? b.at : 0, by };
      }
    }
    db = next;
  } catch {
    // нет файла — пустой штат
  }
}

function persist(): void {
  const file = crewFile();
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, "\t"));
  renameSync(tmp, file);
  stamp = fileStamp();
}

const RU_TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/** «Камеры и видеонаблюдение» → «kamery-i-videonablyudenie». Слаг = имя каталога
 * стола, поэтому только [a-z0-9-], без ведущих цифр/дефисов. */
export function slugFromRole(role: string, limit = 32): string {
  const lowered = role.toLowerCase().replace(/[а-яё]/g, (ch) => RU_TRANSLIT[ch] ?? "-");
  const slug = lowered
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-0-9]+/, "")
    .slice(0, limit)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "desk";
}

/** «Кто-то положил агентов в общую кучу»: дом, корень, /tmp и временные каталоги.
 *  Такие cwd не проект, а свалка — агенту положен свой стол. */
export function isSharedCwd(cwd: string): boolean {
  if (typeof cwd !== "string" || cwd.trim() === "") return true;
  const path = cwd.replace(/\/+$/, "") || "/";
  const home = homedir().replace(/\/+$/, "");
  if (path === "/" || path === home) return true;
  if (path === "/tmp" || path.startsWith("/tmp/")) return true;
  if (path === "/var/tmp" || path.startsWith("/var/tmp/")) return true;
  const root = crewRoot();
  if (path === root) return true;
  return false;
}

/** Каталог лежит внутри штата → это стол (привязка по вложенности тоже работает). */
export function deskByDir(dir: string): Desk | null {
  load();
  const path = dir.replace(/\/+$/, "");
  let best: Desk | null = null;
  for (const desk of Object.values(db.desks)) {
    const deskDir = desk.dir.replace(/\/+$/, "");
    if (path === deskDir || path.startsWith(`${deskDir}/`)) {
      if (best === null || desk.dir.length > best.dir.length) best = desk;
    }
  }
  return best;
}

export function deskBySlug(slug: string): Desk | null {
  load();
  return db.desks[slug] ?? null;
}

export function listDesks(): Desk[] {
  load();
  return Object.values(db.desks).sort((a, b) => a.role.localeCompare(b.role, "ru"));
}

export function deskOfSession(sessionId: string): Desk | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  load();
  const binding = db.bindings[sessionId];
  if (binding === undefined) return null;
  return db.desks[binding.slug] ?? null;
}

export function sessionsOfDesk(slug: string): string[] {
  load();
  return Object.entries(db.bindings)
    .filter(([, b]) => b.slug === slug)
    .map(([sessionId]) => sessionId);
}

function uniqueSlug(base: string): string {
  load();
  let candidate = base;
  for (let i = 2; db.desks[candidate] !== undefined || existsSync(join(crewRoot(), candidate)); i++) {
    candidate = `${base.slice(0, 28)}-${i}`;
  }
  return candidate;
}

function clampText(raw: string, limit: number): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Файл устава: `AGENTS.md` — то, что omp подхватывает как правила проекта
 *  при старте сессии в этой папке. Отдельного флага в команде не нужно. */
const CHARTER_FILE = "AGENTS.md";
const ROLE_BEGIN = "<!-- crew:begin -->";
const ROLE_END = "<!-- crew:end -->";

const ROLE_STATIC = `## Как работать в этой папке

- Это моя зона ответственности: файлы, заметки и скрипты по теме живут здесь, а не в домашнем каталоге.
- Не трогаю папки других столов (\`~/OMP/<другой>\`) и домашний каталог: там живут чужие агенты.
- Начатое и законченное записываю строкой в \`JOURNAL.md\`: \`- ГГГГ-ММ-ДД — что сделал, чем закончилось\`.
- Если задача вышла за пределы зоны — говорю об этом прямо, а не расширяю стол молча.
`;

function generatedBlock(desk: Desk, members: readonly { sessionId: string; title: string | null }[]): string {
  const lines = [
    ROLE_BEGIN,
    `# ${desk.role}`,
    "",
    desk.brief.length > 0 ? desk.brief : "Зона ответственности пока не уточнена: организатор штаба заполнит её при следующей раскладке.",
    "",
    `Папка: \`${desk.dir}\``,
    `Слаг: \`${desk.slug}\``,
    ...(desk.charterSource != null && desk.charterSource.length > 0 ? [`Устав: внешний промпт «${desk.charterSource}»`] : []),
    "",
    "## Агенты стола",
    "",
  ];
  if (members.length === 0) lines.push("- (пока никто не закреплён)");
  else for (const m of members) lines.push(`- ${m.title ?? "сессия"} — \`${m.sessionId.slice(0, 8)}\``);
  lines.push(ROLE_END, "");
  return lines.join("\n");
}

/** Переписывает только генерируемый блок: ручные заметки ниже границы остаются. */
function writeRoleFile(
  desk: Desk,
  members: readonly { sessionId: string; title: string | null }[],
  tailOverride?: string,
): void {
  const path = join(desk.dir, CHARTER_FILE);
  let tail = tailOverride ?? ROLE_STATIC;
  if (tailOverride === undefined && existsSync(path)) {
    try {
      const current = readFileSync(path, "utf8");
      const end = current.indexOf(ROLE_END);
      if (end >= 0) {
        const rest = current.slice(end + ROLE_END.length).replace(/^\n+/, "");
        if (rest.trim().length > 0) tail = rest;
      }
    } catch {
      // нечитаемый файл — перегенерируем полностью
    }
  }
  writeFileSync(path, `${generatedBlock(desk, members)}\n${tail}`);
  // Первая версия штата писала устав в ROLE.md. Оставлять оба файла — дубль
  // правил в папке; удаляем только свой файл (с нашим маркером).
  const legacy = join(desk.dir, "ROLE.md");
  if (existsSync(legacy)) {
    try {
      if (readFileSync(legacy, "utf8").includes(ROLE_BEGIN)) rmSync(legacy, { force: true });
    } catch {
      // нечитаемый файл считаем чужим и не трогаем
    }
  }
}

function ensureJournal(desk: Desk): void {
  const path = join(desk.dir, "JOURNAL.md");
  if (existsSync(path)) return;
  writeFileSync(path, `# Журнал стола «${desk.role}»\n\n- ${new Date().toISOString().slice(0, 10)} — стол заведён\n`);
}

/** Имя агента для индекса: у вызывающего заголовков может не быть (старт
 *  агента), а «сессия — 01a1178f» вместо названия бесполезна. Читаем head
 *  файла сессии — это 64 КБ на агента и только при записи индекса. */
function titleOf(sessionId: string, known: ReadonlyMap<string, string | null>): string {
  const fromMap = known.get(sessionId);
  if (typeof fromMap === "string" && fromMap.length > 0) return fromMap;
  const path = findSessionFile(sessionId);
  if (path !== null) {
    const head = parseSessionHead(path);
    const title = head.title ?? head.preview;
    if (title !== null && title.length > 0) return title;
  }
  return `сессия ${sessionId.slice(0, 8)}`;
}

/** Индекс штата: один экран «кто за что отвечает» прямо в файловой системе. */
export function rewriteCrewIndex(memberTitles: ReadonlyMap<string, string | null> = new Map()): void {
  load();
  const desks = listDesks();
  const lines = [
    "# Штат",
    "",
    `Обновлено: ${new Date().toISOString().replace("T", " ").slice(0, 16)} · столов: ${desks.length}`,
    "",
  ];
  if (desks.length === 0) lines.push("Столов пока нет.");
  for (const desk of desks) {
    const sessions = sessionsOfDesk(desk.slug);
    lines.push(`## ${desk.role}`, "", desk.brief.length > 0 ? desk.brief : "—", "", `\`${desk.dir}\``, "");
    if (sessions.length === 0) lines.push("- агентов нет");
    else for (const sessionId of sessions) lines.push(`- ${titleOf(sessionId, memberTitles)} — \`${sessionId.slice(0, 8)}\``);
    lines.push("");
  }
  const root = crewRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "CREW.md"), `${lines.join("\n")}\n`);
}

export interface EnsureDeskInput {
  role: string;
  brief?: string;
  slug?: string;
  by?: Desk["assignedBy"];
  members?: readonly { sessionId: string; title: string | null }[];
}

/** Заводит стол: каталог, устав, журнал. Существующий стол не пересоздаётся —
 *  правится только генерируемый блок устава, ручной хвост сохраняется. */
export function ensureDesk(input: EnsureDeskInput): Desk {
  load();
  const role = clampText(input.role, MAX_ROLE_CHARS) || "Без названия";
  const brief = clampText(input.brief ?? "", MAX_BRIEF_CHARS);
  const by = input.by ?? "manual";
  const slug = input.slug !== undefined && input.slug.length > 0 ? input.slug : uniqueSlug(slugFromRole(role));
  const existing = db.desks[slug];
  const now = Date.now();
  const desk: Desk = existing !== undefined
    ? { ...existing, role, brief: brief.length > 0 ? brief : existing.brief, updatedAt: now }
    : { slug, dir: join(crewRoot(), slug), role, brief, createdAt: now, updatedAt: now, assignedBy: by };
  // Каталог мог остаться от прошлого запуска (реестр потерян) — принимаем как есть.
  mkdirSync(desk.dir, { recursive: true });
  db.desks[slug] = desk;
  persist();
  ensureJournal(desk);
  writeRoleFile(desk, input.members ?? sessionsOfDesk(slug).map((sessionId) => ({ sessionId, title: null })));
  rewriteCrewIndex();
  return desk;
}

/** Привязка сессии к столу. Повторная привязка к другому столу разрешена:
 *  организатор имеет право перевести агента, история сессии при этом цела. */
export function bindSession(sessionId: string, slug: string, by: Binding["by"]): Desk | null {
  load();
  const desk = db.desks[slug];
  if (desk === undefined) return null;
  const prev = db.bindings[sessionId];
  if (prev !== undefined && prev.slug === slug) {
    prev.at = Date.now();
    prev.by = by;
    persist();
    return desk;
  }
  db.bindings[sessionId] = { slug, at: Date.now(), by };
  persist();
  return desk;
}

export function unbindSession(sessionId: string): void {
  load();
  if (db.bindings[sessionId] === undefined) return;
  delete db.bindings[sessionId];
  persist();
}

export function appendJournal(slug: string, line: string): void {
  load();
  const desk = db.desks[slug];
  if (desk === undefined) return;
  const text = clampText(line, MAX_JOURNAL_LINE);
  try {
    appendFileSync(join(desk.dir, "JOURNAL.md"), `- ${new Date().toISOString().slice(0, 10)} — ${text}\n`);
  } catch {
    // журнал — заметка, не критичный путь
  }
}

/** Устав стола из внешнего промпта (библиотека системных промптов).
 *  Пишется в ручную часть AGENTS.md, поэтому syncAllCharters его сохраняет,
 *  а не затирает сгенерированным блоком. Пустой текст возвращает стандартный устав. */
export function setDeskCharter(slug: string, text: string | null, source: string | null): Desk | null {
  load();
  const desk = db.desks[slug];
  if (desk === undefined) return null;
  const body = (text ?? "").trim();
  const updated: Desk = { ...desk, charterSource: body.length > 0 ? source : null, updatedAt: Date.now() };
  db.desks[slug] = updated;
  persist();
  mkdirSync(updated.dir, { recursive: true });
  const members = sessionsOfDesk(slug).map((sessionId) => ({ sessionId, title: null }));
  if (body.length === 0) writeRoleFile(updated, members);
  else {
    const header = body.length > 0 && !body.startsWith("#") ? `## Внешний устав${source !== null ? ` · ${source}` : ""}\n\n` : "";
    writeRoleFile(updated, members, `${header}${body}\n`);
  }
  rewriteCrewIndex();
  return updated;
}

/** Приводит уставы всех столов к текущему составу: состав агентов меняется
 *  (перепривязка, закрытие сессии), а AGENTS.md должен показывать факт.
 *  Вызывается организатором перед раскладкой — то есть раз в сутки автоматически. */
export function syncAllCharters(titles: ReadonlyMap<string, string | null> = new Map()): void {
  load();
  for (const desk of listDesks()) {
    const members = sessionsOfDesk(desk.slug).map((sessionId) => ({ sessionId, title: titles.get(sessionId) ?? null }));
    writeRoleFile(desk, members);
    ensureJournal(desk);
  }
}

/** Стол-заглушка: заведён стартом агента без роли, устав пуст. Организатор имеет
 *  право перепланировать таких агентов и убрать пустой стол. */
export function isPlaceholderDesk(desk: Desk): boolean {
  return desk.assignedBy === "start" && desk.brief.trim().length === 0 && /^Новый стол/.test(desk.role);
}

/** Удаляет стол, только если он пуст по доказательству: ни одной привязанной
 *  сессии и в каталоге нет ничего, кроме наших же AGENTS.md/JOURNAL.md. Любой
 *  посторонний файл — стол остаётся (в чужой папке не убираемся). */
export function pruneEmptyDesk(slug: string): boolean {
  load();
  const desk = db.desks[slug];
  if (desk === undefined) return false;
  if (sessionsOfDesk(slug).length > 0) return false;
  const allowed = new Set([CHARTER_FILE, "ROLE.md", "JOURNAL.md", ".omp-desk.json"]);
  let entries: string[];
  try {
    entries = readdirSync(desk.dir);
  } catch {
    entries = [];
  }
  if (entries.some((name) => !allowed.has(name))) return false;
  for (const name of entries) {
    try {
      rmSync(join(desk.dir, name), { force: true });
    } catch {
      return false;
    }
  }
  try {
    rmSync(desk.dir, { recursive: true, force: true });
  } catch {
    return false;
  }
  delete db.desks[slug];
  persist();
  return true;
}

/** Столы, каталоги которых реально существуют (реестр мог переехать без папок). */
export function existingDeskDirs(): string[] {
  const root = crewRoot();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

/** Для UI: стол + его сессии одним запросом, без чтения реестра на каждую карточку. */
export interface CrewSnapshotDesk extends Desk {
  sessions: string[];
}

export function crewSnapshot(): { desks: CrewSnapshotDesk[]; bindings: Record<string, Binding> } {
  load();
  return {
    desks: listDesks().map((desk) => ({ ...desk, sessions: sessionsOfDesk(desk.slug) })),
    bindings: { ...db.bindings },
  };
}

/** Единое решение «куда стартовать агента» для шлюза.
 *  - cwd внутри штата → это стол, привязываемся к нему;
 *  - cwd-свалка (дом/tmp) → заводим (или переиспользуем) стол по роли;
 *  - реальный проект → оставляем как есть, стол не выдумываем. */
export function resolveDeskForStart(input: {
  cwd: string;
  role?: string;
  label?: string;
  slug?: string;
  by?: Desk["assignedBy"];
}): { dir: string; desk: Desk | null; created: boolean } {
  load();
  if (input.slug !== undefined && input.slug.length > 0) {
    const existing = db.desks[input.slug];
    if (existing !== undefined) {
      mkdirSync(existing.dir, { recursive: true });
      return { dir: existing.dir, desk: existing, created: false };
    }
  }
  const insideDesk = deskByDir(input.cwd);
  if (insideDesk !== null) return { dir: insideDesk.dir, desk: insideDesk, created: false };
  if (!isSharedCwd(input.cwd)) return { dir: input.cwd, desk: null, created: false };

  const role = clampText(input.role?.trim() || input.label?.trim() || "", MAX_ROLE_CHARS);
  if (role.length === 0) {
    // Роли нет — стол всё равно нужен: иначе агент снова попадёт в общую кучу.
    const stamp = new Date().toISOString().slice(0, 10);
    const desk = ensureDesk({ role: `Новый стол ${stamp}`, brief: "", by: input.by ?? "start" });
    return { dir: desk.dir, desk, created: true };
  }
  const reuse = listDesks().find((d) => d.role.toLowerCase() === role.toLowerCase());
  if (reuse !== undefined) {
    mkdirSync(reuse.dir, { recursive: true });
    return { dir: reuse.dir, desk: reuse, created: false };
  }
  const desk = ensureDesk({ role, brief: "", by: input.by ?? "start" });
  return { dir: desk.dir, desk, created: true };
}

/** Приём каталогов, появившихся без реестра: стол, заведённый руками в ~/OMP/<slug>,
 *  регистрируется при первом обращении, а не игнорируется. */
export function adoptLooseDirs(): number {
  load();
  let adopted = 0;
  for (const dir of existingDeskDirs()) {
    const slug = basename(dir);
    if (db.desks[slug] !== undefined) continue;
    let role = slug;
    try {
      const text = readFileSync(join(dir, CHARTER_FILE), "utf8");
      const heading = /^#\s+(.+)$/m.exec(text);
      if (heading?.[1] !== undefined && heading[1].trim().length > 0) role = heading[1].trim();
    } catch {
      // устава нет — имя стола остаётся слагом
    }
    const now = Date.now();
    db.desks[slug] = { slug, dir, role: clampText(role, MAX_ROLE_CHARS), brief: "", createdAt: now, updatedAt: now, assignedBy: "adopted" };
    adopted++;
  }
  if (adopted > 0) persist();
  return adopted;
}
