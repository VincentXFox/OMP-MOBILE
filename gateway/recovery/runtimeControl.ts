import { listHosts } from "../hosts.ts";
import { paneForegroundName, sendPaneKeys, sendPaneText } from "../panes.ts";
import type { SessionControl } from "./resume.ts";

/** Прод-реализация SessionControl: панели рантайма + реестр collab. */
export function runtimeSessionControl(): SessionControl {
  return {
    isAlive(pid: number): boolean {
      if (pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
      try {
        process.kill(pid, signal);
      } catch {
        // процесс уже завершился
      }
    },
    async paneForeground(paneId: string): Promise<string | null> {
      // Панели нет/рантайм недоступен — как и раньше, это «фокуса не видно»:
      // решение принимает политика перезапуска, а не исключение из панели.
      return paneForegroundName(paneId).catch(() => null);
    },
    async runInPane(paneId: string, command: string): Promise<void> {
      // Команда приходит одной строкой, уже закавыченной POSIX-образом
      // (`shellQuote` в resume.ts): её надо набрать в оболочке панели и нажать
      // Enter. Через `runInPane` из panes.ts это делать нельзя — там argv
      // сохраняется в `launchArgv` панели, и последующий рестарт рантайма
      // отверг бы обёртку `/bin/sh -c …` как `unsafe_restore_argv`.
      await sendPaneKeys(paneId, ["ctrl+u"]);
      await sendPaneText(paneId, command);
      await sendPaneKeys(paneId, ["enter"]);
    },
    async submitPrompt(paneId: string, text: string): Promise<void> {
      await sendPaneText(paneId, text);
      await sendPaneKeys(paneId, ["enter"]);
    },
    async sessionLiveInCwd(cwd: string): Promise<boolean> {
      try {
        const out = await listHosts();
        return out.hosts.some((host) => host.alive && host.cwd === cwd);
      } catch {
        return false;
      }
    },
    async sessionLive(sessionId: string): Promise<boolean> {
      try {
        const out = await listHosts();
        return out.hosts.some((host) => host.sessionId === sessionId && host.alive);
      } catch {
        return false;
      }
    },
    sleep(ms: number): Promise<void> {
      return Bun.sleep(ms);
    },
    now(): number {
      return Date.now();
    },
  };
}
