import { extname, join, normalize } from "node:path";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { loadConfig } from "./config.ts";
import { listHosts, mintLink } from "./hosts.ts";
import type { OmpHostsOutput } from "./hosts.ts";
import { resumeAgent, startAgent, stopAgent } from "./agents.ts";
import { findSessionFile, listSessions, parseSessionHead, recentActivity, renameSession, tailEntries, type RenameOutcome } from "./sessions.ts";
import { refreshIndexWithin, searchIndexStatus, searchSessions, SEARCH_QUERY_MIN, warmSearchIndex } from "./session-search.ts";
import { displayName, setDisplayName } from "./names.ts";
import { bootRestore, forgetSession, observeHosts, remapInstance } from "./restore.ts";
import { watchPanes } from "./recovery/runtimeWatch.ts";
import { getAgentSettings, listModelOptions, listProjectFiles, projectGit, readProjectFile, readTerminal, renameAgent, sendTerminalKeys, sendTerminalText, setAgentSettings, MAX_TERMINAL_TEXT_BYTES } from "./files.ts";
import { PushManager } from "./push.ts";
import { readAttachment, saveAttachment } from "./attach.ts";
import { isMemoryTable, listBanks, listEntries, listFacets, searchAllEntries } from "./memory.ts";
import { openGraphDb, getMeta } from "./memory-graph/store.ts";
import { indexSessions, rebuildGraph, stats as graphStatsOf } from "./memory-graph/index.ts";
import { contextBlock, searchGraph, topNodes } from "./memory-graph/retrieve.ts";
import { UpdateService, isComponentIdLocal } from "./update/service.ts";
import { dispatchTasks, superActivity, superBoard, validateDispatchItems } from "./super.ts";
import { bindSession, crewRoot, crewSnapshot, deskByDir, deskOfSession, ensureDesk, isSharedCwd, pruneEmptyDesk, resolveDeskForStart, setDeskCharter } from "./crew.ts";
import { organizerStatus, runOrganizer } from "./organizer.ts";
import { listPrompts, readPrompt } from "./prompts.ts";
import { TaskStore, tasksDir } from "./autonomy/store.ts";
import { TaskController } from "./autonomy/controller.ts";
import { rpcLinkFactory } from "./autonomy/rpc-link.ts";
import { tokensUsed } from "./autonomy/budget.ts";
import type { BudgetLimit, CheckSpec, Criterion, Task } from "./autonomy/types.ts";

const DIST_DIR = new URL("../app/dist/", import.meta.url).pathname;
/** Каталог шлюза: рядом с main.ts лежат tasks/ и config.json. */
const GATEWAY_DIR = new URL(".", import.meta.url).pathname;
const HOSTS_CACHE_MS = 2000;
/** Устав стола уходит в системный промпт каждого хода: больше 200 КБ — это уже
 *  не характер агента, а свалка, и такой запрос отклоняем явно. */
const MAX_CHARTER_BYTES = 200_000;
const POLL_INTERVAL_MS = 5000;
/** Идентичность этого процесса: по ней /api/health доказывает, что после
 * обновления ответил НОВЫЙ код, а не переживший рестарт старый процесс. */
const PROCESS_STARTED_AT = Date.now();
const GATEWAY_BUILD_SHA = (() => {
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: GATEWAY_DIR, stdout: "pipe", stderr: "ignore" });
    const sha = out.stdout.toString().trim();
    return out.exitCode === 0 && sha !== "" ? sha : null;
  } catch {
    return null;
  }
})();
const GATEWAY_PKG_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url).pathname, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
})();
const OMP_VERSION_AT_START = (() => {
  try {
    const out = Bun.spawnSync(["omp", "--version"], { stdout: "pipe", stderr: "ignore" });
    const match = /^omp\/(\d+\.\d+\.\d+)/m.exec(out.stdout.toString());
    return match?.[1] ?? null;
  } catch {
    return null;
  }
})();

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return JSON.parse(await req.text()) as T;
  } catch {
    return null;
  }
}

/** Модель автономной задачи по умолчанию: дешёвая, но с инструментами —
 *  цикл делает десятки ходов, и дорогая модель тут не про качество, а про счёт. */
const DEFAULT_TASK_MODEL = "deepseek/deepseek-v4-flash";

interface TaskSeed {
  goal: string;
  cwd: string;
  model: string;
  criteria: Criterion[];
  budget: BudgetLimit;
  autoApprove: string[];
}

/** Сокращённый вид для списка: карточке PWA не нужны журналы попыток и
 *  доказательств, но нужны текст запроса approval и остаток бюджета. */
