import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Атомарная и durable запись: tmp-файл в том же каталоге → fsync → rename → fsync каталога.
 * Нужна там, где обрыв процесса не должен оставить полфайла (журнал апдейта, чекпоинт сессий). */
export function writeFileDurable(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

export function writeJsonDurable(path: string, value: unknown): void {
  writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Дозапись строки в append-only журнал с fsync: потеря последней строки возможна,
 * но частично записанная строка не ломает чтение (читатель пропускает битый хвост). */
export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // каталог на ФС без поддержки fsync — durability остаётся best-effort
  }
}

export function writeTextBestEffort(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch {
    // диагностический файл, не критично
  }
}
