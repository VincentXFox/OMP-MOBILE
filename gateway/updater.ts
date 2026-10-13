import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listHosts } from "./hosts.ts";
import type { PushManager, PushPayload } from "./push.ts";

export const COMPONENT_IDS = ["omp", "gateway", "frontend"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@oh-my-pi%2Fpi-coding-agent";
const INSTALL_SCRIPT_URL = "https://omp.sh/install";
const NETWORK_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 120_000;
const BUN_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 600_000;
const CHECK_TTL_MS = 15 * 60_000;
const DETAIL_LIMIT = 4000;
const GATEWAY_VERIFY_ATTEMPTS = 15;

export interface UpdateStep {
  label: string;
  status: "run" | "ok" | "fail";
  detail?: string;
}

export interface UpdateJobState {
  running: boolean;
  id: ComponentId | null;
  steps: UpdateStep[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Set just before `systemctl --user restart`: lets the next process finish the job. */
  resumeAfterRestart: ComponentId | null;
}

export interface UpdateStateFile {
  lastCheck: number | null;
  latestOmp: string | null;
  latestGitSha: string | null;
  pushedPair: { from: string; to: string } | null;
  previousOmpVersion: string | null;
  previousGitSha: string | null;
  job: UpdateJobState;
}

export interface Compatibility {
  status: "ok" | "warn" | "unknown";
  detail: string;
}

export interface UpdateComponent {
  id: ComponentId;
  title: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  installMethod: string;
  compatibility: Compatibility;
  notes: string[];
}

export interface UpdateStatus {
  components: UpdateComponent[];
  lastCheck: number | null;
  remoteConfigured: boolean;
}

export type ApplyOutcome =
  | { kind: "accepted" }
  | { kind: "job_running" }
  | { kind: "busy"; agents: { sessionName: string | null; cwd: string }[] };

export type RollbackOutcome = { kind: "accepted" } | { kind: "job_running" } | { kind: "no_previous" };

export function isComponentId(v: unknown): v is ComponentId {
  return typeof v === "string" && COMPONENT_IDS.some((id) => id === v);
}

export interface UpdaterPaths {
  repoDir: string;
  ompBin: string;
  bunBin: string;
  gitBin: string;
  shBin: string;
  systemctlBin: string;
  systemdUnit: string;
  statePath: string;
  backupsDir: string;
  ompConfigPath: string;
  gatewayConfigPath: string;
  subscriptionsPath: string;
  appPackageJsonPath: string;
  gatewayPackageJsonPath: string;
}

export const LIVE_UPDATER_PATHS: UpdaterPaths = {
  repoDir: "/home/vincentfox/omp-mobile",
  ompBin: "/home/vincentfox/.local/bin/omp",
  bunBin: "/home/vincentfox/.bun/bin/bun",
  gitBin: "/usr/bin/git",
  shBin: "/bin/sh",
  systemctlBin: "/usr/bin/systemctl",
  systemdUnit: "omp-pocket-gateway",
  statePath: "/home/vincentfox/omp-mobile/gateway/update-state.json",
  backupsDir: "/home/vincentfox/omp-mobile/backups",
  ompConfigPath: "/home/vincentfox/.omp/agent/config.yml",
  gatewayConfigPath: "/home/vincentfox/omp-mobile/gateway/config.json",
  subscriptionsPath: "/home/vincentfox/omp-mobile/gateway/subscriptions.json",
  appPackageJsonPath: "/home/vincentfox/omp-mobile/app/package.json",
  gatewayPackageJsonPath: "/home/vincentfox/omp-mobile/gateway/package.json",
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.input === undefined ? "ignore" : "pipe",
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
  void Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    },
  );
  return promise;
}

