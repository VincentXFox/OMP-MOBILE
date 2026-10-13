import { extname, join, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { listHosts, mintLink } from "./hosts.ts";
import type { OmpHostsOutput } from "./hosts.ts";
import { resumeAgent, startAgent, stopAgent } from "./agents.ts";
import { listSessions } from "./sessions.ts";
import { listProjectFiles, projectGit, readTerminal, sendTerminalKeys, sendTerminalText, MAX_TERMINAL_TEXT_BYTES } from "./files.ts";
import { PushManager } from "./push.ts";
import { isMemoryTable, listBanks, listEntries } from "./memory.ts";
import { Updater, LIVE_UPDATER_PATHS, isComponentId } from "./updater.ts";
import { dispatchTasks, superActivity, superBoard, validateDispatchItems } from "./super.ts";

const DIST_DIR = new URL("../app/dist/", import.meta.url).pathname;
const HOSTS_CACHE_MS = 2000;
const POLL_INTERVAL_MS = 5000;

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

// Shared 2s cache absorbs UI polling and feeds the push poller.
class HostsCache {
  #data: OmpHostsOutput | null = null;
  #at = 0;

  get(): Promise<OmpHostsOutput> {
    if (this.#data && Date.now() - this.#at < HOSTS_CACHE_MS) return Promise.resolve(this.#data);
    return listHosts().then((out) => {
      this.#data = out;
      this.#at = Date.now();
      return out;
    });
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
    if (rel === "/sw.js") headers["cache-control"] = "no-store";
    return new Response(Bun.file(file), { headers });
  }
  // SPA fallback: unknown extension-less paths get index.html
  if (extname(rel) === "") {
    return new Response(Bun.file(join(DIST_DIR, "index.html")), { headers: { "content-type": MIME_BY_EXT[".html"] } });
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

const poller = setInterval(() => {
  cache.get().then((out) => push.poll(out.hosts)).catch(() => {});
}, POLL_INTERVAL_MS);
poller.unref();

const updater = new Updater(LIVE_UPDATER_PATHS, push);
void updater.boot().catch(() => {});
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updateTimer = setInterval(() => {
  updater.checkAndNotify().catch(() => {});
}, UPDATE_CHECK_INTERVAL_MS);
updateTimer.unref();
const updateBootCheck = setTimeout(() => {
  updater.checkAndNotify().catch(() => {});
}, 60_000);
updateBootCheck.unref();

async function route(req: Request, url: URL): Promise<Response> {
  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);

  if (req.headers.get("authorization") !== `Bearer ${config.token}`) return json(401, { error: "unauthorized" });

  if (url.pathname === "/api/hosts" && req.method === "GET") return json(200, await cache.get());

  if (url.pathname === "/api/memory/banks" && req.method === "GET") return json(200, { banks: listBanks() });

  const memMatch = /^\/api\/memory\/banks\/([^/]+)\/entries$/.exec(url.pathname);
  if (memMatch && req.method === "GET") {
    const type = url.searchParams.get("type") ?? "";
    if (!isMemoryTable(type)) return json(400, { error: "unknown memory type" });
    const limitRaw = Number(url.searchParams.get("limit"));
    const offsetRaw = Number(url.searchParams.get("offset"));
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = url.searchParams.get("q")?.trim() || undefined;
    const result = listEntries(decodeURIComponent(memMatch[1]), type, { q, limit, offset });
    if (!result) return json(404, { error: "bank not found" });
    return json(200, result);
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

  if (url.pathname === "/api/update/status" && req.method === "GET") return json(200, await updater.status());

  if (url.pathname === "/api/update/job" && req.method === "GET") return json(200, updater.jobState());

  if (url.pathname === "/api/update/backup" && req.method === "POST") return json(200, await updater.backup());

  if (url.pathname === "/api/update/apply" && req.method === "POST") {
    const body = (await readJson<{ id?: unknown; confirmBusy?: unknown }>(req)) ?? {};
    if (!isComponentId(body.id)) return json(400, { error: "unknown id" });
    const outcome = await updater.apply(body.id, body.confirmBusy === true);
    if (outcome.kind === "job_running") return json(409, { error: "job_running" });
    if (outcome.kind === "busy") return json(409, { error: "busy", agents: outcome.agents });
    return json(202, { job: true });
  }

  if (url.pathname === "/api/update/rollback" && req.method === "POST") {
    const body = (await readJson<{ id?: unknown }>(req)) ?? {};
    if (!isComponentId(body.id)) return json(400, { error: "unknown id" });
    const outcome = await updater.rollback(body.id);
    if (outcome.kind === "no_previous") return json(404, { error: "no previous" });
    if (outcome.kind === "job_running") return json(409, { error: "job_running" });
    return json(202, { ok: true, job: true });
  }

  if (url.pathname === "/api/agents/start" && req.method === "POST") {
    const body = (await readJson<{ cwd?: unknown; model?: unknown; label?: unknown }>(req)) ?? {};
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") return json(400, { error: "cwd required" });
    const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : undefined;
    const outcome = await startAgent(body.cwd, model, label);
    if (outcome.kind === "bad_cwd") return json(400, { error: outcome.error });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { ok: true, instanceId: outcome.instanceId, note: outcome.note });
  }

  if (url.pathname === "/api/agents/resume" && req.method === "POST") {
    const body = (await readJson<{ cwd?: unknown; session?: unknown; model?: unknown; label?: unknown }>(req)) ?? {};
    if (typeof body.cwd !== "string" || body.cwd.trim() === "") return json(400, { error: "cwd required" });
    if (typeof body.session !== "string" || !body.session.endsWith(".jsonl")) return json(400, { error: "session .jsonl path required" });
    const model = typeof body.model === "string" && body.model.trim() !== "" ? body.model.trim() : undefined;
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : undefined;
    const outcome = await resumeAgent(body.cwd, body.session, model, label);
    if (outcome.kind === "bad_cwd") return json(400, { error: outcome.error });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { ok: true, instanceId: outcome.instanceId, note: outcome.note });
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const hosts = await cache.get();
    const live = new Set<string>();
    for (const host of hosts.hosts) if (typeof host.sessionId === "string") live.add(host.sessionId);
    return json(200, { sessions: listSessions(live) });
  }

  if (url.pathname === "/api/agents/stop" && req.method === "POST") {
    const body = (await readJson<{ instanceId?: unknown; force?: unknown }>(req)) ?? {};
    if (typeof body.instanceId !== "string" || body.instanceId.trim() === "") return json(400, { error: "instanceId required" });
    const outcome = await stopAgent(body.instanceId, { force: body.force === true });
    if (outcome.scoped) return json(409, { error: "not_started_here" });
    if (!outcome.found) return json(404, { error: "host not found" });
    if (!outcome.killed) return json(502, { error: "process did not exit" });
    return json(200, { ok: true, killed: true });
  }

  const termMatch = /^\/api\/agents\/([^/]+)\/terminal$/.exec(url.pathname);
  if (termMatch && req.method === "GET") {
    const outcome = await readTerminal(decodeURIComponent(termMatch[1]));
    if (outcome.kind === "not_found") return json(404, { error: outcome.error });
    if (outcome.kind === "not_herdr") return json(404, { error: "not-herdr-agent" });
    if (outcome.kind === "failed") return json(502, { error: outcome.error });
    return json(200, { paneId: outcome.paneId, text: outcome.text });
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
    if (outcome.kind === "not_herdr") return json(404, { error: "not-herdr-agent" });
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
    if (outcome.kind === "not_herdr") return json(404, { error: "not-herdr-agent" });
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
    return res;
  },
});

console.log(`gateway listening on http://${config.host}:${config.port} (pid ${process.pid})`);
