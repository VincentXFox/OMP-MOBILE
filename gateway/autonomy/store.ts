import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.ts";

/**
 * Хранилище автономных задач: один JSON-файл на задачу + индекс в памяти.
 *
 * Почему так, а не SQLite: состояний мало (десятки), читать их нужно целиком
 * при старте, а атомарная запись через tmp+rename даёт crash-безопасность без
 * схемы и миграций. Файлы переживают рестарт шлюза и выключение телефона —
 * задачи — серверные, клиент к ним отношения не имеет.
 */

const FILE_MODE = 0o600;

export class TaskStore {
  #dir: string;
  #tasks = new Map<string, Task>();
  #loaded = false;

  constructor(dir: string) {
    this.#dir = dir;
  }

  path(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  /** Чтение с диска при первом обращении: задачи, созданные до рестарта, живы. */
  load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    let names: string[] = [];
    try {
      names = readdirSync(this.#dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) this.#reload(name.replace(/\.json$/, ""));
  }

  #reload(id: string): Task | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(id), "utf8"));
      if (parsed === null || typeof parsed !== "object") return null;
      const task = parsed as Task;
      if (typeof task.id !== "string" || task.id !== id) return null;
      this.#tasks.set(id, task);
      return task;
    } catch {
      return null;
    }
  }

  get(id: string): Task | null {
    this.load();
    const cached = this.#tasks.get(id);
    if (cached !== undefined) return cached;
    return this.#reload(id);
  }

  list(): Task[] {
    this.load();
    return [...this.#tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Атомарная запись: сначала tmp, потом rename — читатель никогда не видит半-файл. */
  save(task: Task): Task {
    task.updatedAt = Date.now();
    mkdirSync(this.#dir, { recursive: true });
    const tmp = `${this.path(task.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(task, null, 1), { mode: FILE_MODE });
    renameSync(tmp, this.path(task.id));
    this.#tasks.set(task.id, task);
    return task;
  }

  delete(id: string): void {
    this.load();
    this.#tasks.delete(id);
    try {
      unlinkSync(this.path(id));
    } catch {
      // уже удалён
    }
  }

  /** Задачи, которые были в работе на момент падения: их нужно поднять. */
  resumable(): Task[] {
    return this.list().filter(
      (t) => t.status === "running" || t.status === "verifying" || t.status === "queued" || t.status === "awaiting_approval",
    );
  }
}

/** Каталог задач рядом с шлюзом: не в /tmp, переживает перезагрузку. */
export function tasksDir(gatewayDir: string): string {
  const configured = process.env.OMP_POCKET_TASKS_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  const dir = join(gatewayDir, "tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
