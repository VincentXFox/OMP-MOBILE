import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readJobFile, type JobState } from "../jobState.ts";
import type { UpdatePaths } from "../paths.ts";
import { readJournal, type UpdateEvent } from "../journal.ts";
import { runtimeCall, spawnRuntimeDaemon, stopRuntimeDaemon, waitRuntimeHealth, withFileLock, type RuntimeDaemonSpec } from "./runtime.ts";

export interface WorldSessionSeed {
  sessionId: string;
  /** Каталог сессии внутри мира: раскрывается от корня мира, то есть «/work/app» —
   * это <корень>/work/app. Панель рантайма требует реально существующий каталог,
   * поэтому его создаёт сам мир, а в мире лежит абсолютный путь. */
  cwd: string;
  model?: string;
  /** Содержимое транскрипта (JSONL-строки). */
  transcript: unknown[];
  busy?: boolean;
  inputRequired?: boolean;
}

export interface WorldFile {
  ompVersion: string;
  sessions: Array<{
    sessionId: string;
    pid: number;
    cwd: string;
    sessionFile: string;
    model: string;
    busy: boolean;
    inputRequired: boolean;
    paneId: string;
  }>;
  restarts: string[];
  /** Промпты, доставленные агентам: их видит живой процесс сессии на stdin. */
  prompts: string[];
  /** Команды, которыми поднимались процессы сессий: по ним видно, что сессия
   * вернулась именно через `--restore`, а не пропала. */
  runs: string[];
  /** Задержка старта демона рантайма после `systemctl restart`, мс: демон
   * поднимается не сразу — та самая гонка, которую ловит `waitRuntimeReady`. */
  runtimeDown: number;
  /** Демон рантайма: pid нужен, чтобы погасить его при рестарте и в уборке. */
  runtime: { pid: number };
  /** Сбой восстановления: процессы сессий не поднимаются совсем. */
  breakRestore: boolean;
  units: Record<string, { active: string; pid: number }>;
  gateway: { pid: number; buildSha: string | null };
  head: string;
  remoteHead: string;
  dirty: string[];
}

export interface ReleaseServer {
  origin: string;
  /** Меняет отдаваемый бинарь (для сценария «подмена»). */
  setPayload: (payload: Uint8Array, declaredSha?: string) => void;
  stop: () => void;
}

export interface GatewayServer {
  base: string;
  stop: () => void;
}

export interface ChaosRoot {
  dir: string;
  home: string;
  repoDir: string;
  stateDir: string;
  binDir: string;
  worldPath: string;
  sessionsRoot: string;
  /** Сокет демона рантайма этого корня. */
  socket: string;
  env: Record<string, string>;
  readWorld: () => WorldFile;
  writeWorld: (world: WorldFile) => void;
  /** Правка мира под замком: в него пишут и тест, и процессы-драйверы. */
  withWorld: <T>(mutate: (world: WorldFile) => T) => T;
  /** Погасить демон рантайма корня (pid мог смениться рестартом юнита). */
  stopRuntime: () => Promise<void>;
  readJob: (jobId: string) => JobState | null;
  readEvents: (jobId: string) => UpdateEvent[];
  runOrchestrator: (component: string, jobId: string, extraArgs?: string[], extraEnv?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const SCRIPT = new URL("./agent.ts", import.meta.url).pathname;
const ORCHESTRATOR = new URL("../orchestrator.ts", import.meta.url).pathname;
const RUNTIME_MAIN = new URL("../../runtime/main.ts", import.meta.url).pathname;
const BUN = process.execPath;

/** Компилируем драйвер один раз на запуск тестов: настоящий ELF нужен, чтобы
 * проверка «работает новый бинарь» шла по /proc/<pid>/exe, а не по имени скрипта. */
const driverCache = new Map<string, string>();

function compileFake(outfile: string, define?: string): string {
  const key = `${outfile}:${define ?? ""}`;
  const cached = driverCache.get(key);
  if (cached !== undefined && existsSync(cached)) return cached;
  const args = [BUN, "build", "--compile", SCRIPT, "--outfile", outfile];
  if (define !== undefined) args.push("--define", define);
  const res = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`сборка фейкового бинаря не удалась: ${res.stderr.toString()}`);
  driverCache.set(key, outfile);
  return outfile;
}

export function fakeDriverPath(cacheDir: string): string {
  const out = join(cacheDir, "driver.bin");
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(SCRIPT).mtimeMs) return out;
  return compileFake(out);
}

