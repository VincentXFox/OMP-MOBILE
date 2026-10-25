import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { writeFileDurable } from "./atomic.ts";
import { dirname, join } from "node:path";
import { exec } from "./exec.ts";
import { newJob, readJobFile, saveJob, COMPONENT_IDS, type ComponentId, type JobState } from "./jobState.ts";
import { readJournal, UpdateJournal, type UpdateEvent } from "./journal.ts";
import { acquireLock, isStale, LockBusyError } from "./lock.ts";
import { activeMarkerPath, defaultPaths, jobArtifactsDir, jobJournalPath, jobStatePath, lockPath, type UpdatePaths } from "./paths.ts";
import { binaryVersion, buildTarget } from "./release.ts";
import { fileInode, pidExe, probeGatewayHealth, probeRuntime, probeTcp, type GatewayHealth } from "./probes.ts";
import { compatibilityCheck } from "./preflight.ts";
import { readCodeState } from "./gitState.ts";
import { listHosts } from "../hosts.ts";

export const COMPONENT_TITLES: Record<ComponentId, string> = {
  omp: "OMP (CLI-агент)",
  gateway: "Gateway (Bun)",
  frontend: "Фронтенд (PWA)",
  relay: "Локальный релей (WS)",
  runtime: "Рантайм (терминалы)",
};

export interface ComponentView {
  id: ComponentId;
  title: string;
  /** Что реально работает сейчас (процессы), а не что лежит на диске. */
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  installMethod: string;
  compatibility: { status: "ok" | "warn" | "unknown"; detail: string };
  notes: string[];
}

export interface UpdateStatusView {
  components: ComponentView[];
  job: JobState | null;
  active: boolean;
  remoteConfigured: boolean;
}

export type ApplyOutcome =
  | { kind: "accepted"; jobId: string }
  | { kind: "job_running"; jobId: string | null }
  | { kind: "busy"; agents: Array<{ sessionName: string | null; cwd: string }> }
  | { kind: "failed"; error: string };

export type RollbackOutcome = { kind: "accepted"; jobId: string } | { kind: "job_running" } | { kind: "no_previous" } | { kind: "failed"; error: string };

function readGatewayConfig(paths: UpdatePaths): { base: string; token: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(paths.gatewayConfigPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const v = parsed as Record<string, unknown>;
      const port = typeof v["port"] === "number" ? v["port"] : 8088;
      const host = typeof v["host"] === "string" && v["host"] !== "0.0.0.0" ? v["host"] : "127.0.0.1";
      return { base: `http://${host}:${port}`, token: typeof v["token"] === "string" && v["token"] !== "" ? v["token"] : null };
    }
  } catch {
    // ниже — дефолт; честность проверок важнее удобства
  }
  return { base: "http://127.0.0.1:8088", token: null };
}

