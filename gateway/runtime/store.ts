/**
 * Durable-состояние рантайма: `panes.json` (запись на каждое изменение, атомарно).
 *
 * Панели переживают рестарт рантайма и перезагрузку машины: при старте демон
 * читает список и поднимает те, у которых `desiredRunning` (закрытые
 * пользователем панели не воскресают).
 */

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePane } from "./protocol.ts";

export interface StoredPane extends RuntimePane {
  desiredRunning: boolean;
  /** Время старта оболочки: отличает нашу панель от чужого процесса с тем же pid. */
  shellStartTime: string;
}

export class PaneStore {
  readonly path: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error("runtime state directory may not be symlink");
    chmodSync(dir, 0o700);
    this.path = join(dir, "panes.json");
  }

  load(): StoredPane[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, "utf8")) as { version?: unknown; panes?: unknown };
    if (data.version !== 1 || !Array.isArray(data.panes)) throw new Error("unsupported or corrupt runtime state");
    for (const pane of data.panes) {
      if (pane === null || typeof pane !== "object") throw new Error("corrupt runtime pane");
      const record = pane as Partial<StoredPane>;
      if (typeof record.id !== "string" || typeof record.cwd !== "string" || !Array.isArray(record.launchArgv) || typeof record.desiredRunning !== "boolean") {
        throw new Error("corrupt runtime pane");
      }
    }
    return data.panes as StoredPane[];
  }

  /** tmp + fsync + rename: обрыв питания не оставляет половину файла. */
  save(panes: StoredPane[]): void {
    const temp = join(this.dir, `panes.${process.pid}.tmp`);
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, panes }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
    const directory = openSync(this.dir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
