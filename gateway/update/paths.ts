import { join, resolve } from "node:path";
import { runtimeSocketPath } from "../runtime/protocol.ts";

/** Все пути апдейтера в одном месте. Переопределяются env'ами, чтобы chaos-набор
 * гонял оркестратор в изолированном каталоге с фейковыми бинарями. */
export interface UpdatePaths {
  /** Корень состояния апдейтера (jobs/, lock, ACTIVE). */
  stateDir: string;
  /** Бэкапы конфигов — ВНЕ репозитория: в них токены. */
  backupsDir: string;
  /** Каталог репозитория (git pull / bun install / build). */
  repoDir: string;
  /** Каталог собранного PWA (app/dist). */
  appDistDir: string;
  ompBin: string;
  /** Юнит рантайма панелей: его апдейтер перезапускает и проверяет. */
  runtimeUnit: string;
  /** Сокет рантайма — тот же, что берёт клиент шлюза (`OMP_RUNTIME_SOCKET`). */
  runtimeSocket: string;
  bunBin: string;
  gitBin: string;
  shBin: string;
  systemctlBin: string;
  /** systemd-run для запуска оркестратора отдельным юнитом. */
  systemdRun: string;
  /** Юнит шлюза, который перезапускается после обновления кода. */
  gatewayUnit: string;
  ompConfigPath: string;
  gatewayConfigPath: string;
  subscriptionsPath: string;
  appPackageJsonPath: string;
  gatewayPackageJsonPath: string;
  /** Origin build-сервиса (PI_BUILD_URL у omp). */
  buildOrigin: string;
}

const HOME = process.env["HOME"] ?? "/home/vincentfox";

function envPath(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" ? resolve(raw) : fallback;
}

export function defaultPaths(): UpdatePaths {
  const repoDir = envPath("OMP_UPDATE_REPO_DIR", join(HOME, "omp-mobile"));
  return {
    stateDir: envPath("OMP_UPDATE_STATE_DIR", join(repoDir, "gateway", "update")),
    backupsDir: envPath("OMP_UPDATE_BACKUPS_DIR", join(HOME, ".local", "state", "omp-pocket", "updates")),
    repoDir,
    appDistDir: join(repoDir, "app", "dist"),
    ompBin: envPath("OMP_UPDATE_OMP_BIN", join(HOME, ".local", "bin", "omp")),
    runtimeUnit: process.env["OMP_UPDATE_RUNTIME_UNIT"] ?? "omp-pocket-runtime",
    runtimeSocket: envPath("OMP_RUNTIME_SOCKET", runtimeSocketPath()),
    bunBin: envPath("OMP_UPDATE_BUN_BIN", join(HOME, ".bun", "bin", "bun")),
    gitBin: envPath("OMP_UPDATE_GIT_BIN", "/usr/bin/git"),
    shBin: envPath("OMP_UPDATE_SH_BIN", "/bin/sh"),
    systemctlBin: envPath("OMP_UPDATE_SYSTEMCTL_BIN", "/usr/bin/systemctl"),
    systemdRun: envPath("OMP_UPDATE_SYSTEMD_RUN", "/usr/bin/systemd-run"),
    gatewayUnit: process.env["OMP_UPDATE_GATEWAY_UNIT"] ?? "omp-pocket-gateway",
    ompConfigPath: join(HOME, ".omp", "agent", "config.yml"),
    gatewayConfigPath: join(repoDir, "gateway", "config.json"),
    subscriptionsPath: join(repoDir, "gateway", "subscriptions.json"),
    appPackageJsonPath: join(repoDir, "app", "package.json"),
    gatewayPackageJsonPath: join(repoDir, "gateway", "package.json"),
    buildOrigin: process.env["PI_BUILD_URL"] ?? "https://build.stencil.so",
  };
}

export function jobsDir(p: UpdatePaths): string {
  return join(p.stateDir, "jobs");
}

export function jobStatePath(p: UpdatePaths, jobId: string): string {
  return join(jobsDir(p), `${jobId}.json`);
}

export function jobJournalPath(p: UpdatePaths, jobId: string): string {
  return join(jobsDir(p), `${jobId}.jsonl`);
}

export function jobArtifactsDir(p: UpdatePaths, jobId: string): string {
  return join(jobsDir(p), jobId);
}

/** Файл «идёт обновление»: его читает pocket-watchdog, чтобы не рестартовать шлюз посреди джоба. */
export function activeMarkerPath(p: UpdatePaths): string {
  return join(p.stateDir, "ACTIVE");
}

export function lockPath(p: UpdatePaths): string {
  return join(p.stateDir, "update.lock");
}