function truncate(text: string, limit = DETAIL_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} символов)`;
}

async function fetchLatestOmp(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (!res.ok) return null;
    const parsed: unknown = await res.json();
    if (typeof parsed !== "object" || parsed === null || !("dist-tags" in parsed)) return null;
    const tags = parsed["dist-tags"];
    if (typeof tags !== "object" || tags === null || !("latest" in tags)) return null;
    const latest = tags["latest"];
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

function parsePair(version: string): { major: number; minor: number } | null {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function readPackageVersion(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
      return parsed.version;
    }
    return null;
  } catch {
    return null;
  }
}

function readPiWirePin(appPackageJsonPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(appPackageJsonPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("dependencies" in parsed)) return null;
    const deps = parsed["dependencies"];
    if (typeof deps !== "object" || deps === null || !("@oh-my-pi/pi-wire" in deps)) return null;
    const pin = deps["@oh-my-pi/pi-wire"];
    return typeof pin === "string" ? pin : null;
  } catch {
    return null;
  }
}

function defaultJob(): UpdateJobState {
  return { running: false, id: null, steps: [], error: null, startedAt: null, finishedAt: null, resumeAfterRestart: null };
}

function emptyState(): UpdateStateFile {
  return {
    lastCheck: null,
    latestOmp: null,
    latestGitSha: null,
    pushedPair: null,
    previousOmpVersion: null,
    previousGitSha: null,
    job: defaultJob(),
  };
}

function parseSteps(v: unknown): UpdateStep[] {
  if (!Array.isArray(v)) return [];
  const steps: UpdateStep[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    if (!("label" in item) || typeof item.label !== "string") continue;
    if (!("status" in item) || (item.status !== "run" && item.status !== "ok" && item.status !== "fail")) continue;
    const detail = "detail" in item && typeof item.detail === "string" ? item.detail : undefined;
    steps.push(detail === undefined ? { label: item.label, status: item.status } : { label: item.label, status: item.status, detail });
  }
  return steps;
}

function loadState(path: string): UpdateStateFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    const state = emptyState();
    if ("lastCheck" in parsed && typeof parsed.lastCheck === "number") state.lastCheck = parsed.lastCheck;
    if ("latestOmp" in parsed && typeof parsed.latestOmp === "string") state.latestOmp = parsed.latestOmp;
    if ("latestGitSha" in parsed && typeof parsed.latestGitSha === "string") state.latestGitSha = parsed.latestGitSha;
    if ("previousOmpVersion" in parsed && typeof parsed.previousOmpVersion === "string") state.previousOmpVersion = parsed.previousOmpVersion;
    if ("previousGitSha" in parsed && typeof parsed.previousGitSha === "string") state.previousGitSha = parsed.previousGitSha;
    if ("pushedPair" in parsed && typeof parsed.pushedPair === "object" && parsed.pushedPair !== null) {
      const pair = parsed.pushedPair;
      if ("from" in pair && typeof pair.from === "string" && "to" in pair && typeof pair.to === "string") {
        state.pushedPair = { from: pair.from, to: pair.to };
      }
    }
    if ("job" in parsed && typeof parsed.job === "object" && parsed.job !== null) {
      const job = parsed.job;
      state.job = {
        running: "running" in job && typeof job.running === "boolean" ? job.running : false,
        id: "id" in job && isComponentId(job.id) ? job.id : null,
        steps: "steps" in job ? parseSteps(job.steps) : [],
        error: "error" in job && typeof job.error === "string" ? job.error : null,
        startedAt: "startedAt" in job && typeof job.startedAt === "number" ? job.startedAt : null,
        finishedAt: "finishedAt" in job && typeof job.finishedAt === "number" ? job.finishedAt : null,
        resumeAfterRestart:
          "resumeAfterRestart" in job && isComponentId(job.resumeAfterRestart) ? job.resumeAfterRestart : null,
      };
    }
    return state;
  } catch {
    return emptyState();
  }
}

export class Updater {
  readonly #paths: UpdaterPaths;
  readonly #push: PushManager;
  #state: UpdateStateFile;
  #refreshing: Promise<void> | null = null;

  constructor(paths: UpdaterPaths, push: PushManager) {
    this.#paths = paths;
    this.#push = push;
    this.#state = loadState(paths.statePath);
  }

  /** Reconcile the persisted job after process start: resume post-restart verification, close stale jobs. */
  async boot(): Promise<void> {
    if (!this.#state.job.running) return;
    if (this.#state.job.resumeAfterRestart === null) {
      this.#state.job.running = false;
      this.#state.job.error = "задача прервана перезапуском gateway";
      for (const step of this.#state.job.steps) {
        if (step.status === "run") step.status = "fail";
      }
      this.#state.job.finishedAt = Date.now();
      this.#persist();
      return;
    }
    // Gateway was restarted from within the job: restart/earlier steps are done, finish with verification.
    for (const step of this.#state.job.steps) {
      if (step.status === "run") {
        step.status = "ok";
        step.detail = `${step.detail ? `${step.detail} — ` : ""}выполнено, задача продолжена после перезапуска gateway`;
      }
    }
    this.#persist();
    await this.#runJob(async () => {
      await this.#step("Проверка gateway после рестарта", () => this.#verifyGatewayStep());
    });
  }

  jobState(): UpdateJobState {
    return this.#state.job;
  }

  #persist(): void {
    writeFileSync(this.#paths.statePath, JSON.stringify(this.#state, null, 2) + "\n");
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#doRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<void> {
    const [ompLatest, gitSha] = await Promise.all([fetchLatestOmp(), this.#remoteHeadSha()]);
    this.#state.latestOmp = ompLatest;
    this.#state.latestGitSha = gitSha;
    this.#state.lastCheck = Date.now();
    this.#persist();
  }

  /** 6h update-available check: push once per (current → latest) pair. */
  async checkAndNotify(): Promise<void> {
    await this.refresh();
    const current = await this.#ompVersion();
    const latest = this.#state.latestOmp;
    if (current === null || latest === null || current === latest) return;
    if (this.#state.pushedPair?.from === current && this.#state.pushedPair?.to === latest) return;
    const payload: PushPayload = { title: "Доступно обновление OMP", body: `${current} → ${latest}`, url: "/#/updates" };
    await this.#push.broadcast(payload);
    this.#state.pushedPair = { from: current, to: latest };
    this.#persist();
  }

  async status(): Promise<UpdateStatus> {
    if (this.#state.lastCheck === null || Date.now() - this.#state.lastCheck > CHECK_TTL_MS) {
      await this.refresh();
    }
    const remoteConfigured = await this.#remoteConfigured();
    const [ompCurrent, headFull] = await Promise.all([this.#ompVersion(), this.#headSha()]);
    const headShort = headFull === null ? null : headFull.slice(0, 7);
    const compat = this.#compatibility(ompCurrent);
    const gwVersion = readPackageVersion(this.#paths.gatewayPackageJsonPath);
    const appVersion = readPackageVersion(this.#paths.appPackageJsonPath);
    const latestGitShort = this.#state.latestGitSha === null ? null : this.#state.latestGitSha.slice(0, 7);

    const ompNotes: string[] = [];
    if (this.#state.latestOmp === null) {
      ompNotes.push("не удалось получить данные npm-реестра — проверка обновлений OMP недоступна");
    }
    const gitNotes: string[] = [];
    if (!remoteConfigured) {
      gitNotes.push("git remote не настроен — обновление кода недоступно, применяется только пересборка из локального состояния");
    } else if (this.#state.latestGitSha === null) {
      gitNotes.push("не удалось получить состояние удалённого репозитория");
    }
    const gitUpToDate = this.#state.latestGitSha !== null && headFull !== null && this.#state.latestGitSha === headFull;

    const components: UpdateComponent[] = [
      {
        id: "omp",
        title: "OMP",
        current: ompCurrent ?? "неизвестно",
        latest: this.#state.latestOmp,
        updateAvailable: this.#state.latestOmp !== null && ompCurrent !== null && this.#state.latestOmp !== ompCurrent,
        installMethod: "официальный установщик omp.sh → ~/.local/bin/omp",
        compatibility: compat,
        notes: ompNotes,
      },
      {
        id: "gateway",
        title: "Gateway (Bun)",
        current: `${gwVersion ?? "неизвестно"} (${headShort ?? "?"})`,
        latest: latestGitShort,
        updateAvailable: !gitUpToDate && this.#state.latestGitSha !== null,
        installMethod: "git pull + bun install/build, systemd unit omp-pocket-gateway",
        compatibility: compat,
        notes: gitNotes,
      },
      {
        id: "frontend",
        title: "Фронтенд (PWA)",
        current: `${appVersion ?? "неизвестно"} (${headShort ?? "?"})`,
        latest: latestGitShort,
        updateAvailable: !gitUpToDate && this.#state.latestGitSha !== null,
        installMethod: "git pull + bun install + bun run build (app/dist раздаёт gateway)",
        compatibility: compat,
        notes: gitNotes,
      },
    ];
    return { components, lastCheck: this.#state.lastCheck, remoteConfigured };
  }

  /** Copies omp + gateway config into backups/<ISO timestamp>/. */
  async backup(): Promise<{ ok: true; dir: string }> {
    const dir = join(this.#paths.backupsDir, new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dir, { recursive: true });
    for (const src of [this.#paths.ompConfigPath, this.#paths.gatewayConfigPath, this.#paths.subscriptionsPath]) {
      if (!existsSync(src)) continue;
      cpSync(src, join(dir, basename(src)));
    }
    return { ok: true, dir };
  }

  async apply(id: ComponentId, confirmBusy: boolean): Promise<ApplyOutcome> {
    if (this.#state.job.running) return { kind: "job_running" };
    if (id === "omp" && !confirmBusy) {
      const hosts = await listHosts();
      const busy = hosts.hosts.filter((h) => h.busy);
      if (busy.length > 0) {
        return { kind: "busy", agents: busy.map((h) => ({ sessionName: h.sessionName, cwd: h.cwd })) };
      }
    }
    this.#state.job = { running: true, id, steps: [], error: null, startedAt: Date.now(), finishedAt: null, resumeAfterRestart: null };
    this.#persist();
    void (id === "omp" ? this.#applyOmp() : this.#applyGit(id)).catch(() => {});
    return { kind: "accepted" };
  }

  async rollback(id: ComponentId): Promise<RollbackOutcome> {
    if (this.#state.job.running) return { kind: "job_running" };
    if (id === "omp") {
      if (this.#state.previousOmpVersion === null) return { kind: "no_previous" };
    } else if (this.#state.previousGitSha === null) {
      return { kind: "no_previous" };
    }
    this.#state.job = { running: true, id, steps: [], error: null, startedAt: Date.now(), finishedAt: null, resumeAfterRestart: null };
    this.#persist();
    void (id === "omp" ? this.#rollbackOmp() : this.#rollbackGit(id)).catch(() => {});
    return { kind: "accepted" };
  }

  async #runJob(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.#state.job.error = err instanceof Error ? err.message : String(err);
      for (const step of this.#state.job.steps) {
        if (step.status === "run") step.status = "fail";
      }
    } finally {
      this.#state.job.running = false;
      this.#state.job.resumeAfterRestart = null;
      this.#state.job.finishedAt = Date.now();
      this.#persist();
    }
  }

  async #step(label: string, work: () => Promise<string>): Promise<void> {
    const step: UpdateStep = { label, status: "run" };
    this.#state.job.steps.push(step);
    this.#persist();
    try {
      const detail = await work();
      step.status = "ok";
      if (detail !== "") step.detail = detail;
    } catch (err) {
      step.status = "fail";
      step.detail = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.#persist();
    }
  }

  async #git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<RunResult> {
    return run([this.#paths.gitBin, ...args], {
      cwd: this.#paths.repoDir,
      timeoutMs,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
  }

  async #remoteConfigured(): Promise<boolean> {
    const res = await this.#git(["remote", "get-url", "origin"], NETWORK_TIMEOUT_MS);
    return res.code === 0;
  }

  async #headSha(): Promise<string | null> {
    const res = await this.#git(["rev-parse", "HEAD"], NETWORK_TIMEOUT_MS);
    if (res.code !== 0) return null;
    const sha = res.stdout.trim();
    return sha === "" ? null : sha;
  }

  async #remoteHeadSha(): Promise<string | null> {
    try {
      if (!(await this.#remoteConfigured())) return null;
      const branchRes = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"], NETWORK_TIMEOUT_MS);
      const branch = branchRes.stdout.trim();
      if (branchRes.code !== 0 || branch === "" || branch === "HEAD") return null;
      const ls = await this.#git(["ls-remote", "origin", `refs/heads/${branch}`], NETWORK_TIMEOUT_MS);
      if (ls.code !== 0) return null;
      const sha = ls.stdout.split("\n")[0]?.split("\t")[0]?.trim();
      return sha === "" || sha === undefined ? null : sha;
    } catch {
      return null;
    }
  }

  async #ompVersion(): Promise<string | null> {
    const res = await run([this.#paths.ompBin, "--version"], { timeoutMs: NETWORK_TIMEOUT_MS });
    const m = /^omp\/(\d+\.\d+\.\d+)\s*$/m.exec(res.stdout.trim());
    return m ? m[1] : null;
  }

  #compatibility(ompCurrent: string | null): Compatibility {
    const pin = readPiWirePin(this.#paths.appPackageJsonPath);
    const omp = ompCurrent === null ? null : parsePair(ompCurrent);
    const wire = pin === null ? null : parsePair(pin);
    if (omp === null || wire === null) {
      return { status: "unknown", detail: `не удалось сопоставить версии: OMP ${ompCurrent ?? "?"}, pi-wire ${pin ?? "?"}` };
    }
    if (omp.major === wire.major && omp.minor === wire.minor) {
      return { status: "ok", detail: `OMP ${omp.major}.${omp.minor}.x соответствует pi-wire приложения ${wire.major}.${wire.minor}.x` };
    }
    return { status: "warn", detail: `протокол collab может отличаться — обнови приложение (OMP ${ompCurrent} ↔ pi-wire ${pin})` };
  }

  #readGatewayConfig(): { token: string; port: number; host: string } | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#paths.gatewayConfigPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return null;
      const token = "token" in parsed && typeof parsed.token === "string" ? parsed.token : "";
      const port = "port" in parsed && typeof parsed.port === "number" ? parsed.port : 8088;
      const host = "host" in parsed && typeof parsed.host === "string" ? parsed.host : "127.0.0.1";
      return { token, port, host };
    } catch {
      return null;
    }
  }

  async #verifyGatewayStep(): Promise<string> {
    const cfg = this.#readGatewayConfig();
    const base = `http://${cfg?.host ?? "127.0.0.1"}:${cfg?.port ?? 8088}`;
    const headers: Record<string, string> = cfg !== null && cfg.token !== "" ? { authorization: `Bearer ${cfg.token}` } : {};
    let lastError = "проверка не выполнялась";
    for (let attempt = 0; attempt < GATEWAY_VERIFY_ATTEMPTS; attempt++) {
      await Bun.sleep(1000);
      try {
        const res = await fetch(`${base}/api/hosts`, { headers, signal: AbortSignal.timeout(3000) });
        if (res.ok) return `gateway отвечает: ${base}/api/hosts (попытка ${attempt + 1})`;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`gateway не отвечает после рестарта (${base}/api/hosts): ${lastError}`);
  }

  async #installOmp(version: string): Promise<string> {
    const res = await fetch(INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`установочный скрипт недоступен: HTTP ${res.status}`);
    const script = await res.text();
    const r = await run([this.#paths.shBin, "-s", "--", "--binary", "--ref", `v${version}`], {
      input: script,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const out = truncate(`$ sh -s -- --binary --ref v${version}\n${r.stdout}${r.stderr}`.trim());
    if (r.code !== 0) throw new Error(out === "" ? `установщик завершился с кодом ${r.code}` : out);
    return out === "" ? "установщик отработал без вывода" : out;
  }

  async #applyOmp(): Promise<void> {
    await this.#runJob(async () => {
      const current = await this.#ompVersion();
      await this.#step("Резервная копия конфигов", async () => (await this.backup()).dir);
      await this.#step("Фиксация предыдущей версии", async () => {
        if (current === null) throw new Error("не удалось определить текущую версию OMP (omp --version)");
        this.#state.previousOmpVersion = current;
        this.#persist();
        return current;
      });
      const latest = await this.#step("Определение последней версии", async () => {
        const v = this.#state.latestOmp ?? (await fetchLatestOmp());
        if (v === null) throw new Error("не удалось получить последнюю версию OMP из npm-реестра");
        return v;
      });
      await this.#step(`Установка OMP ${latest}`, async () => this.#installOmp(latest));
      await this.#step("Проверка версии", async () => {
        const now = await this.#ompVersion();
        if (now !== latest) {
          throw new Error(`после установки omp --version = ${now ?? "?"}, ожидалось ${latest}; предыдущая версия ${current ?? "?"} доступна для отката`);
        }
        return `omp ${now}`;
      });
      await this.#step("Пересчёт доступных обновлений", async () => {
        await this.refresh();
        return "последняя версия и совместимость пересчитаны";
      });
    });
  }

  async #rollbackOmp(): Promise<void> {
    await this.#runJob(async () => {
      const target = this.#state.previousOmpVersion;
      if (target === null) throw new Error("нет сохранённой предыдущей версии OMP");
      await this.#step("Резервная копия конфигов", async () => (await this.backup()).dir);
      await this.#step(`Установка предыдущей OMP ${target}`, () => this.#installOmp(target));
      await this.#step("Проверка версии", async () => {
        const now = await this.#ompVersion();
        if (now !== target) throw new Error(`после отката omp --version = ${now ?? "?"}, ожидалось ${target}`);
        return `omp ${now}`;
      });
    });
  }

  async #applyGit(id: ComponentId): Promise<void> {
    await this.#runJob(async () => {
      await this.#step("Резервная копия конфигов", async () => (await this.backup()).dir);
      await this.#step("Фиксация текущего состояния", async () => {
        const sha = await this.#headSha();
        if (sha === null) throw new Error("не удалось определить текущий git SHA");
        this.#state.previousGitSha = sha;
        this.#persist();
        return sha.slice(0, 7);
      });
      await this.#step("git pull", async () => {
        if (!(await this.#remoteConfigured())) {
          return "git remote не настроен — пропуск (обновление ограничено пересборкой локального состояния)";
        }
        // Explicit refspec: works whether or not the local branch has upstream tracking.
        const branchRes = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"]);
        const branch = branchRes.stdout.trim();
        const pullArgs = branch === "" || branch === "HEAD" ? ["pull", "--ff-only"] : ["pull", "--ff-only", "origin", branch];
        const r = await this.#git(pullArgs);
        const out = truncate(`$ git ${pullArgs.join(" ")}\n${r.stdout}${r.stderr}`.trim());
        if (r.code !== 0) throw new Error(out === "" ? `git pull завершился с кодом ${r.code}` : out);
        return out === "" ? "уже актуален" : out;
      });
      await this.#gitRebuildAndRestart(id);
    });
  }

  async #rollbackGit(id: ComponentId): Promise<void> {
    await this.#runJob(async () => {
      const target = this.#state.previousGitSha;
      if (target === null) throw new Error("нет сохранённого предыдущего состояния git");
      await this.#step("Резервная копия конфигов", async () => (await this.backup()).dir);
      await this.#step(`git reset --hard ${target.slice(0, 7)}`, async () => {
        const r = await this.#git(["reset", "--hard", target]);
        const out = truncate(`$ git reset --hard ${target.slice(0, 7)}\n${r.stdout}${r.stderr}`.trim());
        if (r.code !== 0) throw new Error(out === "" ? `git reset завершился с кодом ${r.code}` : out);
        return out;
      });
      await this.#gitRebuildAndRestart(id);
    });
  }

  async #gitRebuildAndRestart(id: ComponentId): Promise<void> {
    for (const dir of ["gateway", "app"] as const) {
      await this.#step(`bun install (${dir})`, async () => {
        const r = await run([this.#paths.bunBin, "install"], { cwd: join(this.#paths.repoDir, dir), timeoutMs: BUN_TIMEOUT_MS });
        const out = truncate(`$ bun install (${dir})\n${r.stdout}${r.stderr}`.trim());
        if (r.code !== 0) throw new Error(out === "" ? `bun install (${dir}) завершился с кодом ${r.code}` : out);
        return out;
      });
    }
    await this.#step("Сборка фронтенда", async () => {
      const r = await run([this.#paths.bunBin, "run", "build"], { cwd: join(this.#paths.repoDir, "app"), timeoutMs: BUN_TIMEOUT_MS });
      const out = truncate(`$ bun run build\n${r.stdout}${r.stderr}`.trim());
      if (r.code !== 0) throw new Error(out === "" ? `bun run build завершился с кодом ${r.code}` : out);
      return out;
    });
    await this.#step("Перезапуск gateway", async () => {
      // Marked before the restart: if the process dies here, the next one resumes the job.
      this.#state.job.resumeAfterRestart = id;
      this.#persist();
      const r = await run([this.#paths.systemctlBin, "--user", "restart", this.#paths.systemdUnit], { timeoutMs: 60_000 });
      if (r.code !== 0) {
        this.#state.job.resumeAfterRestart = null;
        this.#persist();
        const out = truncate(`$ systemctl --user restart ${this.#paths.systemdUnit}\n${r.stdout}${r.stderr}`.trim());
        throw new Error(out === "" ? `systemctl завершился с кодом ${r.code}` : out);
      }
      return `systemctl --user restart ${this.#paths.systemdUnit}`;
    });
    await this.#step("Проверка gateway после рестарта", () => this.#verifyGatewayStep());
  }
}
