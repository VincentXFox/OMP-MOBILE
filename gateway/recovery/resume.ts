import type { LogicalSession } from "./model.ts";
import type { DangerOp } from "./classify.ts";

/** Управление живыми сессиями — узкий интерфейс: прод-реализация ходит в панели
 * рантайма и реестр collab, тестовая — в фейки. Так политика восстановления
 * проверяема без хоста. */
export interface SessionControl {
  isAlive(pid: number): boolean;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Что сейчас в фокусе панели: "bash" = оболочка ждёт ввода. */
  paneForeground(paneId: string): Promise<string | null>;
  /** Набрать команду в панели и нажать Enter. */
  runInPane(paneId: string, command: string): Promise<void>;
  /** Отправить промпт агенту (TUI сам отправит по Enter). */
  submitPrompt(paneId: string, text: string): Promise<void>;
  /** Жив ли collab-хост сессии (pid + sessionId). */
  sessionLive(sessionId: string): Promise<boolean>;
  /** Есть ли живой агент в этом каталоге (для ленивых сессий без транскрипта). */
  sessionLiveInCwd(cwd: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface RecoveryOutcome {
  session: LogicalSession;
  events: Array<{ step: "kill" | "relaunch" | "register" | "continue" | "blocked" | "verify"; ok: boolean; detail: string }>;
}

export const KILL_WAIT_MS = 20_000;
export const SHELL_WAIT_MS = 25_000;
export const REGISTER_WAIT_MS = 45_000;
export const POLL_MS = 500;

/** POSIX-кавычки: argv собирается из живого процесса, в нём бывают пробелы и кириллица. */
export function shellQuote(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

export function relaunchCommand(session: LogicalSession): string {
  const file = session.files[session.files.length - 1] ?? null;
  const base = session.launchArgv.length > 0 ? session.launchArgv : ["omp", "--cwd", session.cwd, "--allow-home"];
  // страховка: одноразовые селекторы из исходного argv не должны пережить перезапуск
  const argv = base.filter((arg) => !["--continue", "-c", "--no-session"].includes(arg));
  if (file === null) {
    argv.push("--continue");
  } else {
    argv.push("--restore", file);
  }
  return shellQuote(argv);
}

/** Промпт-продолжение: явно запрещает повтор уже выполненных опасных операций и
 * автоподтверждение — восстановление не должно «доделывать» необратимое вслепую. */
export function continuationPrompt(session: LogicalSession, fromVersion: string | null, toVersion: string | null): string {
  const ops = inFlightOps(session);
  const versionLine = fromVersion === null ? "" : ` (обновление omp ${fromVersion} → ${toVersion ?? "?"})`;
  const opsLine =
    ops.length === 0
      ? "Незавершённых операций с побочными эффектами в полёте не было."
      : `В полёте на момент остановки: ${ops
          .map((op) => `${op.toolName}${op.command === null ? "" : `(${op.command.slice(0, 120)})`}${op.path === null ? "" : ` ${op.path}`}`)
          .join("; ")}.`;
  return [
    `[OMP Pocket] Сессию перезапустили${versionLine}, транскрипт восстановлен через --restore.`,
    "Продолжи незавершённую задачу с того места, где она остановилась, и доведи её до конца.",
    "Правила восстановления:",
    "1) перед повтором любой операции с побочным эффектом проверь её фактический результат (перечитай файл, проверь состояние системы/гита) — уже выполненное не повторяй;",
    "2) ничего опасного не подтверждай автоматически: если нужно разрешение пользователя, задай вопрос и остановись;",
    "3) если безопасное продолжение невозможно, ответь ровно строкой `СТАТУС: BLOCKED` и укажи конкретную причину.",
    opsLine,
  ].join("\n");
}

export function inFlightOps(session: LogicalSession): DangerOp[] {
  if (session.turn === null) return [];
  const seen = new Set<string>();
  const ops: DangerOp[] = [];
  for (const op of [...session.turn.pendingAtExit, ...session.turn.unresolved]) {
    const key = `${op.toolName}:${op.toolCallId ?? `${op.command ?? ""}:${op.path ?? ""}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(op);
  }
  return ops;
}

/** Перезапуск процесса сессии в той же панели: SIGTERM (транскрипт закрывается
 * штатно) → ожидание оболочки → `omp … --restore <file>`. */
export async function restartSession(
  session: LogicalSession,
  control: SessionControl,
  onEvent?: (e: RecoveryOutcome["events"][number]) => void,
  options: { waitRegistration?: boolean } = {},
): Promise<RecoveryOutcome> {
  const events: RecoveryOutcome["events"] = [];
  const emit = (step: RecoveryOutcome["events"][number]["step"], ok: boolean, detail: string): void => {
    const event = { step, ok, detail };
    events.push(event);
    onEvent?.(event);
  };
  if (session.awaitingApproval) {
    session.recovery.blocked = "сессия ждёт подтверждения пользователя — автоперезапуск не выполняется";
    emit("blocked", false, session.recovery.blocked);
    return { session, events };
  }
  if (session.paneId === null) {
    session.recovery.blocked = "нет панели: нечего перезапускать";
    emit("blocked", false, session.recovery.blocked);
    return { session, events };
  }
  const pid = session.pid;
  if (pid !== null && control.isAlive(pid)) {
    control.kill(pid, "SIGTERM");
    const deadline = control.now() + KILL_WAIT_MS;
    while (control.isAlive(pid) && control.now() < deadline) await control.sleep(POLL_MS);
    if (control.isAlive(pid)) {
      control.kill(pid, "SIGKILL");
      const hardDeadline = control.now() + 5_000;
      while (control.isAlive(pid) && control.now() < hardDeadline) await control.sleep(POLL_MS);
    }
    session.recovery.killed = !control.isAlive(pid);
    emit("kill", session.recovery.killed, session.recovery.killed ? `pid ${pid} остановлен` : `pid ${pid} не завершился`);
  } else {
    session.recovery.killed = true;
    emit("kill", true, "прежний процесс уже мёртв");
  }

  const shellDeadline = control.now() + SHELL_WAIT_MS;
  for (;;) {
    const fg = await control.paneForeground(session.paneId);
    if (fg === "bash" || fg === null) break;
    if (control.now() >= shellDeadline) {
      session.recovery.blocked = `панель ${session.paneId} не вернулась к оболочке (в фокусе: ${fg ?? "?"})`;
      emit("blocked", false, session.recovery.blocked);
      return { session, events };
    }
    await control.sleep(POLL_MS);
  }

  await control.runInPane(session.paneId, relaunchCommand(session));
  session.recovery.relaunched = true;
  emit("relaunch", true, `панель ${session.paneId}: ${relaunchCommand(session)}`);

  if (options.waitRegistration === false) {
    emit("register", true, "регистрация не ожидается (быстрый перезапуск при откате)");
    return { session, events };
  }
  const registerDeadline = control.now() + REGISTER_WAIT_MS;
  while (control.now() < registerDeadline) {
    if (session.lazy ? await control.sessionLiveInCwd(session.cwd) : await control.sessionLive(session.sessionId)) {
      session.recovery.registered = true;
      emit("register", true, `сессия ${session.sessionId} зарегистрирована заново`);
      return { session, events };
    }
    await control.sleep(1_000);
  }
  session.recovery.blocked = `сессия ${session.sessionId} не зарегистрировалась за ${Math.round(REGISTER_WAIT_MS / 1000)} с после --restore`;
  emit("blocked", false, session.recovery.blocked);
  return { session, events };
}

/** Ожидание регистрации уже перезапущенной сессии (фаза RESTORING): сама
 * перезапуск-фаза не блокирует пайплайн на 45 с из-за одной медленной панели. */
export async function awaitRegistration(session: LogicalSession, control: SessionControl, timeoutMs = REGISTER_WAIT_MS): Promise<boolean> {
  const deadline = control.now() + timeoutMs;
  while (control.now() < deadline) {
    // у ленивой сессии нет транскрипта и прежнего sessionId в реестре не будет:
    // достаточно живого агента в том же каталоге
    if (session.lazy ? await control.sessionLiveInCwd(session.cwd) : await control.sessionLive(session.sessionId)) {
      session.recovery.registered = true;
      return true;
    }
    await control.sleep(POLL_MS);
  }
  session.recovery.blocked = `сессия ${session.sessionId} не зарегистрировалась за ${Math.round(timeoutMs / 1000)} с после --restore`;
  return false;
}

/** Продолжение турна, который omp не доигрывает сам (выход по SIGTERM).
 * Промпт уходит только когда агент готов (не busy и не ждёт подтверждения). */
export async function continueSession(session: LogicalSession, control: SessionControl, fromVersion: string | null, toVersion: string | null): Promise<RecoveryOutcome> {
  const events: RecoveryOutcome["events"] = [];
  const emit = (step: RecoveryOutcome["events"][number]["step"], ok: boolean, detail: string): void => {
    events.push({ step, ok, detail });
  };
  if (session.paneId === null || !session.recovery.registered) {
    session.recovery.blocked = "сессия не восстановлена — продолжение невозможно";
    emit("blocked", false, session.recovery.blocked);
    return { session, events };
  }
  await control.submitPrompt(session.paneId, continuationPrompt(session, fromVersion, toVersion));
  session.recovery.continued = true;
  emit("continue", true, "отправлен промпт-продолжение с проверкой предыдущих результатов");
  return { session, events };
}
