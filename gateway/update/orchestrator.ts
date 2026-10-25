#!/usr/bin/env bun
/**
 * Автономный Update Orchestrator OMP Pocket.
 *
 * Запускается отдельным процессом (systemd-run --user) и НЕ живёт внутри шлюза:
 * поэтому рестарт шлюза, рантайма или панелей не убивает сам апдейт. Состояние и
 * журнал — на диске, каждый шаг идемпотентен: после падения процесс продолжает
 * с записанной фазы, а «успех» выставляется только после проверки фактически
 * работающих версий и восстановленных сессий.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileDurable } from "./atomic.ts";
import { exec, describeExec } from "./exec.ts";
import {
  advance,
  assertTransition,
  closeStep,
  isComponentId,
  isTerminal,
  newJob,
  openStep,
  readBootId,
  readJobFile,
  saveJob,
  type ComponentId,
  type JobResult,
  type JobState,
  type LegacySessionRef,
  type Phase,
} from "./jobState.ts";
import { UpdateJournal } from "./journal.ts";
import { acquireLock, LockBusyError } from "./lock.ts";
import { activeMarkerPath, defaultPaths, jobArtifactsDir, jobJournalPath, jobStatePath, jobsDir, lockPath, type UpdatePaths } from "./paths.ts";
import {
  compatibilityCheck,
  dependencyChecks,
  freeSpaceCheck,
  gitRemoteCheck,
  releaseSourceCheck,
  summarize,
  type CheckResult,
} from "./preflight.ts";
import {
  binaryVersion,
  buildTarget,
  downloadVerified,
  fetchOmpBuild,
  installBinary,
  restoreBinary,
  safeVersion,
  type OmpBuild,
} from "./release.ts";
import { fileInode, pidExe, probeGatewayHealth, probeServedIndex, probeTcp, waitRuntimeReady, type GatewayHealth } from "./probes.ts";
import { readCodeState } from "./gitState.ts";
import { buildCheckpoint } from "../recovery/checkpoint.ts";
import { bindPane, closePane, createPane, getPane, paneProcesses, runInPane } from "../panes.ts";
import { listHosts, type OmpHost } from "../hosts.ts";
import { runtimeSessionControl } from "../recovery/runtimeControl.ts";
import { awaitRegistration, continueSession, restartSession, type SessionControl } from "../recovery/resume.ts";
import { appendRecoveryEvent, readCheckpoint, writeCheckpoint, writeRecoveryState, type Checkpoint, type LogicalSession } from "../recovery/model.ts";

const PIPELINE: readonly Phase[] = ["CHECKING", "PREPARING", "CHECKPOINTING", "INSTALLING", "RESTARTING", "VERIFYING", "RESTORING", "RESUMING"];

interface Args {
  component: ComponentId;
  jobId: string;
  version: string | null;
  channel: "stable" | "canary";
  allowDirtyWorktree: boolean;
  rollback: boolean;
  /** --force: применить к живым панелям даже если версия уже целевая
   * (переустановка того же бинаря / повторное применение после сбоя). */
  force: boolean;
  /** Ограничить задачу сессиями, у которых cwd/sessionId содержит подстроку. */
  only: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? null) : null;
  };
  const component = get("--component");
  const jobId = get("--job");
  if (!isComponentId(component) || jobId === null || jobId === "") {
    throw new Error("usage: orchestrator.ts --component <omp|gateway|frontend|relay|runtime> --job <id> [--version <v>] [--channel stable|canary] [--allow-dirty]");
  }
  const channel = get("--channel") === "canary" ? "canary" : "stable";
  return { component, jobId, version: get("--version"), channel, allowDirtyWorktree: argv.includes("--allow-dirty"), rollback: argv.includes("--rollback"), force: argv.includes("--force"), only: get("--only") };
}

interface Ctx {
  paths: UpdatePaths;
  job: JobState;
  journal: UpdateJournal;
  statePath: string;
  artifacts: string;
  checkpoint: Checkpoint | null;
  /** pid шлюза до рестарта: нужен, чтобы доказать, что ответил новый процесс. */
  gatewayPidBefore: number | null;
}

/** Инъекция сбоя для chaos-набора: OMP_UPDATE_FAULT=after-<phase> убивает процесс
 * ровно в этой точке, чтобы проверить восстановление с durable-состояния. */
function maybeFault(point: string): void {
  if (process.env["OMP_UPDATE_FAULT"] === point) {
    process.stderr.write(`[fault] ${point}\n`);
    process.exit(137);
  }
}

function phaseRank(phase: Phase): number {
  const idx = PIPELINE.indexOf(phase);
  return idx < 0 ? -1 : idx;
}

function needs(ctx: Ctx, phase: Phase): boolean {
  const current = phaseRank(ctx.job.phase);
  const target = phaseRank(phase);
  return current < target;
}

function enter(ctx: Ctx, phase: Phase, note?: string): void {
  if (ctx.job.phase === phase) return;
  advance(ctx.job, phase);
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append(phase, "phase", note ?? phase, { attempt: ctx.job.attempt });
}

function stepOk(ctx: Ctx, id: string, label: string, detail: string): void {
  const step = openStep(ctx.job, id, label);
  closeStep(step, "ok", detail);
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append(ctx.job.phase, "step", label, { id, status: "ok", detail });
}

function stepSkip(ctx: Ctx, id: string, label: string, detail: string): void {
  const step = openStep(ctx.job, id, label);
  closeStep(step, "skipped", detail);
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append(ctx.job.phase, "step", label, { id, status: "skipped", detail });
}

async function withStep<T>(ctx: Ctx, id: string, label: string, work: () => Promise<T>): Promise<T> {
  const step = openStep(ctx.job, id, label);
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append(ctx.job.phase, "step.start", label, { id });
  try {
    const detail = await work();
    closeStep(step, "ok", typeof detail === "string" ? detail : "");
    saveJob(ctx.statePath, ctx.job);
    ctx.journal.append(ctx.job.phase, "step", label, { id, status: "ok", detail: step.detail ?? "" });
    return detail;
  } catch (err) {
    closeStep(step, "fail", err instanceof Error ? err.message : String(err));
    saveJob(ctx.statePath, ctx.job);
    ctx.journal.append(ctx.job.phase, "step", label, { id, status: "fail", detail: step.detail ?? "" });
    throw err;
  }
}

function gatewayBase(paths: UpdatePaths): { base: string; token: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(paths.gatewayConfigPath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const v = parsed as Record<string, unknown>;
      const port = typeof v["port"] === "number" ? v["port"] : 8088;
      const host = typeof v["host"] === "string" && v["host"] !== "0.0.0.0" ? v["host"] : "127.0.0.1";
      const token = typeof v["token"] === "string" && v["token"] !== "" ? v["token"] : null;
      return { base: `http://${host}:${port}`, token };
    }
  } catch {
    // конфиг недоступен — проверка будет честно провалена, а не «пропущена»
  }
  return { base: "http://127.0.0.1:8088", token: null };
}

async function waitGateway(base: string, token: string | null, timeoutMs: number, predicate: (health: GatewayHealth) => boolean): Promise<GatewayHealth | null> {
  const deadline = Date.now() + timeoutMs;
  let last: GatewayHealth | null = null;
  while (Date.now() < deadline) {
    last = await probeGatewayHealth(base, token);
    if (last !== null && predicate(last)) return last;
    await Bun.sleep(1_000);
  }
  return last;
}

async function headSha(paths: UpdatePaths): Promise<string | null> {
  const res = await exec([paths.gitBin, "rev-parse", "HEAD"], { cwd: paths.repoDir, timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.trim() || null : null;
}

async function worktreeDirty(paths: UpdatePaths): Promise<string[]> {
  const res = await exec([paths.gitBin, "status", "--porcelain"], { cwd: paths.repoDir, timeoutMs: 15_000 });
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function gitStashObject(paths: UpdatePaths): Promise<string | null> {
  const res = await exec([paths.gitBin, "stash", "create"], { cwd: paths.repoDir, timeoutMs: 30_000 });
  const sha = res.stdout.trim();
  return res.code === 0 && sha !== "" ? sha : null;
}

function distArtifactCheck(distDir: string): string {
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`нет ${indexPath}: сборка не создала точку входа`);
  const html = readFileSync(indexPath, "utf8");
  if (html.length < 200) throw new Error(`${indexPath} подозрительно мал (${html.length} Б)`);
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]).filter((name): name is string => typeof name === "string");
  if (assets.length === 0) throw new Error(`${indexPath} не ссылается ни на один собранный ассет`);
  const missing = assets.filter((name) => !existsSync(join(distDir, name)));
  if (missing.length > 0) throw new Error(`в сборке нет ассетов: ${missing.slice(0, 5).join(", ")}`);
  const js = assets.filter((name) => name.endsWith(".js"));
  if (js.length === 0) throw new Error("в сборке нет JS-бандла");
  return `index.html ${html.length} Б, ассетов ${assets.length} (js ${js.length})`;
}

