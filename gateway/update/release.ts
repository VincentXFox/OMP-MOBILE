import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { arch } from "node:process";
import { basename, join } from "node:path";
import { exec } from "./exec.ts";

export interface BuildFile {
  name: string;
  platform: string;
  arch: string;
  kind: string;
  size: number;
  sha256: string;
  url: string;
}

export interface OmpBuild {
  version: string;
  commit: string;
  channel: string;
  file: BuildFile | null;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** Платформа/арх в терминах build-сервиса omp (`linux`, `linux-musl`, `macos`, `windows`). */
export function buildTarget(platform: NodeJS.Platform = process.platform, cpuArch: string = arch, musl?: boolean): string {
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : muscle(platform, musl);
  const cpu = cpuArch === "x64" ? "x86_64" : cpuArch === "arm64" ? "arm64" : cpuArch;
  return `${os}-${cpu}`;
}

function muscle(platform: NodeJS.Platform, musl?: boolean): string {
  if (platform !== "linux") return platform;
  const isMusl = musl ?? (existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1"));
  return isMusl ? "linux-musl" : "linux";
}

/** Версия → каталог релиза. `latest` — текущая рекомендуемая сборка канала. */
/** Версия из метаданных попадает в пути и URL: принимаем только строгий формат. */
export function safeVersion(value: string): string {
  const trimmed = value.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/.test(trimmed)) {
    throw new Error(`недопустимый номер версии от build-сервиса: ${value}`);
  }
  return trimmed;
}

export function buildUrl(origin: string, target: string, version: string | null, channel: "stable" | "canary" = "stable"): string {
  const base = origin.replace(/\/+$/, "");
  return version === null
    ? `${base}/api/products/omp/latest/${target}?channel=${channel}`
    : `${base}/api/products/omp/versions/${encodeURIComponent(safeVersion(version))}/${target}`;
}

function parseBuildFile(value: unknown): BuildFile | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["name"] !== "string" || typeof v["platform"] !== "string" || typeof v["url"] !== "string") return null;
  if (typeof v["size"] !== "number" || typeof v["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(v["sha256"])) return null;
  return {
    name: v["name"],
    platform: v["platform"],
    arch: typeof v["arch"] === "string" ? v["arch"] : "",
    kind: typeof v["kind"] === "string" ? v["kind"] : "archive",
    size: v["size"],
    sha256: v["sha256"],
    url: v["url"],
  };
}

/** Метаданные сборки + выбранный под эту машину файл. Ошибка сети/формата — исключение:
 * вслепую ставить «что-то» нельзя, иначе обновление недоказуемо. */
export async function fetchOmpBuild(origin: string, version: string | null, target: string, timeoutMs = 20_000): Promise<OmpBuild> {
  const url = buildUrl(origin, target, version);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`build-сервис ${url}: HTTP ${res.status}`);
  const parsed = (await res.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("build" in parsed)) throw new Error(`build-сервис ${url}: нет поля build`);
  const build = (parsed as Record<string, unknown>)["build"];
  if (typeof build !== "object" || build === null) throw new Error(`build-сервис ${url}: build не объект`);
  const b = build as Record<string, unknown>;
  if (typeof b["version"] !== "string") throw new Error(`build-сервис ${url}: нет версии`);
  const files = Array.isArray(b["files"]) ? b["files"].map(parseBuildFile).filter((f): f is BuildFile => f !== null) : [];
  const platform = target.slice(0, target.lastIndexOf("-"));
  const cpu = target.slice(target.lastIndexOf("-") + 1);
  const file = files.find((f) => f.platform === platform && (f.arch === cpu || f.arch === (cpu === "x86_64" ? "x64" : cpu))) ?? null;
  return {
    version: b["version"],
    commit: typeof b["commit"] === "string" ? b["commit"] : "",
    channel: typeof b["channel"] === "string" ? b["channel"] : "stable",
    file,
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Скачивание с проверкой размера и SHA-256. Файл пишется во временный путь и
 * удаляется при любом расхождении: непроверенный бинарь не должен существовать. */
/** URL файла: абсолютный только https и на том же хосте, что origin (иначе — даунгрейд/MITM). */
export function resolveArtifactUrl(origin: string, fileUrl: string): string {
  const base = origin.replace(/\/+$/, "");
  if (!fileUrl.startsWith("http")) return `${base}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`;
  const originUrl = new URL(base);
  const artifact = new URL(fileUrl);
  const localOrigin = originUrl.protocol === "http:"; // локальный тестовый стенд
  if (artifact.protocol !== "https:" && !(localOrigin && artifact.protocol === "http:")) {
    throw new IntegrityError(`недопустимая схема артефакта: ${artifact.protocol}`);
  }
  if (artifact.host !== originUrl.host) {
    throw new IntegrityError(`артефакт на чужом хосте: ${artifact.host} (ожидался ${originUrl.host})`);
  }
  return artifact.toString();
}

export async function downloadVerified(
  origin: string,
  file: BuildFile,
  destPath: string,
  timeoutMs = 600_000,
): Promise<{ path: string; size: number; sha256: string }> {
  const url = resolveArtifactUrl(origin, file.url);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`загрузка ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new IntegrityError(`размер не совпал для ${file.name}: получено ${bytes.byteLength}, ожидалось ${file.size}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== file.sha256) {
    throw new IntegrityError(`SHA-256 не совпал для ${file.name}: получено ${digest}, ожидалось ${file.sha256}`);
  }
  const fd = openSync(destPath, "w", 0o755);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(destPath, 0o755);
  return { path: destPath, size: bytes.byteLength, sha256: digest };
}

/** Атомарная установка бинаря: предыдущий сохраняется (rollback без сети). */
export function installBinary(
  verifiedPath: string,
  ompBin: string,
  previousCopy: string | null,
  expectedSha?: string,
): { installedSha: string; previousSha: string | null } {
  const installedSha = sha256File(verifiedPath);
  // Проверяем ещё раз перед подменой: между загрузкой и установкой файл могли подменить (D4).
  if (expectedSha !== undefined && installedSha !== expectedSha) {
    throw new IntegrityError(`файл установки изменён: sha256 ${installedSha}, ожидался ${expectedSha}`);
  }
  let previousSha: string | null = null;
  if (existsSync(ompBin)) {
    previousSha = sha256File(ompBin);
    if (previousCopy !== null) {
      copyFileSync(ompBin, previousCopy);
      chmodSync(previousCopy, 0o755);
    }
  }
  const staged = join(join(ompBin, ".."), `.${basename(ompBin)}.new-${process.pid}`);
  copyFileSync(verifiedPath, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, ompBin);
  return { installedSha, previousSha };
}

export function restoreBinary(previousCopy: string, ompBin: string, expectedSha?: string): void {
  if (!existsSync(previousCopy)) throw new Error(`нет сохранённого предыдущего бинаря: ${previousCopy}`);
  if (expectedSha !== undefined) {
    const actual = sha256File(previousCopy);
    if (actual !== expectedSha) {
      throw new IntegrityError(`сохранённый бинарь не совпадает с ожидаемым: ${actual} ≠ ${expectedSha}`);
    }
  }
  const staged = join(join(ompBin, ".."), `.${basename(ompBin)}.rollback-${process.pid}`);
  copyFileSync(previousCopy, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, ompBin);
}

export async function binaryVersion(binPath: string, timeoutMs = 20_000): Promise<string | null> {
  const res = await exec([binPath, "--version"], { timeoutMs });
  if (res.code !== 0) return null;
  const match = /^omp\/(\d+\.\d+\.\d+)\s*$/m.exec(res.stdout.trim());
  return match?.[1] ?? null;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // нет файла — и не нужно
  }
}
