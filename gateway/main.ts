import { extname, join, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { listHosts, mintLink } from "./hosts.ts";
import type { OmpHostsOutput } from "./hosts.ts";
import { PushManager } from "./push.ts";

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

async function route(req: Request, url: URL): Promise<Response> {
  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);

  if (req.headers.get("authorization") !== `Bearer ${config.token}`) return json(401, { error: "unauthorized" });

  if (url.pathname === "/api/hosts" && req.method === "GET") return json(200, await cache.get());

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