/** Процесс агента в панели: оболочку панели не считаем. Порядок записей из /proc
 * произвольный, поэтому опираемся на имя бинаря, а не на позицию в списке. */
function agentProcess(procs: readonly { pid: number; name: string; argv: string[] }[], shellPid: number): { pid: number } | null {
  const children = procs.filter((proc) => proc.pid !== shellPid);
  return children.find((proc) => proc.name === "omp" || (proc.argv[0] ?? "").endsWith("/omp")) ?? children[0] ?? null;
}

/** После регистрации проверяем, что сессия действительно работает на установленном
 * бинаре (а не на пережившем перезапуск старом образе). */
async function sessionRunsNewBinary(session: LogicalSession, ompPath: string): Promise<string | null> {
  if (session.paneId === null) return null;
  const pane = await getPane(session.paneId);
  if (pane === null) return "панель сессии исчезла после восстановления";
  const agent = agentProcess(await paneProcesses(session.paneId).catch(() => []), pane.shellPid);
  if (agent === null) return "процесс в панели не найден после восстановления";
  const exe = pidExe(agent.pid);
  const inode = fileInode(ompPath);
  if (exe.deleted || (exe.inode !== 0 && exe.inode !== inode)) return `сессия работает на старом образе (${exe.path}${exe.deleted ? " (deleted)" : ""})`;
  return null;
}

async function liveHosts(ompPath: string): Promise<OmpHost[]> {
  try {
    return (await listHosts(ompPath)).hosts.filter((host) => host.alive);
  } catch {
    return [];
  }
}

/** Сессия вне панелей рантайма: панели у демона нет, но collab-хост ещё жив
 * (агент работает в прежней панели). Это не провал обновления: перезапускать
 * сессию нечем, поэтому она остаётся на прежнем образе, а перенос делает
 * владелец отдельной командой. */
function isLegacySession(session: LogicalSession, control: SessionControl): boolean {
  if (session.paneId !== null) return false;
  return session.pid !== null && control.isAlive(session.pid);
}

function legacyRef(session: LogicalSession): LegacySessionRef {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    pid: session.pid,
    sessionFile: session.files[session.files.length - 1] ?? null,
  };
}

const LEGACY_HINT = "перенесите их командой bin/migrate-to-runtime.ts";

/** Строка отчёта: попадает и в steps, и в verifiedVersions, поэтому её видно
 * и в API, и в интерфейсе задачи. */
function legacyReport(refs: readonly LegacySessionRef[]): string {
  const n = refs.length;
  const tail10 = n % 10;
  const tail100 = n % 100;
  const word = tail10 === 1 && tail100 !== 11 ? "сессия" : tail10 >= 2 && tail10 <= 4 && (tail100 < 12 || tail100 > 14) ? "сессии" : "сессий";
  return `${n} ${word} вне панелей рантайма ${n === 1 ? "осталась" : "остались"} на прежней версии — ${LEGACY_HINT}`;
}

/** Единственная точка записи результата: поля, которых нет в патче (в первую
 * очередь `legacy`), не теряются между фазами и попытками. */
function setResult(ctx: Ctx, patch: Partial<JobResult>): void {
  const before: JobResult = ctx.job.result ?? { verifiedVersions: {}, restored: 0, resumed: 0, blocked: [], legacy: [] };
  ctx.job.result = {
    verifiedVersions: patch.verifiedVersions ?? before.verifiedVersions,
    restored: patch.restored ?? before.restored,
    resumed: patch.resumed ?? before.resumed,
    blocked: patch.blocked ?? before.blocked,
    legacy: patch.legacy ?? before.legacy,
  };
  saveJob(ctx.statePath, ctx.job);
}

async function unitState(paths: UpdatePaths, unit: string): Promise<{ active: string; pid: number }> {
  // Разбор key=value, а не позиционный: systemctl не гарантирует порядок строк.
  const res = await exec([paths.systemctlBin, "--user", "show", unit, "-p", "ActiveState", "-p", "MainPID"], { timeoutMs: 10_000 });
  if (res.code !== 0) return { active: "unknown", pid: 0 };
  let active = "unknown";
  let pid = 0;
  for (const line of res.stdout.split("\n")) {
    const [key, ...rest] = line.trim().split("=");
    const value = rest.join("=");
    if (key === "ActiveState" && value !== "") active = value;
    if (key === "MainPID" && /^\d+$/.test(value)) pid = Number(value);
  }
  return { active, pid };
}

async function restartUnit(paths: UpdatePaths, unit: string): Promise<string> {
  const res = await exec([paths.systemctlBin, "--user", "restart", unit], { timeoutMs: 90_000 });
  if (res.code !== 0) throw new Error(describeExec([paths.systemctlBin, "--user", "restart", unit], res));
  return `systemctl --user restart ${unit}`;
}

// ————— фазы —————

async function ensureChecking(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "CHECKING");
  const { paths } = ctx;
  if (args.component === "omp") {
    const [current, release] = await Promise.all([
      withStep(ctx, "check.current", "Текущая версия OMP", async () => {
        const version = await binaryVersion(paths.ompBin);
        if (version === null) throw new Error(`${paths.ompBin} --version не отвечает`);
        return version;
      }),
      withStep(ctx, "check.release", "Источник релиза", async () => {
        const check = await releaseSourceCheck(paths, args.version);
        ctx.journal.append("CHECKING", "check", check.check.label, { ok: check.check.ok, detail: check.check.detail });
        if (!check.check.ok) throw new Error(check.check.detail);
        return check;
      }),
    ]);
    const target = release.version;
    ctx.job.versions = { from: current, to: target };
    saveJob(ctx.statePath, ctx.job);
    const compat = compatibilityCheck(paths, target);
    ctx.journal.append("CHECKING", "compat", compat.label, { ok: compat.ok, detail: compat.detail });
    const hosts = (await liveHosts(paths.ompBin)).filter((host) => args.only === null || host.cwd.includes(args.only) || host.sessionId.includes(args.only));
    const binInode = fileInode(paths.ompBin);
    const stale = hosts.filter((host) => {
      const exe = pidExe(host.pid);
      return exe.deleted || (exe.inode !== 0 && exe.inode !== binInode);
    });
    ctx.journal.append("CHECKING", "running", "Проверка работающих процессов", { ok: true, detail: `живых сессий: ${hosts.length}, на устаревшем образе: ${stale.length}` });
    if (current === target && stale.length === 0 && !args.force) {
      stepOk(ctx, "check.noop", "Обновление не требуется", `omp ${current} уже работает во всех процессах`);
      setResult(ctx, { verifiedVersions: { omp: current }, restored: 0, resumed: 0, blocked: [], legacy: [] });
      advance(ctx.job, "PREPARING");
      advance(ctx.job, "CHECKPOINTING");
      advance(ctx.job, "INSTALLING");
      advance(ctx.job, "RESTARTING");
      advance(ctx.job, "VERIFYING");
      advance(ctx.job, "COMPLETED");
      saveJob(ctx.statePath, ctx.job);
      return;
    }
    if (compat.ok === false) {
      ctx.journal.append("CHECKING", "compat.warn", "Протокол может отличаться", { detail: compat.detail });
    }
    stepOk(ctx, "check.target", "Целевая версия", `${current} → ${target}${stale.length > 0 ? `, устаревших процессов: ${stale.length}` : ""}`);
    return;
  }

  if (args.component === "gateway" || args.component === "frontend") {
    const code = await readCodeState(paths);
    const head = code.head;
    const remote = code.behind !== null && code.behind > 0 ? code.remote : null;
    if (head === null) throw new Error("не удалось прочитать git HEAD");
    ctx.job.versions = { from: head, to: remote ?? head };
    saveJob(ctx.statePath, ctx.job);
    const check = await gitRemoteCheck(paths);
    ctx.journal.append("CHECKING", "git", check.label, { ok: check.ok, detail: check.detail });
    const { base, token } = gatewayBase(paths);
    const health = await probeGatewayHealth(base, token);
    ctx.gatewayPidBefore = health?.pid ?? null;
    const dirty = await worktreeDirty(paths);
    if (dirty.length > 0 && !args.allowDirtyWorktree) {
      ctx.journal.append("CHECKING", "dirty", "Рабочее дерево изменено", { count: dirty.length, sample: dirty.slice(0, 5) });
    }
    stepOk(ctx, "check.git", "Состояние кода", `HEAD ${head.slice(0, 7)} → ${(ctx.job.versions.to ?? head).slice(0, 7)}; локальных изменений: ${dirty.length}`);
    const unit = await unitState(paths, paths.gatewayUnit);
    const servedOk = (await probeServedIndex(base, join(paths.appDistDir, "index.html"), token)).matches;
    if (remote === null && health !== null && health.buildSha === head && unit.pid === health.pid && servedOk) {
      stepOk(ctx, "check.noop", "Обновление не требуется", `gateway уже работает на ${head.slice(0, 7)} (pid ${health.pid}, юнит ${paths.gatewayUnit}), отдаваемый фронтенд совпадает с dist`);
      setResult(ctx, { verifiedVersions: { gateway: head.slice(0, 7), frontend: head.slice(0, 7) }, restored: 0, resumed: 0, blocked: [], legacy: [] });
      for (const phase of ["PREPARING", "CHECKPOINTING", "INSTALLING", "RESTARTING", "VERIFYING"] as const) advance(ctx.job, phase);
      advance(ctx.job, "COMPLETED");
      saveJob(ctx.statePath, ctx.job);
      return;
    }
    return;
  }

  // relay / runtime: источников версий нет — задача сводится к контролируемому рестарту и проверке.
  stepOk(ctx, "check.restart-only", "Компонент без автоустановки", `${args.component}: только рестарт и проверка работоспособности`);
}

