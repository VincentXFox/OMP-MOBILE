import { describe, expect, test } from "bun:test";
import type { TurnState } from "../classify.ts";
import { newRecoveryState, type LogicalSession } from "../model.ts";
import { continuationPrompt, continueSession, relaunchCommand, restartSession, shellQuote, type SessionControl } from "../resume.ts";
import { launchArgvOf } from "../checkpoint.ts";

function turn(patch: Partial<TurnState>): TurnState {
  return {
    status: "closed_by_signal",
    lastAt: null,
    exit: { kind: "signal", reason: "sigterm", at: "2026-10-24T10:00:00Z", pending: 1 },
    unresolved: [],
    pendingAtExit: [],
    needsContinuation: true,
    lastAssistantStop: "aborted",
    openTodos: [],
    ...patch,
  };
}

function session(patch: Partial<LogicalSession> = {}): LogicalSession {
  return {
    logicalId: "/work::s-1",
    sessionId: "s-1",
    cwd: "/work",
    files: ["/sessions/s-1.jsonl"],
    lazy: false,
    model: "deepseek/x",
    label: "демо",
    paneId: "w1:p1",
    launchArgv: ["omp", "--cwd", "/work", "--allow-home", "--model", "deepseek/x"],
    pid: 4242,
    turn: turn({}),
    awaitingApproval: false,
    recovery: newRecoveryState(),
    updatedAt: "2026-10-24T10:00:00Z",
    ...patch,
  };
}

interface FakeState {
  alive: Set<number>;
  foreground: Record<string, string | null>;
  runs: Array<{ pane: string; command: string }>;
  prompts: Array<{ pane: string; text: string }>;
  live: Set<string>;
  killed: Array<{ pid: number; signal: string }>;
  pollsUntilLive: number;
}

