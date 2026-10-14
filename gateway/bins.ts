import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Единый источник абсолютных путей до внешних бинарников: голые имена в
// Bun.spawn зависят от PATH процесса gateway (юнит задает PATH, но это
// митигация — здесь независимость).
const cache = new Map<string, string>();

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBin(name: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const line = stdout.trim().split("\n")[0]?.trim() ?? "";
    return line !== "" && isExecutable(line) ? line : null;
  } catch {
    return null;
  }
}

/** Абсолютный путь к бинарнику: `which` при первом вызове, fallback ~/.local/bin/<имя>, кэш. */
export async function resolveBin(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  const found = (await whichBin(name)) ?? (() => {
    const fallback = join(homedir(), ".local/bin", name);
    return isExecutable(fallback) ? fallback : null;
  })();
  if (!found) throw new Error(`не найден в PATH и в ~/.local/bin/${name}`);
  cache.set(name, found);
  return found;
}