async function ensurePreparing(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "PREPARING");
  const { paths } = ctx;
  const checks: CheckResult[] = [freeSpaceCheck(paths), ...dependencyChecks(paths)];
  if (args.component === "gateway" || args.component === "frontend") checks.push(await gitRemoteCheck(paths));
  const summary = summarize(checks);
  for (const check of checks) ctx.journal.append("PREPARING", "check", check.label, { ok: check.ok, detail: check.detail });
  if (!summary.ok) throw new Error(`preflight: ${summary.failed.map((c) => `${c.label} — ${c.detail}`).join("; ")}`);

  if (args.component === "gateway" || args.component === "frontend") {
    const dirty = await worktreeDirty(paths);
    if (dirty.length > 0) {
      const stash = await gitStashObject(paths);
      const message = `рабочее дерево изменено (${dirty.length} файлов)${stash === null ? "" : `; снимок сохранён как stash-объект ${stash}`}; обновление кода остановлено, чтобы не потерять правки (git reset отката их уничтожит)`;
      writeFileDurable(join(ctx.artifacts, "dirty-worktree.txt"), `${dirty.join("\n")}\n\nstash: ${stash ?? "не создан"}\n`);
      ctx.journal.append("PREPARING", "blocked", "Грязное рабочее дерево", { stash, files: dirty.slice(0, 20) });
      throw new BlockedError(message);
    }
  }

  // Секреты (config.json с токеном, config.yml) не должны попадать в репозиторий:
  // бэкап живёт в state-каталоге пользователя, а в артефактах задачи — только путь.
  // Бэкап конфигов нужен только компонентам, которые их меняют/перезапускают;
  // для relay/runtime это лишние копии токенов на диске (E2).
  const needsBackup = args.component === "omp" || args.component === "gateway" || args.component === "frontend";
  const backupDir = join(paths.backupsDir, ctx.job.jobId);
  if (needsBackup) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    pruneBackups(paths.backupsDir, 5);
  }
  for (const file of needsBackup ? [paths.ompConfigPath, paths.gatewayConfigPath, paths.subscriptionsPath] : []) {
    if (!existsSync(file)) continue;
    const copy = join(backupDir, file.split("/").pop() ?? "file");
    writeFileDurable(copy, readFileSync(file, "utf8"));
    try {
      chmodSync(copy, 0o600);
    } catch {
      // права не критичны для работы, но важны для приватности
    }
  }
  stepOk(ctx, "prepare.backup", "Резервная копия конфигов", needsBackup ? backupDir : "не требуется для этого компонента");

  if (args.component === "gateway" || args.component === "frontend") {
    const { base, token } = gatewayBase(paths);
    const health = await probeGatewayHealth(base, token);
    ctx.gatewayPidBefore = health?.pid ?? ctx.gatewayPidBefore;
    if (health === null) ctx.journal.append("PREPARING", "warn", "Шлюз не отвечает до обновления", { base });
  }
  if (args.component === "relay") {
    const state = await unitState(paths, "omp-local-relay");
    ctx.journal.append("PREPARING", "unit", "Состояние local-relay", state);
  }
  if (args.component === "runtime") {
    const probe = await waitRuntimeReady(15_000);
    if (!probe.ok) throw new Error(`рантайм нездоров до обновления (сокет ${paths.runtimeSocket}): ${probe.detail}`);
  }
}

class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

async function ensureCheckpointing(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "CHECKPOINTING");
  const checkpoint = await withStep(ctx, "checkpoint.build", "Снимок активных сессий", async () => {
    const built = sanitizeCheckpoint(await buildCheckpoint(ctx.job.jobId, args.only));
    writeCheckpoint(join(ctx.artifacts, "checkpoint.json"), built);
    writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), built.sessions);
    return built;
  });
  ctx.checkpoint = checkpoint;
  ctx.job.checkpointFile = join(ctx.artifacts, "checkpoint.json");
  saveJob(ctx.statePath, ctx.job);
  const needing = checkpoint.sessions.filter((s) => s.turn?.needsContinuation === true).length;
  const blocked = checkpoint.sessions.filter((s) => s.awaitingApproval).length;
  ctx.journal.append("CHECKPOINTING", "checkpoint", "Чекпоинт сессий", {
    sessions: checkpoint.sessions.length,
    needContinuation: needing,
    awaitingApproval: blocked,
    ompVersion: checkpoint.ompVersion,
  });
  for (const session of checkpoint.sessions) {
    appendRecoveryEvent(join(ctx.artifacts, "recovery.jsonl"), {
      at: new Date().toISOString(),
      jobId: ctx.job.jobId,
      logicalId: session.logicalId,
      step: "checkpoint",
      ok: true,
      detail: `turn=${session.turn?.status ?? "unknown"} pending=${session.turn?.pendingAtExit.length ?? 0}`,
    });
  }
}

