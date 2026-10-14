import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listHosts } from "./hosts.ts";
import { resolveBin } from "./bins.ts";

const POCKET_WORKSPACE_LABEL = "pocket";

/**
 * Instances started through this checkout's gateway endpoints. Gates /api/agents/stop:
 * the omp collab registry is machine-global, so any gateway instance (or a runaway
 * automation loop against one) could otherwise SIGTERM agents started elsewhere.
 * Persists across gateway restarts; unknown ids require explicit force.
 */
const STARTED_FILE = join(new URL(".", import.meta.url).pathname, "started-instances.json");

function loadStarted(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(STARTED_FILE, "utf8"));
		return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function recordStarted(instanceId: string): void {
	const merged = loadStarted();
	merged.add(instanceId);
	const tmp = `${STARTED_FILE}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify([...merged], null, "\t"));
		renameSync(tmp, STARTED_FILE);
	} catch {
		// best-effort bookkeeping; stop still reachable via explicit force
	}
}
const REGISTER_TIMEOUT_MS = 45_000;
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

export async function runHerdr(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  let herdrBin: string;
  try {
    herdrBin = await resolveBin("herdr");
  } catch (err) {
    throw new Error(`herdr недоступен: ${err instanceof Error ? err.message : String(err)}`);
  }
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([herdrBin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`herdr недоступен: ${err instanceof Error ? err.message : String(err)}`);
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

// herdr CLI prints a JSON envelope {id, result, type}; unwrap `result`, keep plain text as-is.
export function unwrapHerdr(out: { code: number; stdout: string; stderr: string }): { ok: true; result: unknown } | { ok: false; error: string } {
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

const RU_TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
	й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
	у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
	э: "e", ю: "yu", я: "ya",
};

/** herdr принимает имена [a-z0-9_-]{1,32}; кириллицу и пробелы превращаем в слаг. */
function sanitizeAgentName(label: string): string {
	const lowered = label.toLowerCase().replace(/[а-яё]/g, (ch) => RU_TRANSLIT[ch] ?? "-");
	const slug = lowered
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+/, "")
		.slice(0, 32)
		.replace(/[-_]+$/, "");
	if (slug.length === 0 || !/^[a-z]/.test(slug)) return `agent-${slug.replace(/^[^a-z0-9]+/, "") || "x"}`.slice(0, 32);
	return slug;
}

/** Русские формулировки для типовых отказов herdr. */
function ruAgentStartError(raw: string): string {
	if (/agent_name_taken/i.test(raw)) return "Имя агента уже занято — придумай другое";
	if (/invalid_agent_name/i.test(raw)) return "Имя агента: только латиница, цифры, «-» и «_»";
	if (/server_not_running/i.test(raw)) return "herdr не запущен — запусти его на мини-ПК";
	return `Не удалось запустить агента: ${raw.slice(0, 160)}`;
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

async function waitForNewHost(
  cwd: string,
  knownIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<{ instanceId: string | null; lastPollError: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastPollError: string | null = null;
  for (;;) {
    try {
      const fresh = (await listHosts()).hosts.find((h) => h.cwd === cwd && !knownIds.has(h.instanceId));
      if (fresh) return { instanceId: fresh.instanceId, lastPollError: null };
    } catch (err) {
      // реестр мог быть недоступен — запоминаем последнюю ошибку для финального сообщения
      lastPollError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) return { instanceId: null, lastPollError };
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

async function launchAgentOnce(
	cwd: string,
	model: string | undefined,
	label: string | undefined,
	ompArgs: readonly string[],
): Promise<StartOutcome> {
  let cwdOk = false;
  try {
    cwdOk = statSync(cwd).isDirectory();
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) return { kind: "bad_cwd", error: `cwd does not exist: ${cwd}` };

  const displayLabel = label?.trim() || basename(cwd);
  // herdr требует уникальные имена: занятые получаем из списка и суффиксируем.
  const takenNames = new Set<string>();
  const agentList = unwrapHerdr(await runHerdr(["agent", "list"], 10_000));
  if (agentList.ok && agentList.result !== null && typeof agentList.result === "object" && "agents" in agentList.result) {
    const agents = agentList.result.agents;
    if (Array.isArray(agents)) {
      for (const entry of agents) {
        if (entry !== null && typeof entry === "object" && "name" in entry && typeof entry.name === "string") {
          takenNames.add(entry.name);
        }
      }
    }
  }
  const baseName = sanitizeAgentName(displayLabel);
  let name = baseName;
  for (let i = 2; takenNames.has(name) && i < 10; i++) name = `${baseName}-${i}`;
  const before = await listHosts();

  const wsId = await resolvePocketWorkspace();
  const tab = unwrapHerdr(await runHerdr(["tab", "create", "--workspace", wsId, "--cwd", cwd, "--label", displayLabel], 10_000));
  if (!tab.ok) return { kind: "failed", error: `herdr tab create failed: ${tab.error}` };
  const parsedTab = tab.result as { root_pane?: { pane_id?: unknown } };
  const paneId = typeof parsedTab.root_pane?.pane_id === "string" ? parsedTab.root_pane.pane_id : null;
  if (!paneId) return { kind: "failed", error: "herdr tab create returned no pane_id" };

  const startArgs = ["agent", "start", name, "--kind", "omp", "--pane", paneId];
  // omp сам уходит во временный каталог при старте в ~ (registered cwd != cwd ->
  // waitForNewHost не находит хост), поэтому рабочий каталог задаём явно
  const passthrough = ["--cwd", cwd, "--allow-home", ...(model ? ["--model", model] : []), ...ompArgs];
  if (passthrough.length > 0) startArgs.push("--", ...passthrough);
  const started = unwrapHerdr(await runHerdr(startArgs, 60_000));
  if (!started.ok) {
    await runHerdr(["pane", "close", paneId], 5000);
    return { kind: "failed", error: ruAgentStartError(started.error) };
  }

  const knownIds = new Set(before.hosts.map((h) => h.instanceId));
  const { instanceId, lastPollError } = await waitForNewHost(cwd, knownIds, REGISTER_TIMEOUT_MS);
  if (!instanceId) {
    // Панель может держать живого агента, который просто не успел/не смог
    // зарегистрироваться — перед закрытием проверяем её состояние.
    let paneAlive = false;
    try {
      const pane = await runHerdr(["pane", "get", paneId], 5000);
      paneAlive = pane.code === 0;
    } catch {
      paneAlive = false;
    }
    const error = lastPollError
      ? `реестр недоступен: ${lastPollError}`
      : `агент не зарегистрировался за 45 с`;
    if (paneAlive) {
      return { kind: "failed", error: `агент запущен, но не зарегистрировался в collab — проверьте список агентов (${error})` };
    }
    await runHerdr(["pane", "close", paneId], 5000);
    return { kind: "failed", error: `агент не запустился — панель закрыта (${error})` };
  }
  recordStarted(instanceId);
  return { kind: "started", instanceId, note: `agent ${name} started in ${cwd}` };
}

function enqueueLaunch(run: () => Promise<StartOutcome>): Promise<StartOutcome> {
  const result = startQueue.then(run, run);
  startQueue = result.catch(() => {});
  return result;
}

export function startAgent(cwd: string, model: string | undefined, label: string | undefined): Promise<StartOutcome> {
  return enqueueLaunch(() => launchAgentOnce(cwd, model, label, []));
}

export type ResumeMode = "resume" | "restore";

/** Resume a persisted session jsonl in a fresh herdr pane. `restore` uses
 * `omp --restore`: continues the interrupted turn and re-runs the subagents
 * the crashed process left behind — the power-loss recovery path. */
export function resumeAgent(
  cwd: string,
  sessionPath: string,
  model: string | undefined,
  label: string | undefined,
  mode: ResumeMode = "resume",
): Promise<StartOutcome> {
  let exists = false;
  try {
    exists = statSync(sessionPath).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return Promise.resolve({ kind: "bad_cwd", error: `session file not found: ${sessionPath}` });
  const fallbackLabel = `resume-${basename(sessionPath).replace(/\.jsonl$/, "").slice(-18)}`;
  const ompFlag = mode === "restore" ? "--restore" : "--resume";
  return enqueueLaunch(() => launchAgentOnce(cwd, model, label ?? fallbackLabel, [ompFlag, sessionPath]));
}

export async function stopAgent(
	instanceId: string,
	opts: { force?: boolean } = {},
): Promise<{ found: boolean; killed: boolean; scoped: boolean }> {
	if (!opts.force && !loadStarted().has(instanceId)) {
		return { found: false, killed: false, scoped: true };
	}
	const host = (await listHosts()).hosts.find((h) => h.instanceId === instanceId);
	if (!host) return { found: false, killed: false, scoped: false };

  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(host.pid, sig);
    } catch {
      // process already gone; registry check below decides
    }
  };

  signal("SIGTERM");
  if (await waitHostGone(instanceId, 5_000)) return { found: true, killed: true, scoped: false };
  signal("SIGKILL");
  if (await waitHostGone(instanceId, 5_000)) return { found: true, killed: true, scoped: false };
  return { found: true, killed: false, scoped: false };
}
