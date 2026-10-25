import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeAgent, type ResumeMode } from "./agents.ts";
import { listPanes, type ManagedPane } from "./panes.ts";
import { continueAfterRestore } from "./recovery/afterRestore.ts";
import { findSessionFile, listSessions, parseSessionHead, sessionsRootReadable } from "./sessions.ts";
import { displayName } from "./names.ts";
import { listHosts, type OmpHost } from "./hosts.ts";
import { recordRemapFile } from "./recovery/migrate.ts";

/**
 * Crash-recovery conductor. The gateway observes the live registry on every
 * poll and persists the desired layout (which omp sessions must be running).
 * After a gateway/mini-PC restart it relaunches every dead victim with
 * `omp --restore`, so the interrupted turn and its subagents continue, then
 * sweeps runtime panes the manifest knows nothing about.
 */
const MANIFEST_FILE = join(new URL(".", import.meta.url).pathname, "runtime-manifest.json");
const REMAP_FILE = join(new URL(".", import.meta.url).pathname, "restore-remap.json");
/** Сессии, живые на момент последнего опроса реестра (обновляется каждые 5 с).
 *  Только они — жертвы сбоя питания: остановленный пользователем агент в этот
 *  снимок не попадает и после рестарта шлюза не воскресает. */
const LIVE_FILE = join(new URL(".", import.meta.url).pathname, "runtime-live.json");
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTRY_WAIT_MS = 120_000;
/** Осиротевшая панель восстанавливается только по свежей сессии (сутки). */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REGISTRY_POLL_MS = 3_000;

interface ManifestEntry {
  instanceId: string;
  sessionId: string;
  cwd: string;
  /** `provider/id` for `omp --model`, null when unknown. */
  model: string | null;
  /** Last observed registry/session name — fallback tab label. */
  name: string | null;
  updatedAt: number;
}

export interface RestoreReport {
  restored: number;
  failed: number;
  details: string[];
}

const manifest = new Map<string, ManifestEntry>();
/** old instanceId → new instanceId (survives gateway restarts via REMAP_FILE). */
const remap = new Map<string, string>();
let booted = false;

function loadJsonMap(path: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) out.set(key, value);
    }
  } catch {
    // missing/corrupt file → empty state
  }
  return out;
}

function persistJsonMap(path: string, entries: Iterable<[string, unknown]>): void {
  try {
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) out[key] = value;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out, null, "\t"));
    renameSync(tmp, path);
  } catch {
    // best-effort bookkeeping
  }
}

function persistManifest(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [sessionId, entry] of manifest) {
    if (entry.updatedAt < cutoff) manifest.delete(sessionId);
  }
  persistJsonMap(MANIFEST_FILE, manifest.entries());
}

/** Handover must durably publish the old address before reporting success.
 * Read the disk table too: the migrator is a separate process from the gateway. */
export function recordInstanceRemap(oldId: string, newId: string): void {
  recordRemapFile(REMAP_FILE, oldId, newId);
  remap.set(oldId, newId);
}