async function ensureInstalling(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "INSTALLING");
  const { paths } = ctx;
  if (args.component === "omp") {
    const targetVersion = ctx.job.versions.to;
    if (targetVersion === null) throw new Error("не определена целевая версия OMP");
    const current = await binaryVersion(paths.ompBin);
    if (current === targetVersion) {
      stepSkip(ctx, "install.skip", `Установка OMP ${targetVersion}`, `бинарь уже ${current}`);
      ctx.job.rollback = { available: existsSync(join(ctx.artifacts, "omp.previous")), reason: existsSync(join(ctx.artifacts, "omp.previous")) ? "предыдущий бинарь сохранён" : "бинарь уже целевой, предыдущего нет" };
      saveJob(ctx.statePath, ctx.job);
      return;
    }
    const build: OmpBuild = await withStep(ctx, "install.meta", "Метаданные сборки", async () => {
      const fetched = await fetchOmpBuild(paths.buildOrigin, targetVersion, buildTarget());
      if (fetched.file === null) throw new Error(`нет файла сборки для ${buildTarget()}`);
      return fetched;
    });
    if (build.file === null) throw new Error("нет файла сборки");
    const downloadPath = join(ctx.artifacts, `omp.download-${safeVersion(targetVersion)}`);
    const verified = await withStep(ctx, "install.download", `Скачивание OMP ${build.version}`, async () => {
      const file = build.file;
      if (file === null) throw new Error("нет файла сборки");
      return downloadVerified(paths.buildOrigin, file, downloadPath);
    });
    let previousSha: string | null = null;
    await withStep(ctx, "install.install", `Установка OMP ${targetVersion}`, () => {
      const result = installBinary(verified.path, paths.ompBin, join(ctx.artifacts, "omp.previous"), verified.sha256);
      previousSha = result.previousSha;
      return Promise.resolve(`sha256 ${result.installedSha.slice(0, 12)}…, предыдущий ${result.previousSha === null ? "нет" : result.previousSha.slice(0, 12)}…`);
    });
    const now = await withStep(ctx, "install.verify", "Проверка бинаря после установки", async () => {
      const version = await binaryVersion(paths.ompBin);
      if (version !== targetVersion) throw new Error(`после установки omp --version = ${version ?? "?"}, ожидалось ${targetVersion}`);
      return `omp ${version}`;
    });
    ctx.job.versions.to = now.split(" ")[1] ?? targetVersion;
    ctx.job.rollback = {
      available: existsSync(join(ctx.artifacts, "omp.previous")),
      reason: "предыдущий бинарь сохранён в артефактах задачи",
      sha256: previousSha,
    };
    saveJob(ctx.statePath, ctx.job);
    return;
  }

  if (args.component === "gateway" || args.component === "frontend") {
    // Откат доступен сразу: предыдущий коммит известен, и любая ошибка после pull
    // (install/build/restart/verify) должна возвращать систему к нему.
    if (ctx.job.versions.from !== null) {
      ctx.job.rollback = { available: true, reason: `откат к ${ctx.job.versions.from} через git reset --hard` };
      saveJob(ctx.statePath, ctx.job);
    }
    await withStep(ctx, "install.pull", "git pull --ff-only", async () => {
      const branchRes = await exec([paths.gitBin, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: paths.repoDir, timeoutMs: 10_000 });
      const branch = branchRes.stdout.trim();
      const pullArgs = branch === "" || branch === "HEAD" ? ["pull", "--ff-only"] : ["pull", "--ff-only", "origin", branch];
      const res = await exec([paths.gitBin, ...pullArgs], { cwd: paths.repoDir, timeoutMs: 180_000, env: { GIT_TERMINAL_PROMPT: "0" } });
      if (res.code !== 0) throw new Error(describeExec([paths.gitBin, ...pullArgs], res));
      return describeExec([paths.gitBin, ...pullArgs], res);
    });
    for (const dir of ["gateway", "app"] as const) {
      await withStep(ctx, `install.bun.${dir}`, `bun install (${dir})`, async () => {
        const res = await exec([paths.bunBin, "install"], { cwd: join(paths.repoDir, dir), timeoutMs: 300_000 });
        if (res.code !== 0) throw new Error(describeExec([paths.bunBin, "install"], res));
        return "зависимости установлены";
      });
    }
    await withStep(ctx, "install.build", "Сборка фронтенда", async () => {
      const res = await exec([paths.bunBin, "run", "build"], { cwd: join(paths.repoDir, "app"), timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(describeExec([paths.bunBin, "run", "build"], res));
      return distArtifactCheck(paths.appDistDir);
    });
    const head = await headSha(paths);
    if (head !== null) {
      ctx.job.versions.to = head;
      ctx.job.rollback = { available: ctx.job.versions.from !== null, reason: `откат к ${ctx.job.versions.from ?? "?"} через git reset --hard` };
      saveJob(ctx.statePath, ctx.job);
    }
    return;
  }

  stepSkip(ctx, "install.none", "Установка", `${args.component}: установка не требуется, только рестарт`);
}

/** Перезапуск всех сессий чекпоинта в их панелях: путь обновления omp — процессы
 * сессий гасятся намеренно, а возвращаются тем же `--restore`. */
async function restartCheckpointSessions(ctx: Ctx, checkpoint: Checkpoint): Promise<void> {
  const control = runtimeSessionControl();
  // Список прошлой попытки: если процесс такой сессии успел завершиться между
  // попытками, она всё равно не должна превратиться в провал обновления.
  const legacyById = new Map<string, LegacySessionRef>((ctx.job.result?.legacy ?? []).map((ref): [string, LegacySessionRef] => [ref.sessionId, ref]));
  let index = 0;
  for (const session of checkpoint.sessions) {
    index += 1;
    const before = session.pid;
    // Задачу могли перезапустить после сбоя: сессии, которые предыдущая попытка уже
    // подняла, не трогаем — второй `--restore` набрался бы в stdin работающего агента.
    if (session.recovery.relaunched) {
      ctx.journal.append("RESTARTING", "session.skip", `${session.label ?? session.sessionId}: перезапущена предыдущей попыткой`, { pane: session.paneId });
      continue;
    }
    // Сессия живёт в прежней панели: у демона рантайма её нет, перезапускать нечего.
    // Это не провал — агент продолжает работать, но остаётся на прежнем образе;
    // список сохраняется в результате задачи, чтобы «успех» не был ложным.
    if (session.paneId === null && (legacyById.has(session.sessionId) || isLegacySession(session, control))) {
      session.recovery.blocked = null;
      if (!legacyById.has(session.sessionId)) {
        legacyById.set(session.sessionId, legacyRef(session));
        ctx.journal.append("RESTARTING", "session.legacy", `${session.label ?? session.sessionId}: вне панелей рантайма — остаётся на прежней версии`, { sessionId: session.sessionId, pid: session.pid });
      }
      continue;
    }
    const outcome = await restartSession(session, control, (event) => {
      appendRecoveryEvent(join(ctx.artifacts, "recovery.jsonl"), {
        at: new Date().toISOString(),
        jobId: ctx.job.jobId,
        logicalId: session.logicalId,
        step: event.step,
        ok: event.ok,
        detail: event.detail,
      });
      ctx.journal.append("RESTARTING", `session.${event.step}`, `${session.label ?? session.sessionId}: ${event.detail}`, { pane: session.paneId, ok: event.ok });
    }, { waitRegistration: false });
    checkpoint.sessions[index - 1] = outcome.session;
    writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), checkpoint.sessions);
    saveRecoveryProgress(ctx, checkpoint);
    if (before !== null && outcome.session.recovery.blocked !== null) {
      ctx.journal.append("RESTARTING", "session.blocked", `${session.label ?? session.sessionId}: ${outcome.session.recovery.blocked}`, { pane: session.paneId });
    }
  }
  writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), checkpoint.sessions);
  saveRecoveryProgress(ctx, checkpoint);
  setResult(ctx, { legacy: [...legacyById.values()] });
  ctx.checkpoint = checkpoint;
}

/** argv перезапуска сессии в новой панели: сохранённые опции запуска + свежий
 * селектор сессии. Смысл тот же, что у recovery (`relaunchCommand`), но argv —
 * панель запускает его без шелл-разбора, поэтому аргументы не могут слипнуться. */
function restoreArgv(session: LogicalSession): string[] {
  const base = session.launchArgv.length > 0 ? [...session.launchArgv] : ["omp", "--cwd", session.cwd, "--allow-home"];
  const argv = base.filter((arg) => arg !== "--continue" && arg !== "-c" && arg !== "--no-session");
  const file = session.files[session.files.length - 1] ?? null;
  return file === null ? [...argv, "--continue"] : [...argv, "--restore", file];
}

/** `runInPane` только набирает команду в оболочке, поэтому «панель создана» ещё не
 * значит «агент работает»: ждём появления процесса агента в панели. */
async function waitAgentProcess(paneId: string, shellPid: number, timeoutMs = 15_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const agent = agentProcess(await paneProcesses(paneId).catch(() => []), shellPid);
    if (agent !== null) return agent.pid;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(200);
  }
}

/** Панели после рестарта рантайма: закрытые панели демон не поднимает сам, поэтому
 * оркестратор гасит их до рестарта, а после — создаёт заново и возвращает в них
 * сессию тем же `--restore`. Готовность проверяется по живому процессу агента,
 * а не по ответу «панель создана»: панель без агента — потерянная сессия. */
