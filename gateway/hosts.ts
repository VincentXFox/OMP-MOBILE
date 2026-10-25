import { statSync } from "node:fs";
import { resolveBin } from "./bins.ts";
import { findSessionFile, parseSessionHead } from "./sessions.ts";
import { todoProgressOf, type TodoProgress } from "./todo-progress.ts";

export interface OmpHost {
  instanceId: string;
  generation: number;
  pid: number;
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  model: { provider: string; id: string };
  startedAt: number;
  participants: number;
  relayConnected: boolean;
  inputRequired: boolean;
  busy: boolean;
  access: "view" | "control";
  /** Процесс omp жив (collab list отдаёт и мёртвые записи реестра). */
  alive: boolean;
  /** Полный путь к .jsonl сессии — для resume мёртвого агента. */
  sessionFile: string | null;
  /** Заголовок из файла сессии (256-байтный title-слот omp, включая переименования
   * из TUI). Реестр отдаёт только имя на момент старта, а сессия без панели —
   * вообще без имени: в списке агентов это и был «агент без названия». */
  sessionTitle: string | null;
  /** Первый запрос пользователя — имя для сессии, которой omp ещё не дал заголовок. */
  sessionPreview: string | null;
  /** Сводка туду-борда сессии (null — туду в ней не трогали). */
  todo: TodoProgress | null;
}

export interface OmpHostsOutput {
  hosts: OmpHost[];
}

/** Заголовок и первый запрос сессии дороже одного stat: кэш по (путь, mtime, size) —
 * 5-секундный опрос реестра иначе перечитывал бы по 64 КБ на каждого агента. */
const IDENTITY_CACHE_LIMIT = 256;
const identityCache = new Map<string, { mtimeMs: number; size: number; title: string | null; preview: string | null }>();

function sessionIdentityOf(path: string | null): { title: string | null; preview: string | null } {
  if (path === null) return { title: null, preview: null };
  try {
    const stat = statSync(path);
    const hit = identityCache.get(path);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return { title: hit.title, preview: hit.preview };
    }
    const head = parseSessionHead(path);
    const identity = { title: head.title, preview: head.preview };
    if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
    identityCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ...identity });
    return identity;
  } catch {
    return { title: null, preview: null };
  }
}

/** Жив ли процесс: kill(pid, 0) — probe без сигнала. EPERM = есть, но чужой. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// omp CLI output is a verified stable JSON shape; assert at the process boundary.
export async function runOmp(args: string[], timeoutMs: number, ompPath?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let ompBin: string;
  if (ompPath !== undefined && ompPath !== "") {
    ompBin = ompPath;
  } else {
    try {
      ompBin = await resolveBin("omp");
    } catch (err) {
      throw new Error(`omp недоступен: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([ompBin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`omp недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  void Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    },
  );
  return promise;
}

export async function listHosts(ompPath?: string): Promise<OmpHostsOutput> {
  const res = await runOmp(["collab", "list", "--json"], 5000, ompPath);
  if (res.code !== 0) throw new Error(`omp collab list failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  const parsed = JSON.parse(res.stdout) as Partial<OmpHostsOutput>;
  const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
  return {
    hosts: hosts.map((h) => {
      const sessionFile = typeof h.sessionId === "string" ? findSessionFile(h.sessionId) : null;
      const identity = sessionIdentityOf(sessionFile);
      return {
        ...h,
        alive: isProcessAlive(h.pid),
        sessionFile,
        sessionTitle: identity.title,
        sessionPreview: identity.preview,
        // Прогресс туду-борда — для полоски в карточке агента на главной.
        todo: todoProgressOf(sessionFile),
      };
    }),
  };
}

export async function mintLink(id: string, view: boolean): Promise<{ url: string; stale: boolean; notFound: boolean }> {
  const args = ["collab", "link", id, "--json"];
  if (view) args.push("--view");
  const res = await runOmp(args, 5000);
  if (res.code === 0) {
    const parsed = JSON.parse(res.stdout) as { url?: unknown };
    if (typeof parsed.url === "string") return { url: parsed.url, stale: false, notFound: false };
    throw new Error("omp collab link returned no url");
  }
  const err = res.stderr.trim() || res.stdout.trim();
  if (err.includes("stale_generation")) return { url: "", stale: true, notFound: false };
  if (/not found|no such|unknown|no active|matches/i.test(err)) return { url: "", stale: false, notFound: true };
  throw new Error(`omp collab link failed: ${err}`);
}
