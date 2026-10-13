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
}

export interface OmpHostsOutput {
  hosts: OmpHost[];
}

// omp CLI output is a verified stable JSON shape; assert at the process boundary.
async function runOmp(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["omp", ...args], { stdout: "pipe", stderr: "pipe" });
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

export async function listHosts(): Promise<OmpHostsOutput> {
  const res = await runOmp(["collab", "list", "--json"], 5000);
  if (res.code !== 0) throw new Error(`omp collab list failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  const parsed = JSON.parse(res.stdout) as Partial<OmpHostsOutput>;
  return { hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [] };
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