async function relaunchRuntimePanes(ctx: Ctx, checkpoint: Checkpoint): Promise<string> {
  let up = 0;
  const blocked: string[] = [];
  const legacyById = new Map<string, LegacySessionRef>((ctx.job.result?.legacy ?? []).map((ref): [string, LegacySessionRef] => [ref.sessionId, ref]));
  const control = runtimeSessionControl();
  for (const session of checkpoint.sessions) {
    const label = session.label ?? session.sessionId;
    if (session.paneId === null && (legacyById.has(session.sessionId) || isLegacySession(session, control))) {
      // Прежняя панель демону не принадлежит: её рестарт не затрагивает, сессия
      // продолжает работать вне рантайма и остаётся на прежнем образе.
      session.recovery.blocked = null;
      if (!legacyById.has(session.sessionId)) {
        legacyById.set(session.sessionId, legacyRef(session));
        ctx.journal.append("RESTARTING", "session.legacy", `${label}: вне панелей рантайма — остаётся на прежней версии`, { sessionId: session.sessionId, pid: session.pid });
      }
      continue;
    }
    if (session.awaitingApproval) {
      // Панель с вопросом пользователя не закрываем: демон поднимет её сам
      // (`desiredRunning` остался true), иначе ответ человека потерялся бы.
      session.recovery.blocked = "сессия ждёт подтверждения пользователя — панель не перезапускалась";
      blocked.push(`${label}: ${session.recovery.blocked}`);
      continue;
    }
    if (session.paneId === null) {
      session.recovery.blocked = "нет панели рантайма: перезапускать нечего";
      blocked.push(`${label}: ${session.recovery.blocked}`);
      continue;
    }
    const previous = session.paneId;
    try {
      const sessionFile = session.files[session.files.length - 1] ?? null;
      const argv = restoreArgv(session);
      const pane = await createPane(session.cwd, { name: label.slice(0, 64) });
      const launched = await runInPane(pane.paneId, argv, { sessionFile });
      // Сессию мог поднять уже сам демон: закрыть панель не успели, или задача
      // повторяется после сбоя. Тогда свежая панель лишняя — работаем с владелицей,
      // иначе на один файл сессии оказалось бы два агента.
      const owner = launched.alreadyRunning && launched.paneId !== undefined ? await getPane(launched.paneId) : pane;
      if (owner === null) throw new Error("панель-владелица сессии исчезла");
      const adopted = owner.paneId !== pane.paneId;
      if (adopted) await closePane(pane.paneId).catch(() => undefined);
      let agentPid = await waitAgentProcess(owner.paneId, owner.shellPid, adopted ? 3_000 : 15_000);
      if (adopted && agentPid === null) {
        // Панель демон поднял, а агента в ней нет (восстановление не удалось):
        // возвращаем сессию в неё тем же argv — как в свежую панель.
        await runInPane(owner.paneId, argv, { sessionFile });
        agentPid = await waitAgentProcess(owner.paneId, owner.shellPid);
      }
      if (agentPid === null) throw new Error("агент не появился в панели за 15 с");
      // Метку восстановления снимаем: продолжение турна этой сессии ведёт оркестратор,
      // иначе его дослал бы и шлюз (инвариант в panes.ts).
      await bindPane(owner.paneId, { sessionId: session.sessionId, sessionFile, status: "starting", awaitingApproval: false, restoredAt: null });
      session.paneId = owner.paneId;
      session.pid = agentPid;
      session.recovery.relaunched = true;
      up += 1;
      ctx.journal.append("RESTARTING", "pane.up", `${label}: панель ${owner.paneId}, pid ${agentPid}`, { from: previous });
    } catch (err) {
      session.recovery.blocked = `панель не поднялась: ${err instanceof Error ? err.message : String(err)}`;
      blocked.push(`${label}: ${session.recovery.blocked}`);
      ctx.journal.append("RESTARTING", "pane.failed", `${label}: ${session.recovery.blocked}`, { pane: previous });
    }
  }
  writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), checkpoint.sessions);
  saveRecoveryProgress(ctx, checkpoint);
  ctx.checkpoint = checkpoint;
  const legacy = [...legacyById.values()];
  setResult(ctx, { legacy });
  return `панелей поднято ${up} из ${checkpoint.sessions.length}, заблокировано ${blocked.length}${legacy.length > 0 ? `, ${legacyReport(legacy)}` : ""}`;
}

async function ensureRestarting(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "RESTARTING");
  const { paths } = ctx;
  if (args.component === "omp") {
    const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
    if (checkpoint === null) throw new Error("нет чекпоинта: перезапуск панелей без снимка сессий запрещён");
    const versionBefore = ctx.job.versions.from;
    const versionAfter = ctx.job.versions.to ?? versionBefore;
    await restartCheckpointSessions(ctx, checkpoint);
    const legacy = ctx.job.result?.legacy ?? [];
    stepOk(ctx, "restart.panes", "Перезапуск панелей omp", `сессий в чекпоинте: ${checkpoint.sessions.length}, версия ${versionBefore ?? "?"} → ${versionAfter ?? "?"}${legacy.length > 0 ? `; ${legacyReport(legacy)}` : ""}`);
    return;
  }

  if (args.component === "gateway" || args.component === "frontend") {
    const { base, token } = gatewayBase(paths);
    const before = await probeGatewayHealth(base, token);
    ctx.gatewayPidBefore = before?.pid ?? ctx.gatewayPidBefore;
    await withStep(ctx, "restart.gateway", "Перезапуск gateway", () => restartUnit(paths, paths.gatewayUnit));
    return;
  }

  if (args.component === "relay") {
    await withStep(ctx, "restart.relay", "Перезапуск local-relay", () => restartUnit(paths, "omp-local-relay"));
    return;
  }

  if (args.component === "runtime") {
    const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
    const panesBefore = checkpoint?.sessions.length ?? 0;
    // Панели гасим ДО рестарта: закрытая панель не поднимается демоном заново
    // (`desiredRunning=false`), поэтому сессию возвращает именно оркестратор —
    // иначе рядом оказались бы две панели на одной сессии.
    await withStep(ctx, "restart.panes.down", "Гашение панелей перед рестартом рантайма", async () => {
      let closed = 0;
      for (const session of checkpoint?.sessions ?? []) {
        if (session.paneId === null || session.awaitingApproval) continue;
        try {
          await closePane(session.paneId);
          session.recovery.killed = true;
          closed += 1;
        } catch (err) {
          ctx.journal.append("RESTARTING", "pane.close.failed", `${session.label ?? session.sessionId}: панель не закрылась`, { pane: session.paneId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return `закрыто панелей: ${closed} из ${panesBefore}`;
    });
    await withStep(ctx, "restart.runtime", "Перезапуск рантайма", () => restartUnit(paths, paths.runtimeUnit));
    // Демон отвечает не сразу после выхода systemctl: без ожидания проба валит
    // задачу до фазы восстановления, и сессии остаются мёртвыми.
    await withStep(ctx, "restart.runtime.ready", "Готовность рантайма после рестарта", async () => {
      const ready = await waitRuntimeReady(10_000);
      if (!ready.ok) throw new Error(`рантайм не поднялся после рестарта (сокет ${paths.runtimeSocket}): ${ready.detail}`);
      return ready.detail;
    });
    if (checkpoint !== null && checkpoint.sessions.length > 0) {
      await withStep(ctx, "restart.panes.up", "Панели после рестарта рантайма", () => relaunchRuntimePanes(ctx, checkpoint));
    }
    return;
  }
}

/** Артефакт берём только из каталога задач: иначе путь из job-файла выведет куда угодно (D3). */
function safeArtifactPath(paths: UpdatePaths, dir: string, name: string): string {
  const resolved = resolve(join(dir, name));
  const jobs = resolve(jobsDir(paths));
  if (!resolved.startsWith(`${jobs}/`)) throw new Error(`путь артефакта вне каталога задач: ${resolved}`);
  return resolved;
}

/** Секреты не должны попадать в артефакты и API: команды сессий могут содержать токены. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)\S+/giu, "$1<скрыто>")
    .replace(/(\b(?:token|password|passwd|secret|api[_-]?key|apikey)\b\s*[=:]\s*)\S+/giu, "$1<скрыто>")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/gu, "<скрыто>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1<скрыто>@");
}

/** Чекпоинт без секретов: текст команд сессий вычищается перед записью в артефакты. */
function sanitizeCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    ...checkpoint,
    sessions: checkpoint.sessions.map((session) => {
      if (session.turn === null) return session;
      const clean = (ops: Checkpoint["sessions"][number]["turn"] extends null ? never : NonNullable<Checkpoint["sessions"][number]["turn"]>["pendingAtExit"]) =>
        ops.map((op) => ({ ...op, command: op.command === null ? null : redactSecrets(op.command) }));
      return { ...session, turn: { ...session.turn, pendingAtExit: clean(session.turn.pendingAtExit), unresolved: clean(session.turn.unresolved) } };
    }),
  };
}

/** Ротация бэкапов: держим последние N задач, иначе копии токенов копятся без предела. */
function pruneBackups(dir: string, keep: number): void {
  try {
    const entries = readdirSync(dir)
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const entry of entries.slice(keep)) rmSync(join(dir, entry.name), { recursive: true, force: true });
  } catch {
    // каталога ещё нет — ротация не нужна
  }
}