function taskSummary(t: Task) {
  return {
    id: t.id,
    goal: t.goal,
    cwd: t.cwd,
    model: t.model,
    status: t.status,
    stage: t.stage,
    turns: t.turns,
    spend: t.spend,
    tokensUsed: tokensUsed(t.spend),
    budget: t.budget,
    stopReason: t.stopReason,
    lastVerifiedResult: t.lastVerifiedResult,
    approval: t.approval,
    criteriaTotal: t.criteria.length,
    criteriaPassed: t.criteria.filter((c) => c.passed).length,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Проверка критерия из тела запроса: команда уходит в shell каталога задачи,
 *  поэтому тип полей важен — строка «120» в таймауте не должна дожить до spawn. */
function parseCheckSpec(value: unknown): CheckSpec | string {
  if (value === null || typeof value !== "object") return "check — объект {command, …}";
  const rec = value as Record<string, unknown>;
  if (typeof rec.command !== "string" || rec.command.trim() === "") return "check.command обязателен";
  const check: CheckSpec = { command: rec.command };
  if (rec.expectExit !== undefined) {
    if (typeof rec.expectExit !== "number" || !Number.isInteger(rec.expectExit)) return "check.expectExit — целое число";
    check.expectExit = rec.expectExit;
  }
  for (const field of ["expectContains", "expectAbsent"] as const) {
    const raw = rec[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return `check.${field} — строка`;
    check[field] = raw;
  }
  if (rec.timeoutMs !== undefined) {
    if (typeof rec.timeoutMs !== "number" || !Number.isInteger(rec.timeoutMs) || rec.timeoutMs <= 0) {
      return "check.timeoutMs — положительное целое";
    }
    check.timeoutMs = rec.timeoutMs;
  }
  return check;
}

/** Тело POST /api/tasks приходит из PWA: кривой критерий, доживший до цикла,
 *  сжигает бюджет на «проверках», которых не было. Поэтому валидируем всё здесь. */
function parseTaskSeed(body: unknown): TaskSeed | string {
  if (body === null || typeof body !== "object") return "тело запроса — JSON-объект";
  const rec = body as Record<string, unknown>;

  const goal = typeof rec.goal === "string" ? rec.goal.trim() : "";
  if (goal === "") return "goal обязателен";

  const cwd = typeof rec.cwd === "string" ? rec.cwd.trim() : "";
  if (!cwd.startsWith("/")) return "cwd — абсолютный путь";
  try {
    if (!statSync(cwd).isDirectory()) return `cwd не каталог: ${cwd}`;
  } catch {
    return `cwd не существует: ${cwd}`;
  }

  const model = typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model.trim() : DEFAULT_TASK_MODEL;

  // Критерии можно не задавать: контроллер выведет их из цели плановым ходом и
  // зафиксирует до первого рабочего действия. Явные критерии всегда главнее.
  if (rec.criteria !== undefined && !Array.isArray(rec.criteria)) return "criteria — массив критериев";
  const criteria: TaskSeed["criteria"] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(rec.criteria) ? rec.criteria : []) {
    if (item === null || typeof item !== "object") return "критерий — объект {id, statement, check?}";
    const c = item as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id.trim() : "";
    const statement = typeof c.statement === "string" ? c.statement.trim() : "";
    if (id === "") return "у критерия пустой id";
    if (statement === "") return `у критерия ${id} пустое утверждение`;
    if (ids.has(id)) return `повторяющийся id критерия: ${id}`;
    ids.add(id);
    let check: CheckSpec | undefined;
    if (c.check !== undefined) {
      const parsed = parseCheckSpec(c.check);
      if (typeof parsed === "string") return `критерий ${id}: ${parsed}`;
      check = parsed;
    }
    // passed всегда false: закрыть критерий может только проверка, не клиент.
    criteria.push(check === undefined ? { id, statement, passed: false } : { id, statement, passed: false, check });
  }

  if (rec.budget === null || typeof rec.budget !== "object") return "budget обязателен";
  const b = rec.budget as Record<string, unknown>;
  if (typeof b.maxTokens !== "number" || !Number.isInteger(b.maxTokens) || b.maxTokens <= 0) {
    return "budget.maxTokens — положительное целое";
  }
  if (typeof b.reserveTokens !== "number" || !Number.isInteger(b.reserveTokens) || b.reserveTokens < 0) {
    return "budget.reserveTokens — целое ≥ 0";
  }
  if (b.reserveTokens >= b.maxTokens) return "budget.reserveTokens должен быть меньше maxTokens";
  const budget: BudgetLimit = { maxTokens: b.maxTokens, reserveTokens: b.reserveTokens };
  if (b.maxCostUsd !== undefined) {
    if (typeof b.maxCostUsd !== "number" || !Number.isFinite(b.maxCostUsd) || b.maxCostUsd <= 0) {
      return "budget.maxCostUsd — положительное число";
    }
    budget.maxCostUsd = b.maxCostUsd;
  }

  const autoApprove: string[] = [];
  if (rec.autoApprove !== undefined) {
    if (!Array.isArray(rec.autoApprove)) return "autoApprove — массив строк";
    for (const item of rec.autoApprove) {
      if (typeof item !== "string" || item.trim() === "") return "autoApprove — массив непустых строк";
      autoApprove.push(item.trim());
    }
  }

  return { goal, cwd, model, criteria, budget, autoApprove };
}

// Shared 2s cache absorbs UI polling and feeds the push poller.
class HostsCache {
  #data: OmpHostsOutput | null = null;
  #at = 0;
  /** In-flight запрос: одновременные вызывающие ждут один `omp collab list`,
   *  а не запускают по процессу на каждый тик. */
  #pending: Promise<OmpHostsOutput> | null = null;

  get(): Promise<OmpHostsOutput> {
    if (this.#data && Date.now() - this.#at < HOSTS_CACHE_MS) return Promise.resolve(this.#data);
    if (this.#pending !== null) return this.#pending;
    const pending = listHosts()
      .then((out) => {
        this.#data = out;
        this.#at = Date.now();
        return out;
      })
      .finally(() => {
        this.#pending = null;
      });
    this.#pending = pending;
    return pending;
  }

  /** После старта/остановки/переименования снимок реестра устарел мгновенно. */
  invalidate(): void {
    this.#at = 0;
    this.#data = null;
  }
}

/** Имя, заданное пользователем при создании/возобновлении, становится именем
 *  сессии сразу: иначе omp позже перезапишет его авто-тайтлом, и в списке
 *  появится «случайное» название вместо введённого. Имя хранится по sessionId
 *  (переживает рестарты шлюза и агента), слот названия в файле сессии
 *  заполняется, когда файл уже существует. */
async function applyUserLabel(instanceId: string, label: string): Promise<void> {
  try {
    const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
    if (host === undefined || typeof host.sessionId !== "string" || host.sessionId.length === 0) return;
    const sessionPath = findSessionFile(host.sessionId);
    if (sessionPath !== null) {
      try {
        renameSession(sessionPath, label);
      } catch {
        // слот названия ещё не создан — имя всё равно зафиксируется в реестре
      }
    }
    setDisplayName(host.sessionId, label, host.cwd);
  } catch {
    // best-effort: имя не причина ронять запуск агента
  }
}

/** Свежий инстанс → sessionId → стол. Привязка по sessionId переживает рестарты:
 *  instanceId умирает вместе с процессом, а «кто за что отвечает» — нет. */
async function bindStartedSession(instanceId: string, slug: string): Promise<void> {
  try {
    const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
    if (host === undefined || typeof host.sessionId !== "string" || host.sessionId.length === 0) return;
    bindSession(host.sessionId, slug, "start");
  } catch {
    // привязка не причина ронять запуск агента
  }
}

function serveStatic(pathname: string): Response {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    return new Response("dist missing: run `bun run build` in ~/omp-mobile/app", { status: 503 });
  }
  const rel = decodeURIComponent(pathname);
  const file = join(DIST_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(DIST_DIR)) return new Response("Forbidden", { status: 403 });
  if (existsSync(file) && statSync(file).isFile()) {
    const headers: Record<string, string> = {
      "content-type": MIME_BY_EXT[extname(file)] ?? "application/octet-stream",
    };
    if (rel === "/sw.js") {
      // SW must revalidate every load, or stale workers pin old UI forever.
      headers["cache-control"] = "no-store";
    } else if (rel === "/" || rel === "/index.html" || extname(rel) === ".html") {
      // index.html references hashed assets: always revalidate the manifest itself.
      headers["cache-control"] = "no-cache";
    } else if (/[\w-]{8,}\.(js|css|woff2?|png|svg|jpg|webp|ico|webmanifest|txt)$/.test(rel) || rel.startsWith("/assets/")) {
      // Vite-hashed assets are content-addressed: safe to cache forever.
      headers["cache-control"] = "public, max-age=31536000, immutable";
    }
    return new Response(Bun.file(file), { headers });
  }
  // SPA fallback: unknown extension-less paths get index.html
  if (extname(rel) === "") {
    return new Response(Bun.file(join(DIST_DIR, "index.html")), {
      headers: { "content-type": MIME_BY_EXT[".html"], "cache-control": "no-cache" },
    });
  }
  return new Response("Not found", { status: 404 });
}

const config = loadConfig(new URL("./config.json", import.meta.url).pathname, {});
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hostOverride = flag("--host");
const portOverride = flag("--port");
if (hostOverride) config.host = hostOverride;
if (portOverride) config.port = Number(portOverride);

const cache = new HostsCache();
const push = new PushManager(config, new URL("./subscriptions.json", import.meta.url).pathname);

// Автономные задачи живут на диске (tasks/ рядом со шлюзом) и переживают
// рестарт: цикл поднимаем после старта, чтобы «создал и забыл» работало и
// через выключение телефона. Связь с моделью — RPC-процесс на каждую задачу.
const taskStore = new TaskStore(tasksDir(GATEWAY_DIR));
const tasks = new TaskController({ store: taskStore, linkFactory: rpcLinkFactory() });
try {
  // Синхронно поднимает цикл для задач, заставших рестарт в работе.
  tasks.resumeAfterRestart();
} catch (err) {
  console.log(`[tasks] возобновление не удалось: ${err instanceof Error ? err.message : String(err)}`);
}

// ---- Граф памяти ----
// Второй слой памяти к Mnemopi: проверяемые утверждения проекта с провенансом.
// Индексатор идёт порциями в фоне: полный проход по 300 МБ транскриптов не
// должен задерживать ход шлюза.
const graphDb = openGraphDb();
const GRAPH_TICK_MS = 5 * 60 * 1000;
let graphIndexing = false;
function graphTick(): void {
  if (graphIndexing) return;
  graphIndexing = true;
  try {
    const result = indexSessions(graphDb, { maxFiles: 25, budgetMs: 4000 });
    if (result.changed > 0) console.log(`[graph] +${result.facts} фактов из ${result.changed} файлов (${result.tookMs}мс)`);
  } catch (err) {
    console.log(`[graph] индексация не удалась: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    graphIndexing = false;
  }
}
setTimeout(graphTick, 5_000);
setInterval(graphTick, GRAPH_TICK_MS).unref?.();

const poller = setInterval(() => {
  cache
    .get()
    .then((out) => {
      observeHosts(out.hosts);
      return push.poll(out.hosts);
    })
    .catch(() => {});
  // Панели живут в рантайме: если он поднялся заново (рестарт юнита, сбой),
  // вернувшиеся сессии надо довести до конца — omp сам продолжает только турн
  // без session_exit, остальным нужен явный промпт продолжения. Проверка идёт
  // на каждом опросе: метку восстановления демон ставит уже после рестарта.
  watchPanes()
    .then((outcomes) => {
      for (const outcome of outcomes) {
        console.log(`[runtime] панель ${outcome.paneId}: продолжение ${outcome.continued ? "отправлено" : "не отправлено"}${outcome.blocked === null ? "" : ` (${outcome.blocked})`}`);
      }
    })
    .catch(() => {});
}, POLL_INTERVAL_MS);
poller.unref();

// Crash recovery: after boot (and after the omp registry comes up) relaunch
// every session the gateway last saw live but that died with the power.
void bootRestore()
  .then(async (report) => {
    if (report !== null && (report.restored > 0 || report.failed > 0 || report.details.length > 0)) {
      console.log(`[restore] поднято ${report.restored}, не удалось ${report.failed}: ${report.details.join("; ")}`);
    }
    // Панели, которые рантайм поднял сам (перезагрузка, рестарт юнита), тоже
    // нуждаются в продолжении турна.
    const outcomes = await watchPanes();
    for (const outcome of outcomes) {
      console.log(`[restore] панель ${outcome.paneId}: продолжение ${outcome.continued ? "отправлено" : "не отправлено"}${outcome.blocked === null ? "" : ` (${outcome.blocked})`}`);
    }
  })
  .catch((err) => console.log(`[restore] ошибка: ${err instanceof Error ? err.message : String(err)}`));

// Полнотекстовый индекс сессий: прогрев в фоне, чтобы первый поиск с телефона
// не ждал сканирование 165 МБ.
void warmSearchIndex()
  .then(() => {
    const status = searchIndexStatus();
    console.log(`[search] индекс сессий: ${status.sessions} сессий, ${status.messages} реплик за ${status.lastScanMs ?? "?"} мс`);
  })
  .catch((err) => console.log(`[search] индекс не построен: ${err instanceof Error ? err.message : String(err)}`));

const updates = new UpdateService();
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updateTimer = setInterval(() => {
  updates.checkAndNotify(push).catch(() => {});
}, UPDATE_CHECK_INTERVAL_MS);
updateTimer.unref();
const updateBootCheck = setTimeout(() => {
  updates.checkAndNotify(push).catch(() => {});
}, 60_000);
updateBootCheck.unref();

async function route(req: Request, url: URL): Promise<Response> {
  // CORS preflight: клиент может быть открыт с одного адреса (например, PWA с
  // публичного домена), а API-запросы уходить на другой кандидат (LAN), когда
  // основной путь недоступен. Ответы получают CORS-заголовки в Bun.serve.fetch.
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // Вложения ленты: отдаём БЕЗ Bearer — <img> в транскрипте не подставит
  // заголовки; секрет — UUID в пути (см. attach.ts).
  const attachMatch = /^\/api\/attach\/([0-9a-f-]{36})\/([^/]+)$/.exec(url.pathname);
  if (attachMatch && req.method === "GET") {
    const res = readAttachment(attachMatch[1], decodeURIComponent(attachMatch[2]));
    return res ?? json(404, { error: "not found" });
  }

  // Health без токена: клиентская проверка доступности кандидатов и внешний
  // watchdog туннеля должны отвечать даже до ввода токена. Секретов нет.
  if (url.pathname === "/api/health" && req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        app: "omp-pocket",
        pid: process.pid,
        startedAt: new Date(PROCESS_STARTED_AT).toISOString(),
        buildSha: GATEWAY_BUILD_SHA,
        ompVersion: OMP_VERSION_AT_START,
        version: GATEWAY_PKG_VERSION,
        uptimeMs: Date.now() - PROCESS_STARTED_AT,
        time: Date.now(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      },
    );
  }

  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);

  if (req.headers.get("authorization") !== `Bearer ${config.token}`) return json(401, { error: "unauthorized" });

  // Библиотека системных промптов AI-инструментов (локальный клон, без сети).
  if (url.pathname === "/api/prompts" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const tool = url.searchParams.get("tool") ?? "";
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 40;
    return json(200, listPrompts({ q, tool, limit }));
  }

  const promptMatch = /^\/api\/prompts\/(.+)$/.exec(url.pathname);
  if (promptMatch && req.method === "GET") {
    const doc = readPrompt(decodeURIComponent(promptMatch[1]));
    if (doc === null) return json(404, { error: "промпт не найден" });
    return json(200, doc);
  }

  // Каталог моделей для пикеров (создание агента и смена модели в чате).
  if (url.pathname === "/api/models" && req.method === "GET") {
    try {
      return json(200, { models: await listModelOptions() });
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (url.pathname === "/api/hosts" && req.method === "GET") {
    const out = await cache.get();
    // displayName = explicitly user-set name (stable across restarts); null →
    // clients fall back to sessionName / pane name as before.
    const hosts = out.hosts.map((h) => {
      const desk = deskOfSession(h.sessionId) ?? deskByDir(h.cwd);
      return {
        ...h,
        displayName: displayName(h.sessionId),
        desk: desk === null ? null : { slug: desk.slug, role: desk.role, dir: desk.dir },
      };
    });
    return json(200, { ...out, hosts });
  }

  // Штат: кто за что отвечает. Заголовки участников берём из реестра хостов,
  // а не чтением файлов сессий: экран открывается часто.
  if (url.pathname === "/api/crew" && req.method === "GET") {
    const snapshot = crewSnapshot();
    const out = await cache.get();
    const titles: Record<string, string | null> = {};
    let loose = 0;
    for (const h of out.hosts) {
      titles[h.sessionId] = displayName(h.sessionId) ?? h.sessionTitle ?? h.sessionPreview ?? h.sessionName;
      if (h.alive && isSharedCwd(h.cwd) && deskOfSession(h.sessionId) === null) loose++;
    }
    return json(200, { ...snapshot, root: crewRoot(), loose, organizer: organizerStatus(), titles });
  }

  if (url.pathname === "/api/crew/organize" && req.method === "POST") {
    const body = (await readJson<{ dryRun?: unknown }>(req)) ?? {};
    if (organizerStatus().running) return json(409, { error: "Организатор уже раскладывает агентов — подожди завершения" });
    const dryRun = body.dryRun === true;
    // Раскладка зовёт модель и живёт минутами: отвечаем сразу, UI опрашивает /api/crew.
    void runOrganizer({
      trigger: dryRun ? "api-dry" : "api",
      dryRun,
      notify: async (payload) => push.broadcast(payload),
    }).finally(() => cache.invalidate());
    return json(202, { ok: true, started: true, dryRun });
  }

  if (url.pathname === "/api/memory/banks" && req.method === "GET") return json(200, { banks: listBanks() });

  const memMatch = /^\/api\/memory\/banks\/([^/]+)\/entries$/.exec(url.pathname);
  if (memMatch && req.method === "GET") {
    const type = url.searchParams.get("type") ?? "";
    // type=all — поиск сразу по всем разделам памяти, без угадывания вкладки.
    if (type !== "all" && !isMemoryTable(type)) return json(400, { error: "unknown memory type" });
    const limitRaw = Number(url.searchParams.get("limit"));
    const offsetRaw = Number(url.searchParams.get("offset"));
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = url.searchParams.get("q")?.trim() || undefined;
    const sortRaw = url.searchParams.get("sort") ?? "";
    const sort = sortRaw === "importance" || sortRaw === "recall" || sortRaw === "confidence" || sortRaw === "ts" ? sortRaw : undefined;
    const source = url.searchParams.get("source")?.trim() || undefined;
    const kind = url.searchParams.get("kind")?.trim() || undefined;
    const minRaw = Number(url.searchParams.get("minImportance"));
    const minImportance = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : undefined;
    const bank = decodeURIComponent(memMatch[1]);
    const result =
      type === "all"
        ? searchAllEntries(bank, { q, sort, source, kind, minImportance, limit, offset })
        : listEntries(bank, type, { q, sort, source, kind, minImportance, limit, offset });
    if (!result) return json(404, { error: "bank not found" });
    return json(200, result);
  }

  const memFacetMatch = /^\/api\/memory\/banks\/([^/]+)\/facets$/.exec(url.pathname);
  if (memFacetMatch && req.method === "GET") {
    const type = url.searchParams.get("type") ?? "";
    if (!isMemoryTable(type)) return json(400, { error: "unknown memory type" });
    const facets = listFacets(decodeURIComponent(memFacetMatch[1]), type);
    if (!facets) return json(404, { error: "bank not found" });
    return json(200, facets);
  }

  // ---- Граф памяти (второй слой рядом с Mnemopi) ----
  if (url.pathname === "/api/graph/stats" && req.method === "GET") {
    const project = url.searchParams.get("project");
    const out = graphStatsOf(graphDb);
    return json(200, { ...out, nodes_top: project === null ? [] : topNodes(graphDb, project, 12) });
  }

  if (url.pathname === "/api/graph/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const project = url.searchParams.get("project");
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 20;
    return json(200, { facts: searchGraph(graphDb, { query: q, project, limit }) });
  }

  if (url.pathname === "/api/graph/context" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? "";
    const q = url.searchParams.get("q");
    const maxRaw = Number(url.searchParams.get("maxChars"));
    const maxChars = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(6000, Math.floor(maxRaw)) : 1400;
    return json(200, { context: contextBlock(graphDb, { project, query: q, maxChars }) });
  }

  if (url.pathname === "/api/graph/nodes" && req.method === "GET") {
    const project = url.searchParams.get("project") ?? "";
    if (project === "") return json(400, { error: "нужен project" });
    return json(200, { nodes: topNodes(graphDb, project, 40) });
  }

  if (url.pathname === "/api/graph/rebuild" && req.method === "POST") {
    const result = rebuildGraph(graphDb);
    return json(200, { ok: true, ...result, lastIndexedAt: Number(getMeta(graphDb, "lastIndexedAt") ?? 0) });
  }

  const linkMatch = /^\/api\/hosts\/([^/]+)\/link$/.exec(url.pathname);
  if (linkMatch && req.method === "POST") {
    const body = (await readJson<{ view?: boolean }>(req)) ?? {};
    const result = await mintLink(decodeURIComponent(linkMatch[1]), body.view === true);
    if (result.stale) return json(409, { error: "stale_generation" });
    if (result.notFound) return json(404, { error: "host not found" });
    return json(200, { url: result.url });
  }

  if (url.pathname === "/api/push/vapid" && req.method === "GET") return json(200, { publicKey: config.vapidPublicKey });

  if (url.pathname === "/api/push/subscribe") {
    if (req.method === "POST") {
      const result = push.save(await readJson<unknown>(req));
      return json(result.ok ? 200 : 400, result);
    }
    if (req.method === "DELETE") {
      const body = await readJson<{ endpoint?: unknown }>(req);
      return json(200, push.remove(body?.endpoint));
    }
  }

  if (url.pathname === "/api/push/test" && req.method === "POST") {
    // Самопроверка: шлёт тестовый пуш на все подписки, возвращает их число.
    const sent = await push.broadcast({ title: "Тестовый пуш", body: "Если видишь это — пуши работают", url: "/" });
    return json(200, { ok: true, sent });
  }

  if (url.pathname === "/api/attach" && req.method === "POST") {
    // multipart: file=<File> — бинарник любого типа с оригинальным именем.
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json(400, { error: "нет файла" });
    const saved = saveAttachment(new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream", file.name);
    return json("error" in saved ? 400 : 200, saved);
  }

  if (url.pathname === "/api/update/status" && req.method === "GET") return json(200, await updates.status());

  if (url.pathname === "/api/update/job" && req.method === "GET") return json(200, updates.currentJob());

  if (url.pathname === "/api/update/jobs" && req.method === "GET") return json(200, { jobs: updates.listJobs().slice(0, 20) });

  // Событийная лента задачи: JSON (since=<seq>) или SSE, если клиент просит поток.
  if (url.pathname === "/api/update/events" && req.method === "GET") {
    const jobId = url.searchParams.get("job");
    const since = Number(url.searchParams.get("since") ?? "0");
    const job = jobId === null ? updates.currentJob() : updates.listJobs().find((item) => item.jobId === jobId) ?? null;
    if (job === null) return json(404, { error: "нет задачи" });
    const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) return json(200, { job, events: updates.jobEvents(job.jobId, Number.isFinite(since) ? since : 0) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let lastSeq = Number.isFinite(since) ? since : 0;
        let closed = false;
        const encoder = new TextEncoder();
        const pump = (): void => {
          if (closed) return;
          const events = updates.jobEvents(job.jobId, lastSeq);
          for (const event of events) {
            lastSeq = event.seq;
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          const current = updates.listJobs().find((item) => item.jobId === job.jobId);
          if (current !== undefined && (current.phase === "COMPLETED" || current.phase === "FAILED" || current.phase === "ROLLED_BACK" || current.phase === "BLOCKED")) {
            closed = true;
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ phase: current.phase })}\n\n`));
            controller.close();
            clearInterval(timer);
          }
        };
        const timer = setInterval(pump, 1_000);
        pump();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" },
    });
  }

  if (url.pathname === "/api/update/apply" && req.method === "POST") {
    const body = (await readJson<{ id?: unknown; confirmBusy?: unknown }>(req)) ?? {};
    if (!isComponentIdLocal(body.id)) return json(400, { error: "unknown id" });
    const outcome = await updates.apply(body.id, body.confirmBusy === true);
    if (outcome.kind === "job_running") return json(409, { error: "job_running", jobId: outcome.jobId });
    if (outcome.kind === "busy") return json(409, { error: "busy", agents: outcome.agents });
    if (outcome.kind === "failed") return json(500, { error: outcome.error });
    return json(202, { job: true, jobId: outcome.jobId });
  }

  if (url.pathname === "/api/update/rollback" && req.method === "POST") {
    const body = (await readJson<{ id?: unknown }>(req)) ?? {};
    if (!isComponentIdLocal(body.id)) return json(400, { error: "unknown id" });
    const outcome = await updates.rollback(body.id);
    if (outcome.kind === "no_previous") return json(404, { error: "no previous" });
    if (outcome.kind === "job_running") return json(409, { error: "job_running" });
    if (outcome.kind === "failed") return json(500, { error: outcome.error });
    return json(202, { ok: true, job: true, jobId: outcome.jobId });
  }

  // Состояние восстановления сессий последней задачи: чекпоинт и журнал шагов.
  if (url.pathname === "/api/recovery" && req.method === "GET") {
    const job = updates.currentJob();
    if (job === null || job.checkpointFile === null) return json(200, { job: null, checkpoint: null, events: [] });
    const checkpointPath = job.checkpointFile;
    // Читаем только из каталога задач: путь приходит из job-файла, а не из запроса,
    // но и он не должен выводить за пределы состояния апдейтера (D9).
    const jobsRoot = join(GATEWAY_DIR, "update", "jobs");
    if (!checkpointPath.startsWith(`${jobsRoot}/`) || !checkpointPath.endsWith(".json")) {
      return json(200, { job, checkpoint: null, events: [], note: "путь чекпоинта вне каталога задач" });
    }
    let checkpoint: unknown = null;
    try {
      checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as unknown;
    } catch {
      checkpoint = null;
    }
    const eventsPath = checkpointPath.replace(/checkpoint\.json$/, "recovery.jsonl");
    const events: unknown[] = [];
    try {
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line) as unknown);
        } catch {
          // битый хвост
        }
      }
    } catch {
      // журнала ещё нет
    }
    return json(200, { job, checkpoint, events: events.slice(-200) });
  }

  if (url.pathname === "/api/agents/start" && req.method === "POST") {
    const body = (await readJson<{ cwd?: unknown; model?: unknown; label?: unknown; role?: unknown; desk?: unknown; charter?: unknown; charterSource?: unknown }>(req)) ?? {};
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") return json(400, { error: "cwd required" });
    const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : undefined;
    const role = typeof body.role === "string" && body.role.trim() !== "" ? body.role.trim() : undefined;
    const deskSlug = typeof body.desk === "string" && body.desk.trim() !== "" ? body.desk.trim() : undefined;
    // Внешний устав (например, промпт из библиотеки AI-инструментов) пишется
    // файлом в папку стола: omp прочитает его как правила проекта.
    const charter = typeof body.charter === "string" && body.charter.trim() !== "" ? body.charter : undefined;
    const charterSource = typeof body.charterSource === "string" && body.charterSource.trim() !== "" ? body.charterSource.trim() : null;
    if (charter !== undefined && Buffer.byteLength(charter, "utf8") > MAX_CHARTER_BYTES) {
      return json(413, { error: `устав больше ${Math.round(MAX_CHARTER_BYTES / 1024)} КБ — выбери промпт короче` });
    }
    // Дом, корень и /tmp — не рабочее место: агент получает свой стол (папку),
    // иначе два десятка разных агентов снова сядут в одну кучу.
    const placement = resolveDeskForStart({ cwd: body.cwd, role, label, slug: deskSlug, by: "start" });
    if (charter !== undefined && placement.desk !== null) {
      setDeskCharter(placement.desk.slug, charter, charterSource);
      placement.desk = { ...placement.desk, charterSource };
    }
    const outcome = await startAgent(placement.dir, model, label ?? placement.desk?.role);
    if (outcome.kind !== "started") {
      // Стол заводился ради этого агента: без агента он пустой и мешает —
      // убираем (pruneEmptyDesk не тронет ничего, кроме своих же файлов).
      if (placement.created && placement.desk !== null) pruneEmptyDesk(placement.desk.slug);
      return json(outcome.kind === "bad_cwd" ? 400 : 502, { error: outcome.error });
    }
    if (label !== undefined) await applyUserLabel(outcome.instanceId, label);
    else if (placement.desk !== null && placement.created) await applyUserLabel(outcome.instanceId, placement.desk.role);
    if (placement.desk !== null) {
      await bindStartedSession(outcome.instanceId, placement.desk.slug);
      // Устав перерисовываем после привязки: в нём есть список агентов стола,
      // а на момент старта он был пуст (агент ещё не имел sessionId).
      ensureDesk({ slug: placement.desk.slug, role: placement.desk.role, brief: placement.desk.brief, by: placement.desk.assignedBy });
    }
    cache.invalidate();
    return json(200, {
      ok: true,
      instanceId: outcome.instanceId,
      note: outcome.note,
      cwd: placement.dir,
      desk: placement.desk === null ? null : { slug: placement.desk.slug, role: placement.desk.role, dir: placement.desk.dir },
    });
  }

  if (url.pathname === "/api/agents/resume" && req.method === "POST") {
    const body = (await readJson<{ cwd?: unknown; session?: unknown; model?: unknown; label?: unknown; mode?: unknown }>(req)) ?? {};
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") return json(400, { error: "cwd required" });
    if (typeof body.session !== "string" || !body.session.endsWith(".jsonl")) return json(400, { error: "session .jsonl path required" });
    const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : undefined;
    // restore = продолжить прерванный ход и субагентов (жертва сбоя питания).
    const mode = body.mode === "restore" ? ("restore" as const) : ("resume" as const);
    // Сессия уже закреплена за столом → продолжается в его папке, а не в общей.
    const head = parseSessionHead(body.session);
    const boundDesk = head.id !== null ? deskOfSession(head.id) : null;
    const placement = boundDesk !== null
      ? { dir: boundDesk.dir, desk: boundDesk }
      : resolveDeskForStart({ cwd: body.cwd, role: head.title ?? head.preview ?? label, label, by: "start" });
    const outcome = await resumeAgent(placement.dir, body.session, model, label ?? placement.desk?.role, mode);
    if (outcome.kind === "bad_cwd") return json(400, { error: outcome.error });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    if (label !== undefined) await applyUserLabel(outcome.instanceId, label);
    if (placement.desk !== null) {
      if (head.id !== null) bindSession(head.id, placement.desk.slug, "start");
      else await bindStartedSession(outcome.instanceId, placement.desk.slug);
    }
    cache.invalidate();
    return json(200, {
      ok: true,
      instanceId: outcome.instanceId,
      note: outcome.note,
      cwd: placement.dir,
      desk: placement.desk === null ? null : { slug: placement.desk.slug, role: placement.desk.role, dir: placement.desk.dir },
    });
  }

  // Хвост транскрипта: рисуется сразу, пока коллаб-гость догружает полный снапшот.
  if (url.pathname === "/api/sessions/tail" && req.method === "GET") {
    // Файл можно задать путём или id сессии: при открытии по deep-link у клиента
    // ещё нет карточки хоста, а id приходит в первом же кадре комнаты.
    const pathParam = url.searchParams.get("path") ?? "";
    const idParam = url.searchParams.get("id") ?? "";
    const path = pathParam !== "" ? pathParam : idParam !== "" ? (findSessionFile(idParam) ?? "") : "";
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 80;
    const entries = path === "" ? null : tailEntries(path, limit);
    if (entries === null) return json(400, { error: "сессия не найдена в хранилище" });
    return json(200, { entries });
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const hosts = await cache.get();
    const live = new Set<string>();
    for (const host of hosts.hosts) if (typeof host.sessionId === "string") live.add(host.sessionId);
    return json(200, { sessions: listSessions(live) });
  }

  // Лента «Активность»: недавние реплики и вызовы из свежих сессий — вкладка
  // без открытого чата раньше не имела источника событий и была всегда пустой.
  if (url.pathname === "/api/activity" && req.method === "GET") {
    const asked = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 200) : 60;
    try {
      const hosts = await cache.get();
      const live = new Set<string>();
      for (const host of hosts.hosts) if (typeof host.sessionId === "string") live.add(host.sessionId);
      return json(200, { rows: recentActivity(limit, live) });
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Переименовать сессию кириллицей: пишем официальный 256-байтовый title-слот
  // omp и запоминаем имя по sessionId (живёт поверх любых auto-тайтлов).
  if (url.pathname === "/api/sessions/rename" && req.method === "POST") {
    const body = (await readJson<{ path?: unknown; title?: unknown }>(req)) ?? {};
    if (typeof body.path !== "string" || !body.path.endsWith(".jsonl")) return json(400, { error: "session .jsonl path required" });
    if (typeof body.title !== "string") return json(400, { error: "title required" });
    let outcome: RenameOutcome;
    try {
      outcome = renameSession(body.path, body.title);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
    if (outcome.kind !== "ok") return json(400, { error: outcome.error });
    const head = parseSessionHead(body.path);
    if (head.id !== null) setDisplayName(head.id, outcome.title, head.cwd);
    return json(200, { ok: true, title: outcome.title, sessionId: head.id });
  }

  // Полнотекстовый поиск по репликам всех сессий (по умолчанию — только слова
  // пользователя). Индекс в памяти шлюза: пока он дочитывает изменённые файлы,
  // в status.pendingFiles видно остаток, и клиент доопрашивает. Ожидание
  // ограничено бюджетом: идущий прогрев не должен держать ответ до конца
  // сканирования — лучше отдать частичный индекс и остаток в pendingFiles.
  if (url.pathname === "/api/sessions/search" && req.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < SEARCH_QUERY_MIN) return json(400, { error: `запрос короче ${SEARCH_QUERY_MIN} символов` });
    const role = url.searchParams.get("role") === "all" ? "all" : "user";
    await refreshIndexWithin(1200);
    return json(200, { query, role, status: searchIndexStatus(), results: searchSessions(query, role) });
  }

  // Старый instanceId → живой (после автоворестора id меняется, сессия нет).
  if (url.pathname === "/api/sessions/remap" && req.method === "GET") {
    const oldId = url.searchParams.get("instanceId") ?? "";
    const instanceId = oldId.length > 0 ? await remapInstance(oldId) : null;
    return json(200, { instanceId });
  }

  if (url.pathname === "/api/agents/stop" && req.method === "POST") {
    const body = (await readJson<{ instanceId?: unknown; force?: unknown }>(req)) ?? {};
    if (typeof body.instanceId !== "string" || body.instanceId.trim() === "") return json(400, { error: "instanceId required" });
    const stopped = (await cache.get()).hosts.find((h) => h.instanceId === body.instanceId);
    const outcome = await stopAgent(body.instanceId, { force: body.force === true });
    if (outcome.scoped) return json(409, { error: "not_started_here" });
    if (!outcome.found) return json(404, { error: "host not found" });
    if (!outcome.killed) return json(502, { error: "process did not exit" });
    // Остановленный пользователем агент не должен воскресать при рестарте шлюза.
    if (stopped !== undefined && typeof stopped.sessionId === "string") forgetSession(stopped.sessionId);
    cache.invalidate();
    return json(200, { ok: true, killed: true });
  }

  // Speech-to-text: телефон шлёт webm/opus, whisper-server возвращает текст.
  if (url.pathname === "/api/stt" && req.method === "POST") {
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.byteLength === 0) return json(400, { error: "Пустая запись" });
    if (audio.byteLength > 10 * 1024 * 1024) return json(400, { error: "Запись слишком длинная" });
    const tmpIn = `/tmp/omp-stt-${Date.now()}.webm`;
    const tmpWav = `${tmpIn}.wav`;
    writeFileSync(tmpIn, audio);
    try {
      // Асинхронный ffmpeg: синхронный вариант вешал весь шлюз на время
      // конвертации — опрос реестра, терминал и автоматизация панелей вставали.
      await new Promise<void>((resolve, reject) => {
        execFile("ffmpeg", ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", tmpWav], { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
      });
      // Основной — GigaAM2 (точнее на русском), фолбэк — whisper small.
      const upstreams: Array<[string, number]> = [
        ["http://127.0.0.1:9110/transcribe", 60_000],
        ["http://127.0.0.1:9100/inference", 120_000],
      ];
      let lastError: string | null = null;
      for (const [upstream, timeoutMs] of upstreams) {
        try {
          let body: BodyInit;
          const wav = await Bun.file(tmpWav).arrayBuffer();
          if (upstream.includes("9110")) {
            // GigaAM-сервис принимает сырое тело (уже wav 16k)
            body = wav;
          } else {
            const form = new FormData();
            form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
            form.append("response_format", "json");
            body = form;
          }
          const upstreamRes = await fetch(upstream, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs) });
          console.log(`[stt] ${new URL(upstream).port} -> ${upstreamRes.status}`);
          if (!upstreamRes.ok) {
            lastError = `upstream ${upstreamRes.status}`;
            continue;
          }
          const parsed = (await upstreamRes.json()) as { text?: unknown };
          const port = new URL(upstream).port;
          console.log(`[stt] ${port} ok`);
          return json(200, { ok: true, text: typeof parsed.text === "string" ? parsed.text.trim() : "", via: port });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          console.log(`[stt] ${new URL(upstream).port} FAIL: ${lastError}`);
        }
      }
      console.log(`[stt] all upstreams failed: ${lastError}`);
      return json(502, { error: `Распознавание не удалось: ${lastError ?? "нет доступных движков"}` });
    } finally {
      try { unlinkSync(tmpIn); } catch { /* already gone */ }
      try { unlinkSync(tmpWav); } catch { /* already gone */ }
    }
  }

  const fileReadMatch = /^\/api\/project\/file$/.exec(url.pathname);
  if (fileReadMatch && req.method === "GET") {
    const dir = url.searchParams.get("path");
    const name = url.searchParams.get("name");
    if (dir === null || name === null) return json(400, { error: "path and name required" });
    const outcome = readProjectFile(dir, name);
    if (outcome.kind === "ok") return json(200, { content: outcome.content });
    if (outcome.kind === "too_large") return json(413, { error: "Файл больше 256 КБ — открой его через Файлы" });
    return json(outcome.kind === "failed" && outcome.error === "path not allowed" ? 400 : 404, { error: outcome.error });
  }

  const renameMatch = /^\/api\/agents\/([^/]+)\/rename$/.exec(url.pathname);
  if (renameMatch && req.method === "POST") {
    const body = (await readJson<{ name?: unknown }>(req)) ?? {};
    if (typeof body.name !== "string") return json(400, { error: "name required" });
    const name = body.name.replace(/\s+/g, " ").trim().slice(0, 48);
    if (name.length === 0) return json(400, { error: "name required" });
		const outcome = await renameAgent(decodeURIComponent(renameMatch[1]), name);
		if (outcome.kind === "not_found") return json(404, { error: outcome.error });
		// Агент есть в реестре, но панелью шлюза не управляется: приложение показывает это отдельно от «агента нет».
		if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
		if (outcome.kind === "failed") return json(502, { error: `Не удалось переименовать: ${outcome.error}` });
		// Кириллическое имя переживает рестарты: пишем его в title-слот сессии и
		// в name-store по стабильному sessionId.
		const host = (await cache.get()).hosts.find((h) => h.instanceId === decodeURIComponent(renameMatch[1]));
		let titleWarning: string | null = null;
		if (host !== undefined) {
			setDisplayName(host.sessionId, name, host.cwd);
			const sessionPath = findSessionFile(host.sessionId);
			if (sessionPath !== null) {
				try {
					const renamed: RenameOutcome = renameSession(sessionPath, name);
					if (renamed.kind !== "ok") titleWarning = `Имя в списке агентов применено, но заголовок сессии не обновлён: ${renamed.error}`;
				} catch (err) {
					// имя панели и name-store уже применены — 502 здесь врал бы.
					titleWarning = `Имя в списке агентов применено, но файл сессии недоступен: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		}
		cache.invalidate();
		return json(200, { ok: true, slug: outcome.slug, warning: titleWarning });
  }

  const settingsMatch = /^\/api\/agents\/([^/]+)\/settings$/.exec(url.pathname);
  if (settingsMatch) {
    const id = decodeURIComponent(settingsMatch[1]);
    if (req.method === "GET") {
      const outcome = await getAgentSettings(id);
      if (outcome.kind === "not_found") return json(404, { error: outcome.error });
      // Агент есть в реестре, но панелью шлюза не управляется: приложение показывает это отдельно от «агента нет».
      if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
        if (outcome.kind === "failed") return json(502, { error: outcome.error });
      return json(200, outcome.settings);
    }
    if (req.method === "POST") {
      const body = (await readJson<{ model?: unknown; thinking?: unknown }>(req)) ?? {};
      const outcome = await setAgentSettings(id, body);
      if (outcome.kind === "bad_request") return json(400, { error: outcome.error });
      if (outcome.kind === "not_found") return json(404, { error: outcome.error });
        if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
        if (outcome.kind === "failed") return json(502, { error: outcome.error });
      return json(200, { ok: true, ...outcome.settings });
    }
  }

  const termMatch = /^\/api\/agents\/([^/]+)\/terminal$/.exec(url.pathname);
  if (termMatch && req.method === "GET") {
    const format = url.searchParams.get("format") === "ansi" ? "ansi" : "plain";
    const outcome = await readTerminal(decodeURIComponent(termMatch[1]), format);
    if (outcome.kind === "not_found") return json(404, { error: outcome.error });
    if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { paneId: outcome.paneId, text: outcome.text, ...(outcome.format === "ansi" ? { format: "ansi" } : {}) });
  }

  const keysMatch = /^\/api\/agents\/([^/]+)\/terminal\/keys$/.exec(url.pathname);
  if (keysMatch && req.method === "POST") {
    const body = (await readJson<{ keys?: unknown }>(req)) ?? {};
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0 || !keys.every((key): key is string => typeof key === "string")) {
      return json(400, { error: "keys must be a non-empty string[]" });
    }
    const outcome = await sendTerminalKeys(decodeURIComponent(keysMatch[1]), keys);
    if (outcome.kind === "bad_key") return json(400, { error: outcome.error });
    if (outcome.kind === "not_found") return json(404, { error: outcome.error });
    if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { ok: true });
  }

  const textMatch = /^\/api\/agents\/([^/]+)\/terminal\/text$/.exec(url.pathname);
  if (textMatch && req.method === "POST") {
    const body = (await readJson<{ text?: unknown }>(req)) ?? {};
    if (typeof body.text !== "string") return json(400, { error: "text required" });
    if (Buffer.byteLength(body.text, "utf8") > MAX_TERMINAL_TEXT_BYTES) return json(400, { error: "text too large (max 8KB)" });
    const outcome = await sendTerminalText(decodeURIComponent(textMatch[1]), body.text);
    if (outcome.kind === "not_found") return json(404, { error: outcome.error });
    if (outcome.kind === "not_managed") return json(404, { error: outcome.error, code: "agent_not_managed" });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { ok: true });
  }

  if (url.pathname === "/api/super/board" && req.method === "GET") {
    try {
      return json(200, await superBoard());
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (url.pathname === "/api/super/dispatch" && req.method === "POST") {
    const body = (await readJson<{ items?: unknown }>(req)) ?? {};
    const parsed = validateDispatchItems(body.items);
    if ("error" in parsed) return json(400, { error: parsed.error });
    try {
      return json(200, { results: await dispatchTasks(parsed.items) });
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const superMatch = /^\/api\/super\/agent\/([^/]+)\/activity$/.exec(url.pathname);
  if (superMatch && req.method === "GET") {
    try {
      const activity = await superActivity(decodeURIComponent(superMatch[1]));
      if (activity === null) return json(404, { error: "agent not found" });
      return json(200, activity);
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- автономные задачи ----
  // Состояние отдаём из стора, а не из памяти контроллера: стор пишется на
  // каждом переходе, поэтому переживает рестарт и совпадает с диском.
  if (url.pathname === "/api/tasks" && req.method === "GET") {
    return json(200, { tasks: taskStore.list().map(taskSummary) });
  }

  if (url.pathname === "/api/tasks" && req.method === "POST") {
    const seed = parseTaskSeed(await readJson<unknown>(req));
    if (typeof seed === "string") return json(400, { error: seed });
    try {
      // Старт автоматический: смысл автономной задачи — «создал и забыл»,
      // отдельный /start остаётся ручным пинком (после рестарта/паузы).
      const created = tasks.create(seed);
      tasks.start(created.id);
      const fresh = taskStore.get(created.id) ?? created;
      return json(201, { task: taskSummary(fresh) });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const taskActionMatch = /^\/api\/tasks\/([^/]+)\/(pause|resume|cancel|start|approval)$/.exec(url.pathname);
  if (taskActionMatch && req.method === "POST") {
    const id = decodeURIComponent(taskActionMatch[1]);
    const task = taskStore.get(id);
    if (task === null) return json(404, { error: "задача не найдена" });
    const action = taskActionMatch[2];
    if (action === "approval") {
      const body = (await readJson<{ decision?: unknown }>(req)) ?? {};
      if (body.decision !== "allow" && body.decision !== "deny") return json(400, { error: "decision: allow|deny" });
      if (task.approval === null) return json(409, { error: "задача не ждёт разрешения" });
      tasks.decideApproval(id, body.decision);
      return json(200, { ok: true });
    }
    // Все четыре действия идемпотентны и молча игнорируют неподходящий статус:
    // повторный клик из UI не должен превращаться в ошибку.
    if (action === "pause") tasks.pause(id);
    else if (action === "resume") tasks.resume(id);
    else if (action === "cancel") tasks.cancel(id);
    else tasks.start(id);
    return json(200, { ok: true });
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
  if (taskMatch && req.method === "GET") {
    const task = taskStore.get(decodeURIComponent(taskMatch[1]));
    if (task === null) return json(404, { error: "задача не найдена" });
    return json(200, task);
  }

  if (url.pathname === "/api/project/files" && req.method === "GET") {
    const dir = url.searchParams.get("path");
    if (dir === null || !dir.startsWith("/")) return json(400, { error: "absolute path required" });
    let stat: { isDirectory(): boolean };
    try {
      stat = statSync(dir);
    } catch {
      return json(400, { error: `path does not exist: ${dir}` });
    }
    if (!stat.isDirectory()) return json(400, { error: "not a directory" });
    try {
      return json(200, listProjectFiles(dir));
    } catch (err) {
      if (err instanceof Error && err.message === "path not allowed") return json(403, { error: "path not allowed" });
      throw err;
    }
  }

  if (url.pathname === "/api/project/git" && req.method === "GET") {
    const dir = url.searchParams.get("path");
    if (dir === null || !dir.startsWith("/")) return json(400, { error: "absolute path required" });
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return json(400, { error: "path is not a directory" });
    const mode = url.searchParams.get("mode");
    if (mode !== "status" && mode !== "diff") return json(400, { error: "mode must be status or diff" });
    if (!existsSync(join(dir, ".git"))) return json(404, { error: "no-git" });
    const outcome = await projectGit(dir, mode);
    if (outcome.kind === "failed" && outcome.error === "path not allowed") return json(403, { error: "path not allowed" });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { text: outcome.text });
  }

  return json(404, { error: "not found" });
}

/**
 * Кросс-origin клиент: PWA может быть открыта с одного адреса (публичный
 * домен), а API-запросы — уходить на другой кандидат из списка (LAN-адрес),
 * когда первый путь недоступен. Токен в Authorization, браузер credentials не
 * шлёт; отражаем Origin, чтобы не ломать same-origin и локальные адреса.
 */
function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  if (origin === null) return res;
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-headers", "authorization,content-type");
  headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("access-control-max-age", "600");
  // Private Network Access: PWA, открытая с публичного домена, обращается к
  // LAN-адресу шлюза, когда публичный путь недоступен. Chrome требует этот
  // заголовок в ответе на preflight, иначе запрос к приватному IP не уходит.
  if (req.headers.get("access-control-request-private-network") === "true") {
    headers.set("access-control-allow-private-network", "true");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  async fetch(req): Promise<Response> {
    const started = performance.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, url);
    } catch (err) {
      res = json(502, { error: err instanceof Error ? err.message : String(err) });
    }
    console.log(`${req.method} ${url.pathname} ${res.status} ${Math.round(performance.now() - started)}ms`);
    return withCors(req, res);
  },
});

console.log(`gateway listening on http://${config.host}:${config.port} (pid ${process.pid})`);
