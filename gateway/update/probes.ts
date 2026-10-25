import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { runtimeHealth } from "../panes.ts";
import { procStat } from "../runtime/process.ts";

export interface OmpProcessProbe {
  pid: number;
  cmdline: string;
  /** Exact /proc argument boundaries; cmdline is display-only. */
  argv: string[];
  /** Kernel PID birth token guards against PID reuse. */
  startTime: string | null;
  /** Путь образа, с которым реально работает процесс (`/proc/<pid>/exe`). */
  exePath: string;
  /** Образ удалён с диска — процесс держит старую версию после подмены бинаря. */
  exeDeleted: boolean;
  exeInode: number;
  /** Файл сессии из argv (`--resume`/`--restore`), если он там есть. */
  sessionFile: string | null;
  cwd: string | null;
}

function readProc(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Все живые процессы omp (по argv[0] или по образу в ~/.local/bin). */
export function probeOmpProcesses(onlyPid?: number): OmpProcessProbe[] {
  const probes: OmpProcessProbe[] = [];
  let entries: string[];
  try {
    entries = onlyPid === undefined ? readdirSync("/proc") : [String(onlyPid)];
  } catch {
    return probes;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdlineRaw = readProc(join("/proc", entry, "cmdline"));
    if (cmdlineRaw === null) continue;
    const rawArgv = cmdlineRaw.split("\0");
    if (rawArgv.at(-1) === "") rawArgv.pop();
    if (rawArgv.length === 0 || rawArgv[0] === undefined) continue;
    // omp запускают прямо (argv[0] = путь к бинарю) или через интерпретатор
    // (bash <скрипт-omp>): оба вида — это процесс сессии.
    const interpreter = /(^|\/)(bash|sh|dash|zsh|bun|node)$/.test(rawArgv[0]);
    const argv = interpreter && rawArgv[1] !== undefined && rawArgv[1].endsWith("/omp") ? rawArgv.slice(1) : rawArgv;
    const isOmp = argv[0] === "omp" || (argv[0]?.endsWith("/omp") ?? false);
    if (!isOmp) continue;
    const pid = Number(entry);
    const exePath = (() => {
      try {
        return readlinkSync(join("/proc", entry, "exe"));
      } catch {
        return "";
      }
    })();
    const exeDeleted = exePath.endsWith(" (deleted)");
    const exeInode = (() => {
      try {
        return statSync(join("/proc", entry, "exe")).ino;
      } catch {
        return 0;
      }
    })();
    const sessionIdx = argv.findIndex((arg) => arg === "--resume" || arg === "--restore");
    const cwd = (() => {
      try {
        return readlinkSync(join("/proc", entry, "cwd"));
      } catch {
        return null;
      }
    })();
    probes.push({
      pid,
      cmdline: argv.join(" "),
      argv,
      startTime: procStat(pid)?.startTime ?? null,
      exePath: exePath.replace(/ \(deleted\)$/, ""),
      exeDeleted,
      exeInode,
      sessionFile: sessionIdx >= 0 ? (argv[sessionIdx + 1] ?? null) : null,
      cwd,
    });
  }
  return probes;
}

/** Образ конкретного процесса: по нему видно, на каком бинаре он реально работает. */
export function pidExe(pid: number): { path: string; inode: number; deleted: boolean } {
  const raw = (() => {
    try {
      return readlinkSync(join("/proc", String(pid), "exe"));
    } catch {
      return "";
    }
  })();
  const deleted = raw.endsWith(" (deleted)");
  const path = raw.replace(/ \(deleted\)$/, "");
  const inode = (() => {
    try {
      return statSync(join("/proc", String(pid), "exe")).ino;
    } catch {
      return 0;
    }
  })();
  return { path, inode, deleted };
}

export function fileInode(path: string): number {
  try {
    return statSync(path).ino;
  } catch {
    return 0;
  }
}

export interface GatewayHealth {
  pid: number;
  startedAt: string | null;
  buildSha: string | null;
  ompVersion: string | null;
  version: string | null;
}

/** Health-проба шлюза: pid и buildSha позволяют доказать, что ответил НОВЫЙ процесс,
 * а не переживший рестарт старый. */
export async function probeGatewayHealth(base: string, token: string | null, timeoutMs = 4_000): Promise<GatewayHealth | null> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/health`, {
      headers: token === null || token === "" ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    return {
      pid: typeof v["pid"] === "number" ? v["pid"] : 0,
      startedAt: typeof v["startedAt"] === "string" ? v["startedAt"] : null,
      buildSha: typeof v["buildSha"] === "string" ? v["buildSha"] : null,
      ompVersion: typeof v["ompVersion"] === "string" ? v["ompVersion"] : null,
      version: typeof v["version"] === "string" ? v["version"] : null,
    };
  } catch {
    return null;
  }
}

export interface AssetProbe {
  servedHash: string | null;
  diskHash: string | null;
  matches: boolean;
}

/** Фронтенд проверяется по факту отдачи: хэш `index.html` из HTTP сравнивается
 * с хэшем файла в app/dist. Иначе «собранный» dist остаётся непроверенным. */
export async function probeServedIndex(base: string, distIndexPath: string, token: string | null): Promise<AssetProbe> {
  const diskHash = (() => {
    try {
      return Bun.hash(readFileSync(distIndexPath)).toString(16);
    } catch {
      return null;
    }
  })();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/`, {
      headers: token === null || token === "" ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { servedHash: null, diskHash, matches: false };
    const body = await res.text();
    const servedHash = Bun.hash(body).toString(16);
    return { servedHash, diskHash, matches: diskHash !== null && servedHash === diskHash };
  } catch {
    return { servedHash: null, diskHash, matches: false };
  }
}

/** Проба рантайма панелей: тот же health, что спрашивает шлюз, — апдейтер видит
 * ровно то состояние, с которым работает приложение. Таймаут свой, а не только
 * клиентский: залипший сокет не должен держать проверку бесконечно. */
export async function probeRuntime(timeoutMs = 5_000): Promise<{ ok: boolean; detail: string }> {
  return Promise.race([
    runtimeHealth(),
    Bun.sleep(timeoutMs).then(() => ({ ok: false, detail: `health рантайма не ответил за ${Math.round(timeoutMs / 1000)} с` })),
  ]);
}

/** Готовность рантайма после рестарта: демон поднимается секундами позже выхода
 * `systemctl restart`, поэтому одиночная проба ловит ещё не слушающий сокет и
 * валит проверку (а вслед за ней — восстановление сессий). Ждём до таймаута. */
export async function waitRuntimeReady(timeoutMs = 30_000, pollMs = 1_000): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Сокет может быть ещё не создан: это такой же «не готов», как неотвечающий
    // демон, — ждём дальше, а не падаем.
    const probe = await probeRuntime().catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }));
    if (probe.ok) return probe;
    if (Date.now() >= deadline) {
      return { ok: false, detail: `${probe.detail} (после ожидания ${Math.round(timeoutMs / 1000)} с)` };
    }
    await Bun.sleep(pollMs);
  }
}

/** Живой ли TCP-порт: для релеев, у которых нет HTTP-health. */
export function probeTcp(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host, port });
  const done = (ok: boolean): void => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  return promise;
}

export function readPiWirePin(appPackageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(appPackageJsonPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const deps = (parsed as Record<string, unknown>)["dependencies"];
    if (typeof deps !== "object" || deps === null) return null;
    const pin = (deps as Record<string, unknown>)["@oh-my-pi/pi-wire"];
    return typeof pin === "string" ? pin : null;
  } catch {
    return null;
  }
}