/** Прогресс восстановления обязан переживать крах процесса: флаги `killed`,
 * `relaunched`, `registered`, `continued` живут в чекпоинте, поэтому пишем его
 * вместе с состоянием — иначе повтор теряет, что уже сделано, и молча пропускает
 * сессии, которые не успели вернуться. */
function saveRecoveryProgress(ctx: Ctx, checkpoint: Checkpoint): void {
  if (ctx.job.checkpointFile === null) return;
  writeCheckpoint(ctx.job.checkpointFile, checkpoint);
}

function loadCheckpoint(ctx: Ctx): Checkpoint | null {
  if (ctx.job.checkpointFile === null) return null;
  return readCheckpoint(ctx.job.checkpointFile);
}

async function ensureVerifying(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "VERIFYING");
  const { paths } = ctx;
  const verified: Record<string, string | null> = {};

  if (args.component === "omp") {
    const version = await withStep(ctx, "verify.binary", "Версия бинаря", async () => {
      const v = await binaryVersion(paths.ompBin);
      if (v === null) throw new Error(`${paths.ompBin} не отвечает`);
      return v;
    });
    verified["omp"] = version;
    const target = ctx.job.versions.to;
    if (target !== null && version !== target) throw new Error(`бинарь ${version} ≠ целевая ${target}`);

    const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
    const control = runtimeSessionControl();
    // Сессии вне панелей рантайма обновление не перезапускало: они законно
    // остаются на прежнем образе. Считаем их отдельно, чтобы проверка не
    // объявляла «все на новом образе» и не валилась на их старых процессах.
    // Список из фазы RESTARTING сохраняется: PID мог умереть, но вывод тот же.
    const legacyById = new Map<string, LegacySessionRef>((ctx.job.result?.legacy ?? []).map((ref): [string, LegacySessionRef] => [ref.sessionId, ref]));
    for (const session of checkpoint?.sessions ?? []) {
      if (!legacyById.has(session.sessionId) && isLegacySession(session, control)) legacyById.set(session.sessionId, legacyRef(session));
    }
    const legacy = [...legacyById.values()];
    const legacyIds = new Set(legacyById.keys());

    const panesReport = await withStep(ctx, "verify.running", "Работающие процессы omp", async () => {
      const hosts = await liveHosts(paths.ompBin);
      const inode = fileInode(paths.ompBin);
      // Сессии, ждущие подтверждения пользователя, не перезапускаются намеренно:
      // они остались на старом образе и перечисляются как заблокированные.
      const held = checkpoint === null ? new Set<string>() : new Set(checkpoint.sessions.filter((session) => session.recovery.blocked !== null || session.awaitingApproval).map((session) => session.sessionId));
      // проверяем только сессии этой задачи: при частичном применении (--only)
      // остальные живые сессии законно остаются на прежнем образе
      const inJob = checkpoint === null ? null : new Set(checkpoint.sessions.map((session) => session.sessionId));
      const scope = hosts.filter((host) => (inJob === null || inJob.has(host.sessionId)) && !held.has(host.sessionId) && !legacyIds.has(host.sessionId));
      const stale = scope.filter((host) => {
        const exe = pidExe(host.pid);
        return exe.deleted || (exe.inode !== 0 && exe.inode !== inode);
      });
      if (stale.length > 0) {
        throw new Error(`на старом образе остались ${stale.length} сессий: ${stale.slice(0, 5).map((host) => `pid ${host.pid}`).join(", ")}`);
      }
      // Регистрация сессии в collab занимает секунды: полноту набора проверяет
      // фаза RESTORING (она умеет ждать), здесь — только идентичность образа.
      return `проверено на образе inode ${inode}: ${scope.length}${held.size > 0 ? `, удержано подтверждением: ${held.size}` : ""}${legacy.length > 0 ? `, ${legacyReport(legacy)}` : ""}`;
    });
    verified["omp.running"] = panesReport;
    if (legacy.length > 0) verified["omp.legacy"] = legacyReport(legacy);

    const { base, token } = gatewayBase(paths);
    const health = await withStep(ctx, "verify.gateway", "Шлюз отвечает", async () => {
      const h = await waitGateway(base, token, 30_000, (probe) => probe !== null);
      if (h === null) throw new Error(`gateway не отвечает: ${base}/api/health`);
      return h;
    });
    verified["gateway"] = health.buildSha ?? String(health.pid);
    const runtimeProbe = await waitRuntimeReady(30_000);
    if (!runtimeProbe.ok) throw new Error(`рантайм нездоров: ${runtimeProbe.detail}`);
    setResult(ctx, { verifiedVersions: verified, restored: 0, resumed: 0, blocked: [], legacy });
    return;
  }

  if (args.component === "gateway" || args.component === "frontend") {
    const head = await headSha(paths);
    const { base, token } = gatewayBase(paths);
    const health = await withStep(ctx, "verify.gateway.new-pid", "Новый процесс gateway", async () => {
      const h = await waitGateway(base, token, 90_000, (probe) => probe !== null && (ctx.gatewayPidBefore === null || probe.pid !== ctx.gatewayPidBefore));
      if (h === null) throw new Error("gateway не ответил после рестарта");
      if (h.pid === ctx.gatewayPidBefore) throw new Error(`gateway отвечает старым pid ${h.pid} — рестарт не применился`);
      return h;
    });
    verified["gateway"] = `${head?.slice(0, 7) ?? "?"} (pid ${health.pid})`;
    if (head !== null && health.buildSha !== null && health.buildSha !== head) {
      throw new Error(`шлюз сообщает сборку ${health.buildSha.slice(0, 7)}, а в репозитории ${head.slice(0, 7)}`);
    }
    const asset = await withStep(ctx, "verify.frontend", "Отдаваемый фронтенд", async () => {
      const probe = await probeServedIndex(base, join(paths.appDistDir, "index.html"), token);
      if (probe.diskHash === null) throw new Error(`нет собранного ${join(paths.appDistDir, "index.html")}`);
      if (!probe.matches) throw new Error(`отдаваемый index.html (${probe.servedHash ?? "?"}) не совпадает с собранным (${probe.diskHash})`);
      return `index.html hash ${probe.diskHash}`;
    });
    verified["frontend"] = asset;
    const relayOk = await probeTcp("127.0.0.1", 7466);
    if (!relayOk) ctx.journal.append("VERIFYING", "warn", "local-relay не отвечает на 7466", { ok: false });
    const runtimeProbe = await waitRuntimeReady(30_000);
    if (!runtimeProbe.ok) throw new Error(`рантайм нездоров после обновления: ${runtimeProbe.detail}`);
    const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
    if (checkpoint !== null) {
      const alive = (await liveHosts(paths.ompBin)).length;
      ctx.journal.append("VERIFYING", "panes", "Панели после рестарта gateway", { expected: checkpoint.sessions.length, alive });
      if (alive < checkpoint.sessions.length) throw new Error(`после рестарта gateway живых сессий ${alive} из ${checkpoint.sessions.length}`);
    }
    setResult(ctx, { verifiedVersions: verified, restored: 0, resumed: 0, blocked: [] });
    return;
  }

  if (args.component === "relay") {
    const tcp = await probeTcp("127.0.0.1", 7466, 5_000);
    const state = await unitState(paths, "omp-local-relay");
    if (!tcp) throw new Error("local-relay не слушает 7466 после рестарта");
    if (state.active !== "active") throw new Error(`omp-local-relay в состоянии ${state.active}`);
    verified["relay"] = `active, pid ${state.pid}, 7466 открыт`;
    setResult(ctx, { verifiedVersions: verified, restored: 0, resumed: 0, blocked: [] });
    return;
  }

  if (args.component === "runtime") {
    const probe = await waitRuntimeReady(45_000);
    if (!probe.ok) throw new Error(`рантайм нездоров после рестарта (сокет ${paths.runtimeSocket}): ${probe.detail}`);
    const state = await unitState(paths, paths.runtimeUnit);
    verified["runtime"] = `active (${state.active}), health ok`;
    setResult(ctx, { verifiedVersions: verified, restored: 0, resumed: 0, blocked: [] });
  }
}