/** Missing key → undefined (record invalid); JSON-null → null (field absent); else the string. */
function pickNullishString(obj: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in obj)) return undefined;
  const value: unknown = obj[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function narrowManifest(value: object): ManifestEntry | null {
  // JSON.parse boundary: every field is checked explicitly below; the Record
  // view only supplies an index signature and is never trusted for a type.
  const rec: Record<string, unknown> = value as Record<string, unknown>;
  if (typeof rec.instanceId !== "string" || typeof rec.sessionId !== "string" || typeof rec.cwd !== "string") return null;
  const model = pickNullishString(rec, "model");
  if (model === undefined) return null;
  const name = pickNullishString(rec, "name");
  if (name === undefined) return null;
  const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : 0;
  return { instanceId: rec.instanceId, sessionId: rec.sessionId, cwd: rec.cwd, model, name, updatedAt };
}

// Boot state: manifest keyed by sessionId, remap as a plain old→new table.
for (const [sessionId, value] of loadJsonMap(MANIFEST_FILE)) {
  if (value === null || typeof value !== "object") continue;
  const entry = narrowManifest(value);
  if (entry !== null) manifest.set(sessionId, entry);
}
for (const [oldId, value] of loadJsonMap(REMAP_FILE)) {
  if (typeof value === "string") remap.set(oldId, value);
}

/** Сессии, живые при последнем запуске шлюза: единственные кандидаты на
 *  восстановление. Пустой снимок = шлюз остановлен планово/впервые — не
 *  восстанавливаем ничего, иначе каждый рестарт поднимает закрытые сессии. */
function loadCrashLiveSessions(): ReadonlySet<string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(LIVE_FILE, "utf8"));
    if (raw === null || typeof raw !== "object" || !("sessions" in raw) || !Array.isArray(raw.sessions)) return new Set();
    return new Set(raw.sessions.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

const crashLiveSessions: ReadonlySet<string> = loadCrashLiveSessions();
let lastLiveSnapshot = "";

/** Запоминает текущий набор живых сессий (атомарно, только при изменении). */
function persistLiveSnapshot(hosts: readonly OmpHost[]): void {
  const sessions = hosts.map((h) => h.sessionId).filter((id): id is string => typeof id === "string" && id.length > 0);
  const payload = JSON.stringify({ sessions });
  if (payload === lastLiveSnapshot) return;
  lastLiveSnapshot = payload;
  try {
    const tmp = `${LIVE_FILE}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, LIVE_FILE);
  } catch {
    // best-effort bookkeeping
  }
}

/** Снять сессию с учёта: остановленный агент не должен воскресать при рестарте. */
export function forgetSession(sessionId: string): void {
  if (manifest.delete(sessionId)) persistManifest();
}

/** Record the live registry into the manifest; called on every hosts poll. */
export function observeHosts(hosts: readonly OmpHost[]): void {
  persistLiveSnapshot(hosts);
  let changed = false;
  for (const host of hosts) {
    if (typeof host.sessionId !== "string" || host.sessionId.length === 0) continue;
    const model =
      host.model !== null && typeof host.model === "object" && typeof host.model.provider === "string" && typeof host.model.id === "string"
        ? `${host.model.provider}/${host.model.id}`
        : null;
    const name = typeof host.sessionName === "string" && host.sessionName.length > 0 ? host.sessionName : null;
    const prev = manifest.get(host.sessionId);
    if (prev && prev.instanceId === host.instanceId && prev.model === model && prev.name === name) continue;
    manifest.set(host.sessionId, {
      instanceId: host.instanceId,
      sessionId: host.sessionId,
      cwd: typeof host.cwd === "string" ? host.cwd : "",
      model,
      name,
      updatedAt: Date.now(),
    });
    changed = true;
  }
  if (changed) persistManifest();
}

async function liveBySessionId(sessionId: string): Promise<string | null> {
  try {
    const host = (await listHosts()).hosts.find((h) => h.sessionId === sessionId);
    return host?.instanceId ?? null;
  } catch {
    return null;
  }
}

/** New instanceId for a stale one, or null when the session is still dead. */
export async function remapInstance(oldInstanceId: string): Promise<string | null> {
  const persisted = loadJsonMap(REMAP_FILE).get(oldInstanceId);
  if (typeof persisted === "string") remap.set(oldInstanceId, persisted);
  const mapped = remap.get(oldInstanceId);
  if (mapped !== undefined) return mapped;
  // The session may have come back without a conductor run: match via manifest.
  const entry = [...manifest.values()].find((e) => e.instanceId === oldInstanceId);
  if (entry === undefined) return null;
  return liveBySessionId(entry.sessionId);
}

/** Каталоги панелей-агентов: по ним поднимаются осиротевшие панели, о которых
 * манифест ничего не знает. */
async function paneAgentCwds(): Promise<string[]> {
  let panes: ManagedPane[];
  try {
    panes = await listPanes();
  } catch {
    return [];
  }
  const cwds = new Set<string>();
  for (const pane of panes) {
    // Панель-агент — та, где запускали процесс (`launchArgv`): обычный терминал
    // в каталоге сессии поднимать нечего, туда агент не запускался.
    if (pane.launchArgv.length > 0 && pane.cwd.length > 0) cwds.add(pane.cwd);
  }
  return [...cwds];
}

/** Сессия уже поднята панелью рантайма (по sessionId или по журналу)? */
async function sessionInPane(sessionId: string, sessionFile: string): Promise<boolean> {
  let panes: ManagedPane[];
  try {
    panes = await listPanes();
  } catch {
    return false;
  }
  return panes.some((pane) => pane.sessionId === sessionId || pane.sessionFile === sessionFile);
}

async function waitForRegistry(): Promise<readonly OmpHost[] | null> {
  const deadline = Date.now() + REGISTRY_WAIT_MS;
  for (;;) {
    try {
      return (await listHosts()).hosts;
    } catch {
      if (Date.now() >= deadline) return null; // registry never came up; nothing safe to do
      await Bun.sleep(REGISTRY_POLL_MS);
    }
  }
}

/** Boot-time recovery: wait for the registry, then relaunch every dead victim. */
export async function bootRestore(): Promise<RestoreReport | null> {
  if (booted) return null;
  booted = true;
  const live = await waitForRegistry();
  if (live === null) return null;
  const victims = await restoreVictims(live);
  const orphans = await restoreOrphans(live);
  return {
    restored: victims.restored + orphans.restored,
    failed: victims.failed + orphans.failed,
    details: [...victims.details, ...orphans.details],
  };
}

/** Resume every manifest session that is not live (`--restore`: crash path). */
export async function restoreVictims(liveHosts: readonly OmpHost[]): Promise<RestoreReport> {
  const report: RestoreReport = { restored: 0, failed: 0, details: [] };
  const liveSessions = new Set(liveHosts.map((h) => h.sessionId));
  // Только сессии, живые при последнем работающем шлюзе: остановленный вручную
  // агент в снимок не попал и воскрешаться не должен.
  const victims = [...manifest.values()].filter((e) => e.cwd.length > 0 && !liveSessions.has(e.sessionId) && crashLiveSessions.has(e.sessionId));
  // Записи, которые не были живы при последнем запуске, — закрытые навсегда:
  // их нужно снять с учёта, иначе они висят до TTL и мусорят восстановлением.
  let pruned = false;
  for (const entry of [...manifest.values()]) {
    if (liveSessions.has(entry.sessionId) || crashLiveSessions.has(entry.sessionId)) continue;
    manifest.delete(entry.sessionId);
    pruned = true;
  }
  if (pruned) persistManifest();
  let alreadyLive = 0;
  for (const victim of victims) {
    const stillLive = await liveBySessionId(victim.sessionId);
    if (stillLive !== null) continue;
    const path = findSessionFile(victim.sessionId);
    if (path === null) {
      // Файла нет (сессию удалили) — TTL 30 дней только шумит на каждом старте.
      // Недоступная ФС (не читается корневой каталог) запись не трогает.
      if (sessionsRootReadable()) {
        manifest.delete(victim.sessionId);
        persistManifest();
      }
      continue;
    }
    // Панель рантайма уже подняла эту сессию: второй агент на том же журнале
    // сломал бы его — повторно не запускаем.
    if (await sessionInPane(victim.sessionId, path)) {
      alreadyLive++;
      continue;
    }
    const label = displayName(victim.sessionId) ?? victim.name ?? parseSessionHead(path).title ?? undefined;
    const outcome = await resumeAgent(victim.cwd, path, victim.model ?? undefined, label, "restore");
    if (outcome.kind === "started") {
      recordInstanceRemap(victim.instanceId, outcome.instanceId);
      report.restored++;
      report.details.push(`${label ?? victim.sessionId}: восстановлен`);
      await continueIfNeeded(victim, path, "restore");
    } else if (outcome.kind === "failed") {
      report.failed++;
      report.details.push(`${label ?? victim.sessionId}: ${outcome.error}`);
    }
  }
  if (alreadyLive > 0) report.details.push(`уже живы в панелях рантайма: ${alreadyLive}`);
  return report;
}

/** Resume runtime-managed omp panes the manifest knows nothing about. */
export async function restoreOrphans(liveHosts: readonly OmpHost[]): Promise<RestoreReport> {
  const report: RestoreReport = { restored: 0, failed: 0, details: [] };
  const liveCwds = new Set(liveHosts.map((h) => h.cwd));
  const manifestCwds = new Set([...manifest.values()].map((e) => e.cwd));
  const orphanCwds = (await paneAgentCwds()).filter((cwd) => !liveCwds.has(cwd) && !manifestCwds.has(cwd));
  if (orphanCwds.length === 0) return report;
  // listSessions sorts by mtime desc — the first hit is the freshest victim.
  const sessions = listSessions(new Set(liveHosts.map((h) => h.sessionId)));
  for (const cwd of orphanCwds) {
    // Только реально прерванный ход (не «aborted» — его пользователь закрыл сам)
    // и не старше суток: иначе поднимается давно брошенная чужая сессия.
    const fresh = Date.now() - ORPHAN_MAX_AGE_MS;
    const newest = sessions.find((s) => s.cwd === cwd && s.status === "interrupted" && s.modified >= fresh);
    if (newest === undefined) continue;
    const label = displayName(newest.id) ?? newest.title ?? newest.preview ?? undefined;
    const outcome = await resumeAgent(cwd, newest.path, undefined, label, "restore");
    if (outcome.kind === "started") {
      report.restored++;
      report.details.push(`${cwd}: осиротевшая панель поднята`);
      await continueIfNeeded({ cwd, pid: null, sessionId: newest.id }, newest.path, "restore");
    } else if (outcome.kind === "failed") {
      report.failed++;
      report.details.push(`${cwd}: ${outcome.error}`);
    }
  }
  return report;
}

/** Продолжение после `--restore`: у omp автодоводка срабатывает только для турна,
 * оборванного без session_exit. Здесь — явный промпт с проверкой результатов,
 * чтобы опасные операции не повторялись вслепую. */
async function continueIfNeeded(
  victim: { cwd: string; pid?: number | null; sessionId: string },
  sessionPath: string,
  mode: ResumeMode,
): Promise<void> {
  if (mode !== "restore") return;
  try {
    const outcome = await continueAfterRestore(sessionPath, victim.cwd, victim.pid ?? null, { from: null, to: null });
    if (outcome.blocked !== null) console.log(`[restore] ${victim.sessionId}: продолжение не отправлено — ${outcome.blocked}`);
    else if (outcome.continued) console.log(`[restore] ${victim.sessionId}: турн (${outcome.turn}) продолжен явным промптом`);
  } catch (err) {
    console.log(`[restore] ${victim.sessionId}: продолжение не удалось — ${err instanceof Error ? err.message : String(err)}`);
  }
}
