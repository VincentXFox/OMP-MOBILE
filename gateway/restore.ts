import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeAgent, runHerdr, unwrapHerdr, type ResumeMode } from "./agents.ts";
import { findSessionFile, listSessions, parseSessionHead } from "./sessions.ts";
import { displayName } from "./names.ts";
import { listHosts, type OmpHost } from "./hosts.ts";

/**
 * Crash-recovery conductor. The gateway observes the live registry on every
 * poll and persists the desired layout (which omp sessions must be running).
 * After a gateway/mini-PC restart it relaunches every dead victim with
 * `omp --restore`, so the interrupted turn and its subagents continue, then
 * sweeps herdr panes the manifest knows nothing about.
 */
const MANIFEST_FILE = join(new URL(".", import.meta.url).pathname, "runtime-manifest.json");
const REMAP_FILE = join(new URL(".", import.meta.url).pathname, "restore-remap.json");
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REGISTRY_WAIT_MS = 120_000;
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

function persistRemap(): void {
  persistJsonMap(REMAP_FILE, remap.entries());
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

/** Record the live registry into the manifest; called on every hosts poll. */
export function observeHosts(hosts: readonly OmpHost[]): void {
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
  const mapped = remap.get(oldInstanceId);
  if (mapped !== undefined) return mapped;
  // The session may have come back without a conductor run: match via manifest.
  const entry = [...manifest.values()].find((e) => e.instanceId === oldInstanceId);
  if (entry === undefined) return null;
  return liveBySessionId(entry.sessionId);
}

async function herdrAgentCwds(): Promise<string[]> {
  const listed = unwrapHerdr(await runHerdr(["agent", "list"], 10_000));
  if (!listed.ok || listed.result === null || typeof listed.result !== "object" || !("agents" in listed.result) || !Array.isArray(listed.result.agents)) {
    return [];
  }
  const cwds: string[] = [];
  for (const row of listed.result.agents) {
    if (row !== null && typeof row === "object" && "cwd" in row && typeof row.cwd === "string") {
      cwds.push(row.cwd);
    }
  }
  return cwds;
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
  const victims = [...manifest.values()].filter((e) => e.cwd.length > 0 && !liveSessions.has(e.sessionId));
  for (const victim of victims) {
    const stillLive = await liveBySessionId(victim.sessionId);
    if (stillLive !== null) continue;
    const path = findSessionFile(victim.sessionId);
    if (path === null) {
      report.details.push(`нет файла сессии для ${victim.sessionId}`);
      continue;
    }
    const label = displayName(victim.sessionId) ?? victim.name ?? parseSessionHead(path).title ?? undefined;
    const outcome = await resumeAgent(victim.cwd, path, victim.model ?? undefined, label, "restore");
    if (outcome.kind === "started") {
      remap.set(victim.instanceId, outcome.instanceId);
      persistRemap();
      report.restored++;
      report.details.push(`${label ?? victim.sessionId}: восстановлен`);
    } else if (outcome.kind === "failed") {
      report.failed++;
      report.details.push(`${label ?? victim.sessionId}: ${outcome.error}`);
    }
  }
  return report;
}

/** Resume herdr-managed omp panes the manifest knows nothing about. */
export async function restoreOrphans(liveHosts: readonly OmpHost[]): Promise<RestoreReport> {
  const report: RestoreReport = { restored: 0, failed: 0, details: [] };
  const liveCwds = new Set(liveHosts.map((h) => h.cwd));
  const manifestCwds = new Set([...manifest.values()].map((e) => e.cwd));
  const orphanCwds = (await herdrAgentCwds()).filter((cwd) => !liveCwds.has(cwd) && !manifestCwds.has(cwd));
  if (orphanCwds.length === 0) return report;
  // listSessions sorts by mtime desc — the first hit is the freshest victim.
  const sessions = listSessions(new Set(liveHosts.map((h) => h.sessionId)));
  for (const cwd of orphanCwds) {
    const newest = sessions.find((s) => s.cwd === cwd && (s.status === "interrupted" || s.status === "aborted"));
    if (newest === undefined) continue;
    const label = displayName(newest.id) ?? newest.title ?? newest.preview ?? undefined;
    const outcome = await resumeAgent(cwd, newest.path, undefined, label, "restore");
    if (outcome.kind === "started") {
      report.restored++;
      report.details.push(`${cwd}: осиротевшая панель поднята`);
    } else if (outcome.kind === "failed") {
      report.failed++;
      report.details.push(`${cwd}: ${outcome.error}`);
    }
  }
  return report;
}