async function ensureRestoring(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "RESTORING");
  const { paths } = ctx;
  if (process.env["OMP_UPDATE_FAULT"] === "corrupt-checkpoint" && ctx.job.checkpointFile !== null) {
    writeFileDurable(ctx.job.checkpointFile, "{ broken checkpoint");
    ctx.checkpoint = null;
  }
  const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
  if (checkpoint === null) {
    if (ctx.job.checkpointFile !== null) throw new BlockedError(`чекпоинт ${ctx.job.checkpointFile} не читается — восстановление сессий вслепую запрещено`);
    stepSkip(ctx, "restore.none", "Восстановление сессий", "чекпоинт не создавался");
    return;
  }
  const control = runtimeSessionControl();
  let restored = 0;
  const blocked: string[] = [];
  // Сессии вне панелей рантайма: их не перезапускали, они работают на прежнем
  // образе. Это не провал восстановления — их считаем отдельно и показываем в
  // результате задачи. Список из RESTARTING сохраняется на случай, если процесс
  // успел завершиться между фазами. У компонентов, которые не трогают сессии omp
  // (шлюз, фронтенд, релей), такой отчёт был бы ложным — там сессии не считаем.
  const tracksLegacy = args.component === "omp" || args.component === "runtime";
  const legacyById = new Map<string, LegacySessionRef>((ctx.job.result?.legacy ?? []).map((ref): [string, LegacySessionRef] => [ref.sessionId, ref]));
  // Провал восстановления (не связанный с ожиданием пользователя) — это провал
  // проверки работоспособности: задача должна уйти в откат, а не «завершиться».
  const failedRestore: string[] = [];
  for (let i = 0; i < checkpoint.sessions.length; i++) {
    const session = checkpoint.sessions[i];
    if (session === undefined) continue;
    const label = session.label ?? session.sessionId;
    if (session.paneId === null) {
      if (!tracksLegacy) continue;
      if (legacyById.has(session.sessionId) || isLegacySession(session, control)) {
        if (!legacyById.has(session.sessionId)) legacyById.set(session.sessionId, legacyRef(session));
        continue;
      }
      // Панели нет и хост не отвечает: обновление её действительно потеряло.
      failedRestore.push(`${label}: нет панели рантайма и collab-хост не отвечает — восстанавливать нечего`);
      continue;
    }
    // Уже заблокированные (например, сессия ждёт подтверждения — её restartSession
    // не трогает и не помечает killed) обязаны попасть в отчёт: иначе они молча
    // выпадают из результата, и задача «успешно» завершается без них.
    if (session.recovery.blocked !== null) {
      if (session.awaitingApproval) blocked.push(`${label}: ${session.recovery.blocked}`);
      else failedRestore.push(`${label}: ${session.recovery.blocked}`);
      continue;
    }
    // Чужие сессии (не перезапускались этой задачей) не восстанавливаем и не считаем:
    // иначе рестарт релея «восстанавливал» все 33 живые сессии и будил их промптами.
    if (!session.recovery.killed && !session.recovery.relaunched) continue;
    if (!session.recovery.registered && session.paneId !== null) {
      // регистрация ждёт только эта фаза; при провале — одна повторная попытка
      const registered = await awaitRegistration(session, control);
      if (registered) {
        const fresh = await sessionRunsNewBinary(session, paths.ompBin);
        if (fresh !== null) {
          session.recovery.blocked = fresh;
          blocked.push(`${session.label ?? session.sessionId}: ${fresh}`);
          continue;
        }
      }
      if (!registered) {
        const outcome = await restartSession(session, control, undefined, { waitRegistration: false });
        checkpoint.sessions[i] = outcome.session;
        const retried = await awaitRegistration(outcome.session, control, 15_000);
        if (!retried) failedRestore.push(`${outcome.session.label ?? outcome.session.sessionId}: ${outcome.session.recovery.blocked ?? "не восстановлена"}`);
        else restored += 1;
        continue;
      }
      restored += 1;
      continue;
    }
    restored += 1;
  }
  writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), checkpoint.sessions);
  saveRecoveryProgress(ctx, checkpoint);
  ctx.checkpoint = checkpoint;
  const legacy = [...legacyById.values()];
  setResult(ctx, { restored, blocked, legacy });
  stepOk(
    ctx,
    "restore.sessions",
    "Восстановление сессий",
    `восстановлено ${restored} из ${checkpoint.sessions.length}, заблокировано ${blocked.length}, сбоев ${failedRestore.length}${legacy.length > 0 ? `; ${legacyReport(legacy)}` : ""}`,
  );
  if (failedRestore.length > 0) {
    throw new Error(`восстановление сессий не удалось: ${failedRestore.slice(0, 5).join("; ")}`);
  }
  void args;
}

async function ensureResuming(ctx: Ctx, args: Args): Promise<void> {
  enter(ctx, "RESUMING");
  const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
  if (checkpoint === null) {
    stepSkip(ctx, "resume.none", "Продолжение задач", "чекпоинт не создавался");
    return;
  }
  const control = runtimeSessionControl();
  let resumed = 0;
  const blocked: string[] = [...(ctx.job.result?.blocked ?? [])];
  for (let i = 0; i < checkpoint.sessions.length; i++) {
    const session = checkpoint.sessions[i];
    if (session === undefined) continue;
    if (session.recovery.blocked !== null || session.recovery.continued) continue;
    if (!session.recovery.killed && !session.recovery.relaunched) continue;
    if (session.turn === null || !session.turn.needsContinuation) continue;
    const outcome = await continueSession(session, control, ctx.job.versions.from, ctx.job.versions.to);
    checkpoint.sessions[i] = outcome.session;
    if (outcome.session.recovery.continued) {
      resumed += 1;
      appendRecoveryEvent(join(ctx.artifacts, "recovery.jsonl"), {
        at: new Date().toISOString(),
        jobId: ctx.job.jobId,
        logicalId: session.logicalId,
        step: "continue",
        ok: true,
        detail: `turn=${session.turn.status}, опасных операций: ${session.turn.pendingAtExit.length}`,
        dangerOps: session.turn.pendingAtExit,
      });
    } else if (outcome.session.recovery.blocked !== null) {
      blocked.push(`${session.label ?? session.sessionId}: ${outcome.session.recovery.blocked}`);
    }
  }
  writeRecoveryState(join(ctx.artifacts, "recovery-state.json"), checkpoint.sessions);
  saveRecoveryProgress(ctx, checkpoint);
  ctx.checkpoint = checkpoint;
  setResult(ctx, { resumed, blocked });
  stepOk(ctx, "resume.sessions", "Продолжение прерванных задач", `продолжено ${resumed}, заблокировано ${blocked.length}`);
  void args;
}

