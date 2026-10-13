import { statSync } from "node:fs";
import { basename } from "node:path";
import { listHosts } from "./hosts.ts";

const POCKET_WORKSPACE_LABEL = "pocket";
const REGISTER_TIMEOUT_MS = 10_000;
const REGISTER_POLL_MS = 1_000;
const STOP_POLL_MS = 500;

export type StartOutcome =
  | { kind: "started"; instanceId: string; note: string }
  | { kind: "bad_cwd"; error: string }
  | { kind: "failed"; error: string };

interface HerdrEnvelope {
  result?: unknown;
}

// Serialize start flows so each can attribute exactly one new collab host to its own tab.
let startQueue: Promise<unknown> = Promise.resolve();

async function runHerdr(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
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

// herdr CLI prints a JSON envelope {id, result, type}; unwrap `result`, keep plain text as-is.
function unwrapHerdr(out: { code: number; stdout: string; stderr: string }): { ok: true; result: unknown } | { ok: false; error: string } {
  const text = out.stdout.trim();
  if (out.code !== 0) return { ok: false, error: out.stderr.trim() || text || `exit ${out.code}` };
  try {
    const parsed = JSON.parse(text) as HerdrEnvelope;
    if (parsed !== null && typeof parsed === "object" && "result" in parsed) return { ok: true, result: parsed.result };
    return { ok: true, result: parsed };
  } catch {
    return { ok: true, result: text };
  }
}

function sanitizeAgentName(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "agent" : cleaned;
}

function findWorkspaceId(result: unknown): string | null {
  const parsed = result as { workspaces?: unknown };
  const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  for (const entry of workspaces) {
    if (entry === null || typeof entry !== "object") continue;
    const ws = entry as { label?: unknown; workspace_id?: unknown };
    if (ws.label === POCKET_WORKSPACE_LABEL && typeof ws.workspace_id === "string") return ws.workspace_id;
  }
  return null;
}

async function resolvePocketWorkspace(): Promise<string> {
  const listed = unwrapHerdr(await runHerdr(["workspace", "list"], 5000));
  if (!listed.ok) throw new Error(`herdr workspace list failed: ${listed.error}`);
  const existing = findWorkspaceId(listed.result);
  if (existing) return existing;

  const created = unwrapHerdr(await runHerdr(["workspace", "create", "--label", POCKET_WORKSPACE_LABEL], 5000));
  if (!created.ok) throw new Error(`herdr workspace create failed: ${created.error}`);
  const parsed = created.result as { workspace?: { workspace_id?: unknown }; root_pane?: { workspace_id?: unknown } };
  if (typeof parsed.workspace?.workspace_id === "string") return parsed.workspace.workspace_id;
  if (typeof parsed.root_pane?.workspace_id === "string") return parsed.root_pane.workspace_id;
  throw new Error("herdr workspace create returned no workspace_id");
}

async function waitForNewHost(cwd: string, knownIds: ReadonlySet<string>, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fresh = (await listHosts()).hosts.find((h) => h.cwd === cwd && !knownIds.has(h.instanceId));
      if (fresh) return fresh.instanceId;
    } catch {
      // registry poll failure is retried until the deadline
    }
    if (Date.now() >= deadline) return null;
    await Bun.sleep(REGISTER_POLL_MS);
  }
}

async function waitHostGone(instanceId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let gone: boolean;
    try {
      gone = !(await listHosts()).hosts.some((h) => h.instanceId === instanceId);
    } catch {
      gone = false;
    }
    if (gone) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(STOP_POLL_MS);
  }
}

async function startAgentOnce(cwd: string, model: string | undefined, label: string | undefined): Promise<StartOutcome> {
  let cwdOk = false;
  try {
    cwdOk = statSync(cwd).isDirectory();
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) return { kind: "bad_cwd", error: `cwd does not exist: ${cwd}` };

  const displayLabel = label?.trim() || basename(cwd);
  const name = sanitizeAgentName(displayLabel);
  const before = await listHosts();

  const wsId = await resolvePocketWorkspace();
  const tab = unwrapHerdr(await runHerdr(["tab", "create", "--workspace", wsId, "--cwd", cwd, "--label", displayLabel], 10_000));
  if (!tab.ok) return { kind: "failed", error: `herdr tab create failed: ${tab.error}` };
  const parsedTab = tab.result as { root_pane?: { pane_id?: unknown } };
  const paneId = typeof parsedTab.root_pane?.pane_id === "string" ? parsedTab.root_pane.pane_id : null;
  if (!paneId) return { kind: "failed", error: "herdr tab create returned no pane_id" };

  const startArgs = ["agent", "start", name, "--kind", "omp", "--pane", paneId];
  if (model) startArgs.push("--", "--model", model);
  const started = unwrapHerdr(await runHerdr(startArgs, 60_000));
  if (!started.ok) {
    await runHerdr(["pane", "close", paneId], 5000);
    return { kind: "failed", error: `herdr agent start failed: ${started.error}` };
  }

  const knownIds = new Set(before.hosts.map((h) => h.instanceId));
  const instanceId = await waitForNewHost(cwd, knownIds, REGISTER_TIMEOUT_MS);
  if (!instanceId) {
    await runHerdr(["pane", "close", paneId], 5000);
    return { kind: "failed", error: "agent started but did not join the collab registry within 10s" };
  }
  return { kind: "started", instanceId, note: `agent ${name} started in ${cwd}` };
}

export function startAgent(cwd: string, model: string | undefined, label: string | undefined): Promise<StartOutcome> {
  const run = startQueue.then(() => startAgentOnce(cwd, model, label), () => startAgentOnce(cwd, model, label));
  startQueue = run.catch(() => {});
  return run;
}

export async function stopAgent(instanceId: string): Promise<{ found: boolean; killed: boolean }> {
  const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
  if (!host) return { found: false, killed: false };

  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(host.pid, sig);
    } catch {
      // process already gone; registry check below decides
    }
  };

  signal("SIGTERM");
  if (await waitHostGone(instanceId, 5_000)) return { found: true, killed: true };
  signal("SIGKILL");
  if (await waitHostGone(instanceId, 5_000)) return { found: true, killed: true };
  return { found: true, killed: false };
}
