/**
 * Процессы панели: чтение /proc вместо `herdr pane process-info`.
 *
 * Идентичность панели держится на pid оболочки + времени её старта
 * (`/proc/<pid>/stat`, поле starttime): pid переиспользуется ОС, поэтому пара
 * «pid + starttime» — единственный способ не принять чужой процесс за свой.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { ProcessEntry, ProcessInfo } from "./protocol.ts";

export interface ProcStat {
  pid: number;
  ppid: number;
  pgrp: number;
  session: number;
  tpgid: number;
  startTime: string;
  name: string;
}

/** Разбор /proc/<pid>/stat: имя процесса может содержать пробелы и скобки,
 * поэтому режем по последней ')'. */
export function procStat(pid: number): ProcStat | null {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = value.lastIndexOf(")");
    if (end < 0) return null;
    const fields = value.slice(end + 2).split(" ");
    return {
      pid,
      ppid: Number(fields[1]),
      pgrp: Number(fields[2]),
      session: Number(fields[3]),
      tpgid: Number(fields[5]),
      startTime: fields[19] ?? "",
      name: value.slice(value.indexOf("(") + 1, end),
    };
  } catch {
    return null;
  }
}

/** Процессы панели: оболочка и всё её потомство (включая фоновые хелперы).
 * Владельца определяем по дереву процессов, а не по cwd: два агента в одном
 * каталоге — обычное дело, и угадывание по cwd отправляло бы ввод чужому. */
export function processInfo(shellPid: number, startTime?: string): ProcessInfo {
  const shell = procStat(shellPid);
  if (shell === null || (startTime !== undefined && startTime !== "" && shell.startTime !== startTime)) {
    return { foreground_process_group_id: null, foreground_processes: [] };
  }
  const all: ProcStat[] = [];
  for (const id of readdirSync("/proc")) {
    if (!/^\d+$/.test(id)) continue;
    const stat = procStat(Number(id));
    if (stat !== null) all.push(stat);
  }
  const owned = new Set<number>([shellPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const proc of all) {
      if (!owned.has(proc.pid) && owned.has(proc.ppid)) {
        owned.add(proc.pid);
        changed = true;
      }
    }
  }
  const entries: ProcessEntry[] = [];
  for (const proc of all) {
    if (!owned.has(proc.pid)) continue;
    try {
      const argv = readFileSync(`/proc/${proc.pid}/cmdline`).toString().split("\0").filter(Boolean);
      entries.push({ pid: proc.pid, name: proc.name, argv, cmdline: argv.join(" "), cwd: readlinkSync(`/proc/${proc.pid}/cwd`) });
    } catch {
      // процесс завершился во время обхода
    }
  }
  return { foreground_process_group_id: shell.tpgid > 0 ? shell.tpgid : null, foreground_processes: entries };
}

/** pid+starttime совпадают — это тот самый процесс, а не переиспользованный pid. */
export function sameProcess(pid: number, startTime: string): boolean {
  if (pid <= 0 || startTime === "") return false;
  return procStat(pid)?.startTime === startTime;
}

/** Живой (не зомби) процесс: зомби ещё занимает pid, но уже не работает,
 * поэтому `kill(pid, 0)` по нему успешен и врёт про «жив». */
export function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    return stat.slice(end + 2, end + 3) !== "Z";
  } catch {
    return false;
  }
}