function fakeControl(state: FakeState, options: { shellStuck?: boolean } = {}): SessionControl {
  let clock = 0;
  return {
    isAlive: (pid) => state.alive.has(pid),
    kill: (pid, signal) => {
      state.killed.push({ pid, signal });
      state.alive.delete(pid);
      // умерший omp возвращает панель оболочке
      for (const pane of Object.keys(state.foreground)) state.foreground[pane] = "bash";
    },
    paneForeground: async (pane) => (options.shellStuck === true ? "omp" : (state.foreground[pane] ?? "bash")),
    runInPane: async (pane, command) => {
      state.runs.push({ pane, command });
      state.foreground[pane] = "omp";
    },
    submitPrompt: async (pane, text) => {
      state.prompts.push({ pane, text });
    },
    sessionLiveInCwd: async () => state.live.size > 0,
    sessionLive: async (sessionId) => {
      if (state.pollsUntilLive > 0) {
        state.pollsUntilLive -= 1;
        return false;
      }
      return state.live.has(sessionId);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("политика перезапуска сессии", () => {
  test("останавливает процесс, ждёт оболочку и поднимает --restore в той же панели", async () => {
    const live = new Set<number>([4242]);
    const state: FakeState = { alive: live, foreground: { "w1:p1": "omp" }, runs: [], prompts: [], live: new Set(["s-1"]), killed: [], pollsUntilLive: 0 };
    const control = fakeControl(state);
    const s = session();
    const outcome = await restartSession(s, control);
    expect(state.killed[0]).toEqual({ pid: 4242, signal: "SIGTERM" });
    expect(state.runs[0]?.command).toContain("--restore");
    expect(state.runs[0]?.command).toContain("/sessions/s-1.jsonl");
    expect(outcome.session.recovery.relaunched).toBe(true);
    expect(outcome.session.recovery.registered).toBe(true);
    expect(outcome.session.recovery.blocked).toBeNull();
  });

  test("ожидание подтверждения пользователя — сессия блокируется, процесс не убивается", async () => {
    const state: FakeState = { alive: new Set([4242]), foreground: { "w1:p1": "omp" }, runs: [], prompts: [], live: new Set(["s-1"]), killed: [], pollsUntilLive: 0 };
    const outcome = await restartSession(session({ awaitingApproval: true }), fakeControl(state));
    expect(outcome.session.recovery.blocked).toContain("подтверждения");
    expect(state.killed).toHaveLength(0);
    expect(state.runs).toHaveLength(0);
  });

  test("панель не вернулась к оболочке — блокировка вместо слепого ввода команды", async () => {
    const state: FakeState = { alive: new Set([4242]), foreground: {}, runs: [], prompts: [], live: new Set(["s-1"]), killed: [], pollsUntilLive: 0 };
    const outcome = await restartSession(session(), fakeControl(state, { shellStuck: true }));
    expect(outcome.session.recovery.blocked).toContain("не вернулась к оболочке");
    expect(state.runs).toHaveLength(0);
  });

  test("сессия не зарегистрировалась за отведённое время — блокировка с причиной", async () => {
    const state: FakeState = { alive: new Set([4242]), foreground: { "w1:p1": "bash" }, runs: [], prompts: [], live: new Set<string>(), killed: [], pollsUntilLive: 0 };
    const outcome = await restartSession(session(), fakeControl(state));
    expect(outcome.session.recovery.registered).toBe(false);
    expect(outcome.session.recovery.blocked).toContain("не зарегистрировалась");
  });

  test("без панели перезапуск невозможен — явная блокировка", async () => {
    const state: FakeState = { alive: new Set([4242]), foreground: {}, runs: [], prompts: [], live: new Set(), killed: [], pollsUntilLive: 0 };
    const outcome = await restartSession(session({ paneId: null }), fakeControl(state));
    expect(outcome.session.recovery.blocked).toContain("нет панели");
  });
});

describe("продолжение после восстановления", () => {
  test("промпт содержит запрет повтора опасных операций и перечисляет их", async () => {
    const text = continuationPrompt(
      session({
        turn: turn({
          pendingAtExit: [{ toolName: "bash", toolCallId: "c1", command: "git push --force", path: null, intent: null, at: null }],
        }),
      }),
      "18.12.1",
      "18.12.6",
    );
    expect(text).toContain("18.12.1 → 18.12.6");
    expect(text).toContain("проверь её фактический результат");
    expect(text).toContain("git push --force");
    expect(text).toContain("СТАТУС: BLOCKED");
  });

  test("продолжение уходит только для восстановленной сессии", async () => {
    const state: FakeState = { alive: new Set(), foreground: {}, runs: [], prompts: [], live: new Set(), killed: [], pollsUntilLive: 0 };
    const notRegistered = await continueSession(session(), fakeControl(state), null, null);
    expect(notRegistered.session.recovery.continued).toBe(false);
    expect(state.prompts).toHaveLength(0);

    const registered = await continueSession(
      session({ recovery: { ...newRecoveryState(), registered: true } }),
      fakeControl(state),
      null,
      null,
    );
    expect(registered.session.recovery.continued).toBe(true);
    expect(state.prompts[0]?.pane).toBe("w1:p1");
  });
});

describe("сборка команды перезапуска", () => {
  test("launchArgvOf убирает --continue/--resume/--restore и их значения", () => {
    const argv = launchArgvOf(["omp", "--cwd", "/work", "--allow-home", "--continue", "--resume", "/s.jsonl", "--model", "p/m"]);
    expect(argv).toEqual(["omp", "--cwd", "/work", "--allow-home", "--model", "p/m"]);
  });
  test("launchArgvOf preserves exact boundaries, Unicode and empty argument values", () => {
    expect(launchArgvOf(["omp", "--cwd", "/work/Рабочая папка", "--thinking", "", "--resume=/sessions/a b.jsonl", "--model", "p/m"]))
      .toEqual(["omp", "--cwd", "/work/Рабочая папка", "--thinking", "", "--model", "p/m"]);
  });
  test("argv с пробелами и кириллицей кавычится, --resume заменяется на --restore", () => {
    const command = relaunchCommand(
      session({ cwd: "/home/user/Шаблоны", launchArgv: ["omp", "--cwd", "/home/user/Шаблоны", "--allow-home"] }),
    );
    expect(command).toContain("'/home/user/Шаблоны'");
    expect(command).toContain("--restore");
    expect(shellQuote(["omp", "a b"])).toBe("omp 'a b'");
    expect(shellQuote(["it's"])).toBe("'it'\\''s'");
  });

  test("без известного файла сессии используется --continue", () => {
    expect(relaunchCommand(session({ files: [] }))).toContain("--continue");
  });

  test("одноразовые селекторы из старого argv не попадают в --restore", () => {
    const command = relaunchCommand(
      session({ launchArgv: ["omp", "--cwd", "/work", "--allow-home", "--continue", "--model", "m/x"] }),
    );
    expect(command).not.toContain("--continue ");
    expect(command.endsWith("--restore /sessions/s-1.jsonl")).toBe(true);
  });
});
