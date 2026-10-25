import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySession, isDangerousTool } from "../classify.ts";

function sessionFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-classify-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function assistant(stopReason: string, toolCalls: Array<{ id: string; name: string; command?: string }> = [], at = "2026-10-24T10:00:00.000Z"): unknown {
  return {
    type: "message",
    timestamp: at,
    message: {
      role: "assistant",
      stopReason,
      content: toolCalls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.command === undefined ? {} : { command: call.command } })),
    },
  };
}

function toolResult(id: string, name = "bash", at = "2026-10-24T10:00:01.000Z"): unknown {
  return { type: "message", timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "done" }] } };
}

function toolStart(id: string, name: string, args: Record<string, unknown>, at = "2026-10-24T10:00:00.500Z"): unknown {
  return { type: "custom", customType: "tool_execution_start", timestamp: at, data: { toolCallId: id, toolName: name, startedAt: at, args, intent: "test" } };
}

function exit(kind: string, reason: string, pendingToolCalls: unknown[] = []): unknown {
  return { type: "custom", customType: "session_exit", timestamp: "2026-10-24T10:05:00.000Z", data: { kind, reason, recordedAt: "2026-10-24T10:05:00.000Z", pendingToolCalls } };
}

function user(): unknown {
  return { type: "message", message: { role: "user", content: "next task" } };
}

describe("классификация турна по транскрипту", () => {
  test("старый exit не продолжает уже завершённый новый запрос", () => {
    const state = classifySession(sessionFile([exit("signal", "sigterm"), user(), assistant("stop")]));
    expect(state.status).toBe("finished");
    expect(state.exit).toBe(null);
    expect(state.needsContinuation).toBe(false);
  });

  test("SIGTERM простаивающей завершённой сессии не создаёт новую работу", () => {
    const state = classifySession(sessionFile([user(), assistant("stop"), exit("signal", "sigterm")]));
    expect(state.status).toBe("finished");
    expect(state.needsContinuation).toBe(false);
  });

  test("новый запрос после старого exit требует продолжения даже без toolCall", () => {
    const state = classifySession(sessionFile([assistant("stop"), exit("signal", "sigterm"), user()]));
    expect(state.status).toBe("in_flight");
    expect(state.exit).toBe(null);
    expect(state.needsContinuation).toBe(true);
  });

  test("генерация без инструментов и без exit требует продолжения", () => {
    const state = classifySession(sessionFile([user()]));
    expect(state.status).toBe("in_flight");
    expect(state.needsContinuation).toBe(true);
  });

  test("SIGTERM во время генерации без инструментов требует продолжения", () => {
    const state = classifySession(sessionFile([user(), exit("signal", "sigterm"), assistant("aborted")]));
    expect(state.status).toBe("closed_by_signal");
    expect(state.needsContinuation).toBe(true);
  });

  test("успешный ответ после exit закрывает прерванный турн", () => {
    const state = classifySession(sessionFile([user(), exit("signal", "sigterm"), assistant("stop")]));
    expect(state.status).toBe("finished");
    expect(state.needsContinuation).toBe(false);
  });

  test("новый запрос после exit не наследует незакрытые инструменты старого запуска", () => {
    const state = classifySession(sessionFile([
      assistant("toolUse", [{ id: "old", name: "bash" }]),
      exit("signal", "sigterm", [{ toolCallId: "old", toolName: "bash" }]),
      user(), assistant("stop"),
    ]));
    expect(state.status).toBe("finished");
    expect(state.unresolved).toEqual([]);
    expect(state.pendingAtExit).toEqual([]);
    expect(state.needsContinuation).toBe(false);
  });

  test("уточнение пользователя во время работы сохраняет незакрытые инструменты", () => {
    const state = classifySession(sessionFile([assistant("toolUse", [{ id: "active", name: "bash" }]), user()]));
    expect(state.unresolved.map((op) => op.toolName)).toEqual(["bash"]);
    expect(state.needsContinuation).toBe(true);
  });

  test("ручная отмена без exit не возобновляется", () => {
    const state = classifySession(sessionFile([user(), assistant("toolUse", [{ id: "manual-abort", name: "bash" }]), assistant("aborted")]));
    expect(state.needsContinuation).toBe(false);
  });

  test("нормальный выход с незакрытым инструментом сохраняет отказ от продолжения", () => {
    const state = classifySession(sessionFile([
      assistant("toolUse", [{ id: "cancelled", name: "bash" }]),
      exit("normal", "quit", [{ toolCallId: "cancelled", toolName: "bash" }]),
    ]));
    expect(state.status).toBe("aborted_by_user");
    expect(state.needsContinuation).toBe(false);
  });

  test("завершённый турн не требует продолжения", () => {
    const state = classifySession(sessionFile([assistant("stop"), toolResult("x"), assistant("stop", [], "2026-10-24T10:01:00.000Z")]));
    expect(state.status).toBe("finished");
    expect(state.needsContinuation).toBe(false);
  });

  test("турн в полёте: toolCall без результата — продолжение нужно", () => {
    const state = classifySession(sessionFile([assistant("toolUse", [{ id: "call-1", name: "bash", command: "rm -rf build" }])]));
    expect(state.status).toBe("in_flight");
    expect(state.unresolved.map((op) => op.toolName)).toEqual(["bash"]);
    expect(state.needsContinuation).toBe(true);
  });

  test("выход по SIGTERM (kind=signal) требует явного продолжения и отдаёт опасные операции", () => {
    const state = classifySession(
      sessionFile([
        assistant("toolUse", [{ id: "call-2", name: "bash", command: "git push" }]),
        exit("signal", "sigterm", [{ toolCallId: "call-2", toolName: "bash", args: { command: "git push" }, startedAt: "2026-10-24T10:00:00.500Z" }]),
        toolResult("call-2"),
        assistant("aborted"),
      ]),
    );
    expect(state.status).toBe("closed_by_signal");
    expect(state.needsContinuation).toBe(true);
    expect(state.pendingAtExit[0]?.command).toBe("git push");
    expect(state.exit?.reason).toBe("sigterm");
  });

  test("нормальный выход пользователя не продолжается автоматически", () => {
    const state = classifySession(sessionFile([assistant("stop"), exit("normal", "quit")]));
    expect(state.status).toBe("aborted_by_user");
    expect(state.needsContinuation).toBe(false);
  });

  test("краш без записи exit (пустой хвост после tool_start) — in_flight с незакрытым вызовом", () => {
    const state = classifySession(sessionFile([toolStart("call-3", "edit", { path: "/tmp/x.ts" })]));
    expect(state.status).toBe("in_flight");
    expect(state.unresolved[0]?.path).toBe("/tmp/x.ts");
  });

  test("открытые todo берутся из последнего user_todo_edit", () => {
    const todo = {
      type: "custom",
      customType: "user_todo_edit",
      timestamp: "2026-10-24T10:00:02.000Z",
      data: {
        phases: [
          { phase: "Работа", items: [{ content: "шаг 1", status: "completed" }, { content: "шаг 2", status: "pending" }] },
        ],
      },
    };
    const state = classifySession(sessionFile([assistant("stop"), todo]));
    expect(state.openTodos).toEqual(["шаг 2"]);
  });

  test("пустой файл и отсутствующий файл дают empty", () => {
    expect(classifySession(sessionFile([])).status).toBe("empty");
    expect(classifySession("/nonexistent/session.jsonl").status).toBe("empty");
  });

  test("опасные инструменты перечислены явно", () => {
    expect(isDangerousTool("bash")).toBe(true);
    expect(isDangerousTool("write")).toBe(true);
    expect(isDangerousTool("read")).toBe(false);
  });
});