async function git(paths: UpdatePaths, args: string[], timeoutMs: number): Promise<string | null> {
  const res = await exec([paths.gitBin, ...args], { cwd: paths.repoDir, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
  return res.code === 0 ? res.stdout.trim() : null;
}

export class UpdateService {
  #paths: UpdatePaths;
  #startedAt = Date.now();

  constructor(paths: UpdatePaths = defaultPaths()) {
    this.#paths = paths;
  }

  get paths(): UpdatePaths {
    return this.#paths;
  }

  /** Последняя задача: файл один на всё состояние — UI видит одну активную,
   * а история событий лежит в journal рядом. */
  currentJob(): JobState | null {
    const jobs = this.listJobs();
    return jobs[0] ?? null;
  }

  listJobs(): JobState[] {
    const dir = join(this.#paths.stateDir, "jobs");
    if (!existsSync(dir)) return [];
    const found: JobState[] = [];
    for (const name of Array.from(new Bun.Glob("*.json").scanSync({ cwd: dir }))) {
      const job = readJobFile(join(dir, name));
      if (job !== null) found.push(job);
    }
    return found.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Активная задача — только если её процесс жив: иначе апдейты блокировались бы навсегда (D1). */
  activeJob(): JobState | null {
    const running = this.listJobs().find((job) => job.phase !== "COMPLETED" && job.phase !== "FAILED" && job.phase !== "ROLLED_BACK" && job.phase !== "BLOCKED");
    if (running === undefined) return null;
    const owner = running.owner;
    if (owner.pid <= 0) return null;
    if (isStale({ pid: owner.pid, bootId: owner.bootId, jobId: running.jobId, at: owner.startedAt })) {
      // Процесс задачи мёртв: закрываем её, чтобы UI и API не залипали в «идёт обновление».
      const journal = new UpdateJournal(jobJournalPath(this.#paths, running.jobId), running.jobId);
      running.phase = "FAILED";
      running.error = { message: "процесс задачи завершился (или перезагружен хост) — задача закрыта как прерванная", phase: running.phase };
      running.finishedAt = new Date().toISOString();
      saveJob(jobStatePath(this.#paths, running.jobId), running);
      journal.append("FAILED", "orphan", running.error.message, { ownerPid: owner.pid });
      return null;
    }
    return running;
  }

  jobEvents(jobId: string, since = 0): UpdateEvent[] {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(jobId)) return []; // путь из запроса не должен выходить из каталога задач (D9)
    return readJournal(jobJournalPath(this.#paths, jobId), since, 1000);
  }

  async status(): Promise<UpdateStatusView> {
    const { base, token } = readGatewayConfig(this.#paths);
    const [ompVersion, head, health, relayTcp, runtimeProbe, hosts] = await Promise.all([
      binaryVersion(this.#paths.ompBin).catch(() => null),
      git(this.#paths, ["rev-parse", "HEAD"], 10_000),
      probeGatewayHealth(base, token).catch(() => null),
      probeTcp("127.0.0.1", 7466, 1_500),
      probeRuntime().catch(() => ({ ok: false, detail: "недоступен" })),
      listHosts(this.#paths.ompBin).catch(() => ({ hosts: [] })),
    ]);
    const binInode = fileInode(this.#paths.ompBin);
    const liveHosts = hosts.hosts.filter((host) => host.alive);
    const stale = liveHosts.filter((host) => {
      const exe = pidExe(host.pid);
      return exe.deleted || (exe.inode !== 0 && exe.inode !== binInode);
    });
    const code = await readCodeState(this.#paths);
    const remote = code.remote;
    // Удалённая ветка позади локальной — обновлять нечего (иначе кнопка предлагает «откат» к старому коммиту).
    const remoteHasNew = code.behind === null ? remote !== null : code.behind > 0;

    const ompLatest = await this.#latestOmpVersion();
    const compatCheck = compatibilityCheck(this.#paths, ompLatest ?? ompVersion);
    const compat = { status: compatCheck.ok ? ("ok" as const) : ("warn" as const), detail: compatCheck.detail };
    const ompNotes: string[] = [];
    if (stale.length > 0) ompNotes.push(`устаревших процессов: ${stale.length} из ${liveHosts.length} — новый бинарь установлен, но панели работают на старом образе`);
    if (ompLatest === null) ompNotes.push("build-сервис недоступен — проверка обновлений OMP ограничена");
    const codeNotes: string[] = [];
    if (remote === null) codeNotes.push("git remote недоступен — обновление кода невозможно");
    if (health === null) codeNotes.push("шлюз не отвечает на /api/health");
    if (head !== null && health?.buildSha !== null && health?.buildSha !== undefined && health.buildSha !== head) {
      codeNotes.push(`работает pid ${health.pid} со сборкой ${health.buildSha.slice(0, 7)}, в репозитории ${head.slice(0, 7)} — нужен перезапуск`);
    }

    const components: ComponentView[] = [
      {
        id: "omp",
        title: COMPONENT_TITLES.omp,
        current: ompVersion === null ? "неизвестно" : `${ompVersion} (сессий: ${liveHosts.length}, устаревших: ${stale.length})`,
        latest: ompLatest,
        updateAvailable: ompLatest !== null && (ompLatest !== ompVersion || stale.length > 0),
        installMethod: "build-сервис omp: скачивание с проверкой размера и SHA-256, атомарная замена",
        compatibility: compat,
        notes: ompNotes,
      },
      {
        id: "gateway",
        title: COMPONENT_TITLES.gateway,
        current: health === null ? "не отвечает" : `${health.buildSha?.slice(0, 7) ?? "?"} (pid ${health.pid})`,
        latest: (remoteHasNew ? remote : head)?.slice(0, 7) ?? null,
        updateAvailable: (remoteHasNew && remote !== head) || (health?.buildSha !== head && !remoteHasNew),
        installMethod: "git pull --ff-only + bun install + systemd restart",
        compatibility: compat,
        notes: codeNotes,
      },
      {
        id: "frontend",
        title: COMPONENT_TITLES.frontend,
        current: head === null ? "неизвестно" : `${head.slice(0, 7)} (dist)`,
        latest: (remoteHasNew ? remote : head)?.slice(0, 7) ?? null,
        updateAvailable: remoteHasNew && remote !== head,
        installMethod: "bun run build → раздаётся шлюзом",
        compatibility: compat,
        notes: codeNotes,
      },
      {
        id: "relay",
        title: COMPONENT_TITLES.relay,
        current: relayTcp ? "слушает 7466" : "не отвечает",
        latest: null,
        updateAvailable: false,
        installMethod: "systemctl --user restart omp-local-relay",
        compatibility: { status: "ok", detail: "версий нет: проверяется порт и состояние юнита" },
        notes: relayTcp ? [] : ["локальный WS-релей не отвечает — перезапуск восстановит LAN-путь"],
      },
      {
        id: "runtime",
        title: COMPONENT_TITLES.runtime,
        current: runtimeProbe.ok ? "отвечает" : "не отвечает",
        latest: null,
        updateAvailable: false,
        installMethod: "systemctl --user restart omp-pocket-runtime",
        compatibility: { status: runtimeProbe.ok ? "ok" : "warn", detail: runtimeProbe.detail },
        notes: runtimeProbe.ok ? [] : ["рантайм не отвечает — панели и агенты недоступны", `сокет: ${this.#paths.runtimeSocket}`],
      },
    ];
    return {
      components,
      job: this.currentJob(),
      active: this.activeJob() !== null,
      remoteConfigured: remote !== null,
    };
  }

  async #latestOmpVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${this.#paths.buildOrigin.replace(/\/+$/, "")}/api/products/omp/latest/${buildTarget()}?channel=stable`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const parsed = (await res.json()) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const build = (parsed as Record<string, unknown>)["build"];
      if (typeof build !== "object" || build === null) return null;
      const version = (build as Record<string, unknown>)["version"];
      return typeof version === "string" ? version : null;
    } catch {
      return null;
    }
  }

  /** Запуск задачи: файл состояния создаётся сразу (UI видит её мгновенно),
   * сам оркестратор уходит в отдельный systemd-юнит и переживает рестарт шлюза. */
  async apply(component: ComponentId, confirmBusy: boolean): Promise<ApplyOutcome> {
    const running = this.activeJob();
    if (running !== null) return { kind: "job_running", jobId: running.jobId };
    try {
      const holder = acquireLock(lockPath(this.#paths), `probe-${Date.now()}`);
      holder.release();
    } catch (err) {
      if (err instanceof LockBusyError) return { kind: "job_running", jobId: null };
      throw err;
    }
    if (!confirmBusy) {
      const hosts = await listHosts(this.#paths.ompBin).catch(() => ({ hosts: [] }));
      const busy = hosts.hosts.filter((host) => host.alive && (host.busy || host.inputRequired));
      if (busy.length > 0) {
        return { kind: "busy", agents: busy.map((host) => ({ sessionName: host.sessionName, cwd: host.cwd })) };
      }
    }
    const jobId = `${component}-${Date.now()}`;
    // Файл задачи создаём ПОСЛЕ успешного спавна: иначе упавший спавн оставлял бы
    // вечно «активную» задачу в фазе IDLE (D2).
    const launch = await this.#spawnOrchestrator(component, jobId, "apply");
    if (launch.kind === "failed") return { kind: "failed", error: launch.error };
    saveJob(jobStatePath(this.#paths, jobId), newJob(component, jobId));
    return { kind: "accepted", jobId };
  }

  async rollback(component: ComponentId): Promise<RollbackOutcome> {
    if (this.activeJob() !== null) return { kind: "job_running" };
    const last = this.listJobs().find((job) => job.component === component && job.rollback?.available === true);
    if (last === undefined) return { kind: "no_previous" };
    const jobId = `${component}-rollback-${Date.now()}`;
    const job = newJob(component, jobId);
    job.rollback = last.rollback;
    job.versions = { from: last.versions.to, to: last.versions.from };
    job.checkpointFile = last.checkpointFile;
    job.previousArtifacts = jobArtifactsDir(this.#paths, last.jobId);
    const launch = await this.#spawnOrchestrator(component, jobId, "rollback");
    if (launch.kind === "failed") return { kind: "failed", error: launch.error };
    saveJob(jobStatePath(this.#paths, jobId), job);
    return { kind: "accepted", jobId };
  }

  /** Оркестратор — отдельный юнит systemd: `systemctl --user restart` шлюза его не
   * убивает, а его журнал остаётся в journald и в файле задачи. */
  async #spawnOrchestrator(component: ComponentId, jobId: string, mode: "apply" | "rollback"): Promise<{ kind: "spawned" } | { kind: "failed"; error: string }> {
    const artifacts = jobArtifactsDir(this.#paths, jobId);
    const script = join(dirname(new URL(import.meta.url).pathname), "orchestrator.ts");
    const unitName = `omp-update-${jobId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    const args = [this.#paths.bunBin, script, "--component", component, "--job", jobId];
    if (mode === "rollback") args.push("--rollback");
    const systemdRun = this.#paths.systemdRun;
    if (existsSync(systemdRun)) {
      const res = await exec(
        [
          systemdRun,
          "--user",
          "--collect",
          `--unit=${unitName}`,
          `--property=Description=OMP Pocket update ${jobId}`,
          "--property=WorkingDirectory=" + this.#paths.repoDir,
          ...args,
        ],
        { timeoutMs: 20_000 },
      );
      if (res.code === 0) return { kind: "spawned" };
      return { kind: "failed", error: `systemd-run: ${res.stderr.trim() || `код ${res.code}`}` };
    }
    // systemd-run нет (нештатная система): запускаем отдельным процессом с логом в артефактах.
    const logPath = join(artifacts, "orchestrator.log");
    const logFd = openSync(logPath, "a", 0o600);
    const proc = Bun.spawn([...args], {
      cwd: this.#paths.repoDir,
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, OMP_UPDATE_STATE_DIR: this.#paths.stateDir },
    });
    proc.unref();
    closeSync(logFd);
    return { kind: "spawned" };
  }

  /** Готов ли идти апдейт прямо сейчас (watchdog и UI спрашивают одно и то же). */
  activeMarker(): { jobId: string; component: string; phase: string; pid: number; at: string } | null {
    try {
      const parsed = JSON.parse(readFileSync(activeMarkerPath(this.#paths), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const v = parsed as Record<string, unknown>;
      if (typeof v["jobId"] !== "string" || typeof v["phase"] !== "string") return null;
      return {
        jobId: v["jobId"],
        component: typeof v["component"] === "string" ? v["component"] : "?",
        phase: v["phase"],
        pid: typeof v["pid"] === "number" ? v["pid"] : 0,
        at: typeof v["at"] === "string" ? v["at"] : "",
      };
    } catch {
      return null;
    }
  }

  gatewayHealth(): Promise<GatewayHealth | null> {
    const { base, token } = readGatewayConfig(this.#paths);
    return probeGatewayHealth(base, token);
  }

  uptimeMs(): number {
    return Date.now() - this.#startedAt;
  }

  /** Уведомление «доступно обновление»: одно на пару (текущее → доступное),
   * чтобы шестичасовой таймер не спамил телефон. */
  async checkAndNotify(push: { broadcast: (payload: { title: string; body: string; url: string }) => Promise<unknown> }): Promise<void> {
    const view = await this.status();
    const available = view.components.filter((component) => component.updateAvailable);
    if (available.length === 0) return;
    const marker = join(this.#paths.stateDir, "notify.json");
    const pair = available.map((component) => `${component.id}:${component.current}->${component.latest ?? "?"}`).join("|");
    try {
      const previous = JSON.parse(readFileSync(marker, "utf8")) as unknown;
      if (typeof previous === "object" && previous !== null && (previous as Record<string, unknown>)["pair"] === pair) return;
    } catch {
      // маркера ещё нет
    }
    await push.broadcast({ title: "Доступно обновление OMP Pocket", body: available.map((c) => `${c.title}: ${c.current} → ${c.latest ?? "рестарт"}`).join("\n"), url: "/#/updates" });
    writeFileDurable(marker, `${JSON.stringify({ pair, at: Date.now() })}\n`);
  }
}

export function isComponentIdLocal(value: unknown): value is ComponentId {
  return typeof value === "string" && COMPONENT_IDS.some((id) => id === value);
}