async function rollback(ctx: Ctx, args: Args, reason: string): Promise<void> {
  if (ctx.job.rollback === null || !ctx.job.rollback.available) {
    ctx.journal.append(ctx.job.phase, "rollback.unavailable", "Откат невозможен", { reason: ctx.job.rollback?.reason ?? "нет сохранённого предыдущего состояния" });
    throw new Error(`откат невозможен: ${reason}`);
  }
  assertTransition(ctx.job.phase, "ROLLING_BACK");
  ctx.job.phase = "ROLLING_BACK";
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append("ROLLING_BACK", "rollback.start", `Откат после ошибки: ${reason}`);
  const { paths } = ctx;
  if (args.component === "omp") {
    const previousBinary = safeArtifactPath(ctx.paths, ctx.job.previousArtifacts ?? ctx.artifacts, "omp.previous");
    await withStep(ctx, "rollback.binary", "Возврат предыдущего бинаря", async () => {
      restoreBinary(previousBinary, paths.ompBin, ctx.job.rollback?.sha256 ?? undefined);
      const version = await binaryVersion(paths.ompBin);
      if (version === null) throw new Error("предыдущий бинарь не отвечает");
      return `omp ${version}`;
    });
    const checkpoint = ctx.checkpoint ?? loadCheckpoint(ctx);
    if (checkpoint !== null) {
      const control = runtimeSessionControl();
      for (const session of checkpoint.sessions) {
        if (session.recovery.blocked !== null || session.paneId === null) continue;
        await restartSession(session, control, undefined, { waitRegistration: false });
      }
    }
    const version = await binaryVersion(paths.ompBin);
    setResult(ctx, { verifiedVersions: { omp: version }, restored: 0, resumed: 0, blocked: ctx.job.result?.blocked ?? [] });
  } else if (args.component === "gateway" || args.component === "frontend") {
    const from = ctx.job.versions.from;
    if (from === null) throw new Error("не сохранён предыдущий git SHA");
    await withStep(ctx, "rollback.git", `git reset --hard ${from}`, async () => {
      const res = await exec([paths.gitBin, "reset", "--hard", from], { cwd: paths.repoDir, timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(describeExec([paths.gitBin, "reset", "--hard", from], res));
      return `HEAD = ${from}`;
    });
    for (const dir of ["gateway", "app"] as const) {
      await withStep(ctx, `rollback.bun.${dir}`, `bun install (${dir})`, async () => {
        const res = await exec([paths.bunBin, "install"], { cwd: join(paths.repoDir, dir), timeoutMs: 300_000 });
        if (res.code !== 0) throw new Error(describeExec([paths.bunBin, "install"], res));
        return "ok";
      });
    }
    await withStep(ctx, "rollback.build", "Сборка фронтенда", async () => {
      const res = await exec([paths.bunBin, "run", "build"], { cwd: join(paths.repoDir, "app"), timeoutMs: 300_000 });
      if (res.code !== 0) throw new Error(describeExec([paths.bunBin, "run", "build"], res));
      return distArtifactCheck(paths.appDistDir);
    });
    await withStep(ctx, "rollback.restart", "Перезапуск gateway", () => restartUnit(paths, paths.gatewayUnit));
    const { base, token } = gatewayBase(paths);
    const health = await waitGateway(base, token, 90_000, (probe) => probe !== null && (ctx.gatewayPidBefore === null || probe.pid !== ctx.gatewayPidBefore));
    if (health === null) throw new Error("gateway не ответил после отката");
    setResult(ctx, { verifiedVersions: { gateway: `${from.slice(0, 7)} (pid ${health.pid})` }, restored: 0, resumed: 0, blocked: [] });
  } else {
    await withStep(ctx, "rollback.restart", "Перезапуск компонента", () => restartUnit(paths, args.component === "relay" ? "omp-local-relay" : paths.runtimeUnit));
  }
  ctx.job.phase = "ROLLED_BACK";
  ctx.job.finishedAt = new Date().toISOString();
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append("ROLLED_BACK", "rollback.done", "Откат завершён, предыдущая версия проверена", { result: ctx.job.result });
}

function markFailed(ctx: Ctx, phase: Phase, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  ctx.job.error = { message, phase };
  ctx.job.phase = "FAILED";
  ctx.job.finishedAt = new Date().toISOString();
  saveJob(ctx.statePath, ctx.job);
  ctx.journal.append("FAILED", "error", message, { from: phase });
}

function statePathFor(paths: UpdatePaths, jobId: string): string {
  return jobStatePath(paths, jobId);
}

async function run(args: Args): Promise<number> {
  const paths = defaultPaths();
  mkdirSync(jobArtifactsDir(paths, args.jobId), { recursive: true, mode: 0o700 });
  const statePath = jobStatePath(paths, args.jobId);
  const journalPath = jobJournalPath(paths, args.jobId);
  let lock;
  try {
    lock = acquireLock(lockPath(paths), args.jobId);
  } catch (err) {
    if (err instanceof LockBusyError) {
      process.stderr.write(`${err.message}\n`);
      // Задача не должна оставаться «активной» после смерти процесса (D2).
      const stale = readJobFile(statePathFor(paths, args.jobId)) ?? newJob(args.component, args.jobId);
      stale.phase = "FAILED";
      stale.error = { message: err.message, phase: "IDLE" };
      stale.finishedAt = new Date().toISOString();
      saveJob(statePathFor(paths, args.jobId), stale);
      return 3;
    }
    throw err;
  }
  const existing = readJobFile(statePath);
  const job = existing !== null && existing.jobId === args.jobId ? existing : newJob(args.component, args.jobId);
  if (existing !== null) job.attempt += 1;
  job.owner = { pid: process.pid, bootId: readBootId(), startedAt: new Date().toISOString() };
  saveJob(statePath, job);
  const journal = new UpdateJournal(journalPath, args.jobId);
  const ctx: Ctx = {
    paths,
    job,
    journal,
    statePath,
    artifacts: jobArtifactsDir(paths, args.jobId),
    checkpoint: job.checkpointFile === null ? null : readCheckpoint(job.checkpointFile),
    gatewayPidBefore: null,
  };
  writeFileDurable(activeMarkerPath(paths), `${JSON.stringify({ jobId: args.jobId, component: args.component, phase: job.phase, pid: process.pid, at: new Date().toISOString() })}\n`);
  journal.append(job.phase, "start", `Оркестратор запущен (${args.component}, попытка ${job.attempt})`, { pid: process.pid, phase: job.phase });

  let exitCode = 0;
  try {
    if (isTerminal(job.phase)) {
      journal.append(job.phase, "noop", "Задача уже завершена", { phase: job.phase });
      return exitCode;
    }
    if (args.rollback) {
      await rollback(ctx, args, "явный откат по запросу пользователя");
      return ctx.job.phase === "ROLLED_BACK" ? 0 : 2;
    }
    if (job.phase !== "IDLE") journal.append(job.phase, "resume", `Продолжение с фазы ${job.phase}`, { attempt: job.attempt });

    if (needs(ctx, "CHECKING")) {
      await ensureChecking(ctx, args);
      if (isTerminal(ctx.job.phase)) return 0;
      maybeFault("after-checking");
    }
    if (needs(ctx, "PREPARING")) {
      await ensurePreparing(ctx, args);
      maybeFault("after-preparing");
    }
    if (needs(ctx, "CHECKPOINTING")) {
      await ensureCheckpointing(ctx, args);
      maybeFault("after-checkpointing");
    }
    if (needs(ctx, "INSTALLING")) {
      await ensureInstalling(ctx, args);
      maybeFault("after-installing");
    }
    // Фазу, в которой процесс умер, повторяем: `enter` сохраняет фазу ДО работы, так
    // что иначе шаг считался бы выполненным. Повтор безопасен — состояние берётся из
    // чекпоинта и фактических процессов, а не из памяти, а сессии, поднятые прошлой
    // попыткой, пропускаются. Без этого погашенные панели никто бы не поднял, а
    // задача отчиталась бы об успехе.
    if (ctx.job.phase === "RESTARTING" || needs(ctx, "RESTARTING")) {
      await ensureRestarting(ctx, args);
      maybeFault("after-restarting");
    }
    if (needs(ctx, "VERIFYING")) {
      await ensureVerifying(ctx, args);
      maybeFault("after-verifying");
    }
    if (ctx.job.phase === "RESTORING" || needs(ctx, "RESTORING")) {
      await ensureRestoring(ctx, args);
      maybeFault("after-restoring");
    }
    if (ctx.job.phase === "RESUMING" || needs(ctx, "RESUMING")) await ensureResuming(ctx, args);

    if (!isTerminal(ctx.job.phase)) {
      advance(ctx.job, "COMPLETED");
      saveJob(statePath, ctx.job);
      journal.append("COMPLETED", "done", "Обновление завершено и проверено", { result: ctx.job.result });
    }
    return exitCode;
  } catch (err) {
    if (err instanceof BlockedError) {
      ctx.job.phase = "BLOCKED";
      ctx.job.error = { message: err.message, phase: "PREPARING" };
      ctx.job.finishedAt = new Date().toISOString();
      saveJob(statePath, ctx.job);
      journal.append("BLOCKED", "blocked", err.message);
      exitCode = 4;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const canRollback = ctx.job.rollback?.available === true && ["INSTALLING", "RESTARTING", "VERIFYING", "RESTORING", "RESUMING"].includes(ctx.job.phase);
      if (canRollback) {
        journal.append(ctx.job.phase, "error", message, { rollback: "auto" });
        try {
          await rollback(ctx, args, message);
          exitCode = 2;
          return exitCode;
        } catch (rollbackErr) {
          journal.append("ROLLING_BACK", "rollback.failed", rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
        }
      }
      markFailed(ctx, ctx.job.phase, err);
      journal.append("FAILED", "error", message);
      exitCode = 2;
    }
    return exitCode;
  } finally {
    if (isTerminal(ctx.job.phase)) {
      rmSync(activeMarkerPath(paths), { force: true });
    }
    lock.release();
  }
}

const args = parseArgs(process.argv.slice(2));
const code = await run(args);
process.exit(code);