/** «Новый бинарь» версии version: тот же драйвер с зашитой версией. */
export function fakeBinaryForVersion(version: string, cacheDir: string): string {
  return compileFake(join(cacheDir, `omp-${version}.bin`), `process.env.OMP_CHAOS_VERSION=${JSON.stringify(version)}`);
}

function writeBin(dir: string, name: string, target: string): void {
  const path = join(dir, name);
  try {
    linkSync(target, path);
  } catch {
    copyFileSync(target, path);
  }
  chmodSync(path, 0o755);
}

export function sessionJsonl(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function assistantTurn(stopReason: string, toolCalls: Array<{ id: string; name: string; command?: string; path?: string }> = []): unknown {
  return {
    type: "message",
    timestamp: "2026-10-24T10:00:00.000Z",
    message: {
      role: "assistant",
      stopReason,
      content: toolCalls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.command === undefined ? { path: call.path ?? "/tmp/x" } : { command: call.command },
      })),
    },
  };
}

export function toolResult(id: string, name = "bash"): unknown {
  return { type: "message", timestamp: "2026-10-24T10:00:01.000Z", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }] } };
}

export function sigtermExit(reason = "sigterm", pending: Array<{ toolCallId: string; toolName: string; command?: string }> = []): unknown {
  return {
    type: "custom",
    customType: "session_exit",
    timestamp: "2026-10-24T10:05:00.000Z",
    data: {
      kind: "signal",
      reason,
      recordedAt: "2026-10-24T10:05:00.000Z",
      pendingToolCalls: pending.map((item) => ({ toolCallId: item.toolCallId, toolName: item.toolName, args: item.command === undefined ? {} : { command: item.command }, startedAt: "2026-10-24T10:04:00.000Z" })),
    },
  };
}

export interface CreateRootOptions {
  seeds?: WorldSessionSeed[];
  ompVersion?: string;
  head?: string;
  remoteHead?: string;
  dirty?: string[];
}

