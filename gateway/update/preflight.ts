import { statfsSync, accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { exec } from "./exec.ts";
import type { UpdatePaths } from "./paths.ts";
import { fetchOmpBuild, buildTarget } from "./release.ts";
import { readPiWirePin } from "./probes.ts";

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const MIN_FREE_DEFAULT = 3 * 1024 * 1024 * 1024;

/** Порог свободного места; env нужен chaos-набору, чтобы проверить отказ без
 * реального заполнения диска. */
export function minFreeBytes(): number {
  const raw = process.env["OMP_UPDATE_MIN_FREE_BYTES"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MIN_FREE_DEFAULT;
}

/** Свободное место там, где реально пишутся артефакты: каталог состояния,
 * бинарь omp и node_modules репозитория. */
export function freeSpaceCheck(paths: UpdatePaths): CheckResult {
  const targets: Array<[string, string]> = [
    ["state", paths.stateDir],
    ["omp", dirname(paths.ompBin)],
    ["repo", paths.repoDir],
  ];
  let minFree = Number.POSITIVE_INFINITY;
  let minPath = "";
  for (const [label, path] of targets) {
    try {
      const stat = statfsSync(path);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < minFree) {
        minFree = free;
        minPath = `${label}:${path}`;
      }
    } catch (err) {
      return {
        id: "disk",
        label: "Свободное место",
        ok: false,
        detail: `не удалось прочитать ФС ${label}:${path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} ГиБ`;
  return {
    id: "disk",
    label: "Свободное место",
    ok: minFree >= minFreeBytes(),
    detail: `минимум ${gib(minFree)} на ${minPath} (требуется ${gib(minFreeBytes())})`,
  };
}

function executableCheck(id: string, label: string, path: string): CheckResult {
  if (!existsSync(path)) return { id, label, ok: false, detail: `нет файла ${path}` };
  try {
    accessSync(path, constants.X_OK);
    return { id, label, ok: true, detail: path };
  } catch {
    return { id, label, ok: false, detail: `нет права на исполнение: ${path}` };
  }
}

export function dependencyChecks(paths: UpdatePaths): CheckResult[] {
  return [
    executableCheck("bun", "bun", paths.bunBin),
    executableCheck("git", "git", paths.gitBin),
    executableCheck("systemctl", "systemctl", paths.systemctlBin),
    executableCheck("sh", "sh", paths.shBin),
    executableCheck("omp", "текущий omp", paths.ompBin),
  ];
}

/** Совместимость протокола collab: major.minor omp должен совпадать с пином pi-wire приложения. */
export function compatibilityCheck(paths: UpdatePaths, targetVersion: string | null): CheckResult {
  const pin = readPiWirePin(paths.appPackageJsonPath);
  if (pin === null || targetVersion === null) {
    return { id: "compat", label: "Совместимость протокола", ok: false, detail: `не удалось сопоставить: omp ${targetVersion ?? "?"}, pi-wire ${pin ?? "?"}` };
  }
  const ompPair = /^(\d+)\.(\d+)\./.exec(targetVersion);
  const wirePair = /^(\d+)\.(\d+)\./.exec(pin);
  if (ompPair === null || wirePair === null) {
    return { id: "compat", label: "Совместимость протокола", ok: false, detail: `нечитаемые версии: omp ${targetVersion}, pi-wire ${pin}` };
  }
  const ok = ompPair[1] === wirePair[1] && ompPair[2] === wirePair[2];
  return {
    id: "compat",
    label: "Совместимость протокола",
    ok,
    detail: ok
      ? `omp ${targetVersion} ↔ pi-wire ${pin} (${ompPair[1]}.${ompPair[2]}.x)`
      : `omp ${targetVersion} ↔ pi-wire ${pin}: протокол может отличаться, обнови приложение`,
  };
}

export interface ReleaseCheck {
  check: CheckResult;
  version: string | null;
  sha256: string | null;
}

/** Источник релиза и целостность: метаданные сборки должны быть получены ДО установки. */
export async function releaseSourceCheck(paths: UpdatePaths, version: string | null, target = buildTarget()): Promise<ReleaseCheck> {
  try {
    const build = await fetchOmpBuild(paths.buildOrigin, version, target);
    if (build.file === null) {
      return {
        check: { id: "release", label: "Источник релиза", ok: false, detail: `нет файла для ${target} в сборке ${build.version}` },
        version: build.version,
        sha256: null,
      };
    }
    return {
      check: {
        id: "release",
        label: "Источник релиза",
        ok: true,
        detail: `${build.version} (${build.commit.slice(0, 7)}) ${build.file.name}: ${build.file.size} Б, sha256 ${build.file.sha256.slice(0, 12)}…`,
      },
      version: build.version,
      sha256: build.file.sha256,
    };
  } catch (err) {
    return {
      check: { id: "release", label: "Источник релиза", ok: false, detail: err instanceof Error ? err.message : String(err) },
      version: null,
      sha256: null,
    };
  }
}

/** URL без userinfo: в логи и артефакты не должны попадать токены из remote (E3). */
export function safeRemote(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]+@/u, "//<скрыто>@");
  }
}

export async function gitRemoteCheck(paths: UpdatePaths): Promise<CheckResult> {
  const res = await exec([paths.gitBin, "remote", "get-url", "origin"], { cwd: paths.repoDir, timeoutMs: 10_000 });
  if (res.code !== 0) return { id: "git", label: "Git-источник", ok: false, detail: "remote origin не настроен — обновление кода недоступно" };
  const url = safeRemote(res.stdout.trim());
  const ls = await exec([paths.gitBin, "ls-remote", "--heads", "origin"], { cwd: paths.repoDir, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  return {
    id: "git",
    label: "Git-источник",
    ok: ls.code === 0,
    detail: ls.code === 0 ? `${url}: доступен` : `${url}: ${ls.stderr.trim().slice(0, 200) || `код ${ls.code}`}`,
  };
}

export function summarize(checks: readonly CheckResult[]): { ok: boolean; failed: CheckResult[] } {
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, failed };
}