export async function createChaosRoot(options: CreateRootOptions = {}): Promise<ChaosRoot> {
  const dir = join(tmpdir(), `omp-chaos-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const home = join(dir, "home");
  const repoDir = join(dir, "repo");
  const stateDir = join(repoDir, "gateway", "update");
  const binDir = join(dir, "bin");
  const sessionsRoot = join(home, ".omp", "agent", "sessions");
  const socket = join(dir, "run", "omp-pocket-runtime.sock");
  const runtimeStateDir = join(dir, "state", "runtime");
  for (const path of [home, repoDir, stateDir, binDir, sessionsRoot, dirname(socket), runtimeStateDir, join(repoDir, "gateway"), join(repoDir, "app", "dist")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(repoDir, "gateway", "package.json"), JSON.stringify({ name: "gateway", version: "0.1.0" }));
  writeFileSync(join(repoDir, "app", "package.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: { "@oh-my-pi/pi-wire": options.ompVersion ?? "18.12.6" } }));
  writeFileSync(join(repoDir, "gateway", "config.json"), JSON.stringify({ token: "chaos-token", port: 0, host: "127.0.0.1" }));
  writeFileSync(join(home, ".omp", "agent", "config.yml"), "model: fake\n");

  const cacheDir = join(tmpdir(), "omp-chaos-cache");
  mkdirSync(cacheDir, { recursive: true });
  const driver = fakeDriverPath(cacheDir);
  for (const name of ["omp", "systemctl", "git", "bun-fake"]) writeBin(binDir, name, driver);
  // systemd-run: записывает вызов и не запускает ничего (оркестратор гоняется тестом напрямую)
  writeFileSync(join(binDir, "systemd-run-fake"), "#!/bin/bash\necho \"$@\" >> \"$(dirname \"$0\")/systemd-run.log\"\nexit 0\n", { mode: 0o755 });

  const world: WorldFile = {
    ompVersion: options.ompVersion ?? "18.12.6",
    sessions: [],
    restarts: [],
    prompts: [],
    runs: [],
    runtimeDown: 0,
    runtime: { pid: 0 },
    breakRestore: false,
    units: {
      "omp-pocket-gateway": { active: "active", pid: 4242 },
      "omp-local-relay": { active: "active", pid: 4343 },
      "omp-pocket-runtime": { active: "active", pid: 4444 },
    },
    gateway: { pid: 4242, buildSha: options.head ?? "a".repeat(40) },
    head: options.head ?? "a".repeat(40),
    remoteHead: options.remoteHead ?? options.head ?? "a".repeat(40),
    dirty: options.dirty ?? [],
  };
  const worldPath = join(dir, "world.json");
  const logPath = join(dir, "runtime.log");

  const writeWorld = (next: WorldFile): void => {
    writeFileSync(worldPath, JSON.stringify(next, null, 1));
  };

  const readWorld = (): WorldFile => JSON.parse(readFileSync(worldPath, "utf8")) as WorldFile;

  /** Правка мира под замком: в него пишут и тест, и процессы-драйверы. */
  const withWorld = <T>(mutate: (world: WorldFile) => T): T =>
    withFileLock(`${worldPath}.lock`, () => {
      const current = readWorld();
      const result = mutate(current);
      writeWorld(current);
      return result;
    });

  const binPath = `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
  const binEnv: Record<string, string> = {
    OMP_CHAOS_ROOT: dir,
    HOME: home,
    PATH: binPath,
    OMP_UPDATE_STATE_DIR: stateDir,
    OMP_UPDATE_BACKUPS_DIR: join(dir, "backups"),
    OMP_UPDATE_REPO_DIR: repoDir,
    OMP_UPDATE_OMP_BIN: join(binDir, "omp"),
    OMP_UPDATE_BUN_BIN: join(binDir, "bun-fake"),
    OMP_UPDATE_GIT_BIN: join(binDir, "git"),
    OMP_UPDATE_SH_BIN: "/bin/sh",
    OMP_UPDATE_SYSTEMCTL_BIN: join(binDir, "systemctl"),
    OMP_UPDATE_GATEWAY_UNIT: "omp-pocket-gateway",
    OMP_UPDATE_RUNTIME_UNIT: "omp-pocket-runtime",
    // Демон рантайма настоящий: те же сокет и каталог состояния, что у апдейтера.
    OMP_RUNTIME_SOCKET: socket,
    OMP_RUNTIME_STATE_DIR: runtimeStateDir,
    OMP_CHAOS_BUN: BUN,
    OMP_CHAOS_RUNTIME_MAIN: RUNTIME_MAIN,
    OMP_CHAOS_RUNTIME_LOG: logPath,
  };
  writeWorld(world);

  // Настоящий демон рантайма: панели сессий живут в его PTY, поэтому сценарии
  // проверяют тот же код, что и прод, а не подделку сокета.
  const spec: RuntimeDaemonSpec = { socket, stateDir: runtimeStateDir, bun: BUN, main: RUNTIME_MAIN, logPath, env: { HOME: home, PATH: binPath, OMP_CHAOS_ROOT: dir } };
  const runtimePid = spawnRuntimeDaemon(spec);
  await waitRuntimeHealth(socket);
  withWorld((current) => {
    current.runtime.pid = runtimePid;
  });

  // Сессии мира: в каталоге сессии поднимается панель рантайма, в ней — живой
  // процесс фейкового omp. Свой pid процесс регистрирует в мире сам: collab-реестр
  // по нему считает хост живым, а апдейтер доказывает, что сессия работает на
  // новом бинаре.
  for (const seed of options.seeds ?? []) {
    const cwd = join(dir, seed.cwd);
    mkdirSync(cwd, { recursive: true });
    const bucket = join(sessionsRoot, "-chaos");
    mkdirSync(bucket, { recursive: true });
    const sessionFile = join(bucket, `2026-10-24T10-00-00-000Z_${seed.sessionId}.jsonl`);
    writeFileSync(sessionFile, sessionJsonl(seed.transcript));
    const argv = [join(binDir, "omp"), "--cwd", cwd, "--allow-home", "--restore", sessionFile];
    const created = await runtimeCall<{ pane: { id: string } }>(socket, "pane.create", { cwd, name: seed.sessionId });
    // Запись сессии появляется в мире ДО запуска процесса: процесс сам находит её
    // по файлу сессии и вписывает туда свой pid — иначе он бы её не увидел.
    withWorld((current) => {
      current.sessions.push({
        sessionId: seed.sessionId,
        pid: 0,
        cwd,
        sessionFile,
        model: seed.model ?? "fake/model",
        busy: seed.busy ?? false,
        inputRequired: seed.inputRequired ?? false,
        paneId: created.pane.id,
      });
    });
    await runtimeCall(socket, "pane.run", { paneId: created.pane.id, argv, sessionFile });
    await runtimeCall(socket, "pane.bind", { paneId: created.pane.id, sessionId: seed.sessionId, instanceId: `i-${seed.sessionId}`, sessionFile, launchArgv: argv, status: "idle" });
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const pending = readWorld().sessions.filter((session) => session.pid <= 0).length;
    if (pending === 0) break;
    if (Date.now() > deadline) throw new Error(`chaos: процессы сессий не зарегистрировались (ждут: ${pending})`);
    await Bun.sleep(20);
  }
  // Лог подъёмов начинаем с нуля: сценарии считают только то, что сделало обновление.
  withWorld((current) => {
    current.runs = [];
    current.prompts = [];
  });

  return {
    dir,
    home,
    repoDir,
    stateDir,
    binDir,
    worldPath,
    sessionsRoot,
    socket,
    env: binEnv,
    readWorld,
    writeWorld,
    withWorld,
    stopRuntime: () => stopRuntimeDaemon(readWorld().runtime.pid),
    readJob: (jobId) => readJobFile(join(stateDir, "jobs", `${jobId}.json`)),
    readEvents: (jobId) => readJournal(join(stateDir, "jobs", `${jobId}.jsonl`)),
    runOrchestrator: async (component, jobId, extraArgs = [], extraEnv = {}) => {
      const proc = Bun.spawn([process.execPath, ORCHESTRATOR, "--component", component, "--job", jobId, ...extraArgs], {
        env: { ...process.env, ...binEnv, ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    },
  };
}

/** Пути апдейтера, указывающие на chaos-корень: сервис шлюза тестируется на своём
 * демоне рантайма — без живого systemd и хостового omp. */
export function pathsFor(root: ChaosRoot): UpdatePaths {
  return {
    stateDir: root.env["OMP_UPDATE_STATE_DIR"] ?? join(root.repoDir, "gateway", "update"),
    backupsDir: join(root.dir, "backups"),
    repoDir: root.repoDir,
    appDistDir: join(root.repoDir, "app", "dist"),
    ompBin: join(root.binDir, "omp"),
    runtimeUnit: "omp-pocket-runtime",
    runtimeSocket: root.socket,
    bunBin: join(root.binDir, "bun-fake"),
    gitBin: join(root.binDir, "git"),
    shBin: "/bin/sh",
    systemctlBin: join(root.binDir, "systemctl"),
    systemdRun: join(root.binDir, "systemd-run-fake"),
    gatewayUnit: "omp-pocket-gateway",
    ompConfigPath: join(root.home, ".omp", "agent", "config.yml"),
    gatewayConfigPath: join(root.repoDir, "gateway", "config.json"),
    subscriptionsPath: join(root.repoDir, "gateway", "subscriptions.json"),
    appPackageJsonPath: join(root.repoDir, "app", "package.json"),
    gatewayPackageJsonPath: join(root.repoDir, "gateway", "package.json"),
    buildOrigin: root.env["PI_BUILD_URL"] ?? "https://build.stencil.io",
  };
}

/** Убить все процессы, чья командная строка или рабочий каталог указывают внутрь
 * chaos-корня: процессы сессий поднимает демон рантайма, а оболочки панелей висят
 * в каталоге сессии — их pid'ов тест не знает. */
export function killProcessesUnder(dir: string): number {
  let killed = 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(join("/proc", entry, "cmdline"), "utf8");
    } catch {
      continue;
    }
    const cwd = (() => {
      try {
        return readlinkSync(join("/proc", entry, "cwd"));
      } catch {
        return null;
      }
    })();
    const underCwd = cwd !== null && (cwd === dir || cwd.startsWith(`${dir}/`));
    if ((!cmdline.includes(dir) && !underCwd) || cmdline.includes("killProcessesUnder")) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
      killed += 1;
    } catch {
      // уже мёртв
    }
  }
  return killed;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function startReleaseServer(options: { version?: string; payload?: Uint8Array; declaredSha?: string; fail?: boolean } = {}): ReleaseServer {
  const version = options.version ?? "18.13.0";
  const cacheDir = join(tmpdir(), "omp-chaos-cache");
  mkdirSync(cacheDir, { recursive: true });
  const binaryPath = fakeBinaryForVersion(version, cacheDir);
  let payload: Uint8Array = options.payload ?? new Uint8Array(readFileSync(binaryPath));
  let declaredSha = options.declaredSha ?? sha256Bytes(payload);
  let fail = options.fail ?? false;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (fail) return new Response("boom", { status: 500 });
      if (url.pathname.startsWith("/api/products/omp/")) {
        return Response.json({
          build: {
            version,
            commit: "f".repeat(40),
            channel: "stable",
            files: [
              { name: "omp-linux-x64", platform: "linux", arch: "x86_64", kind: "archive", size: payload.byteLength, sha256: declaredSha, url: "/d/omp" },
              { name: "omp-linux-arm64", platform: "linux", arch: "arm64", kind: "archive", size: payload.byteLength, sha256: declaredSha, url: "/d/omp-arm" },
            ],
          },
        });
      }
      if (url.pathname === "/d/omp") return new Response(payload as unknown as BodyInit);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    setPayload: (next, sha) => {
      payload = next;
      declaredSha = sha ?? sha256Bytes(next);
    },
    stop: () => server.stop(true),
  };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Фейковый шлюз: /api/health отдаёт pid и buildSha из world.json, `/` — index.html из dist. */
export function startFakeGateway(root: ChaosRoot): GatewayServer {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const world = root.readWorld();
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, pid: world.gateway.pid, buildSha: world.gateway.buildSha, startedAt: "2026-10-24T10:00:00Z", ompVersion: world.ompVersion });
      }
      if (url.pathname === "/") {
        const indexPath = join(root.repoDir, "app", "dist", "index.html");
        if (!existsSync(indexPath)) return new Response("no dist", { status: 503 });
        return new Response(readFileSync(indexPath, "utf8"), { headers: { "content-type": "text/html" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  // конфиг шлюза в chaos-мире указывает на этот порт
  writeFileSync(join(root.repoDir, "gateway", "config.json"), JSON.stringify({ token: "chaos-token", port: server.port, host: "127.0.0.1" }));
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
