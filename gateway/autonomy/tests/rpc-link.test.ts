import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpcLink, rpcLinkFactory, type OmpRpcLinkOptions, type TurnUsage } from "../rpc-link.ts";
import type { ApprovalRequest } from "../links.ts";
import type { Task } from "../types.ts";

/**
 * Двойник omp: тот же NDJSON, что у настоящего v18.10.4, но без модели и сети.
 * Сценарии выбираются текстом промпта — так один скрипт проверяет корреляцию,
 * сборку хода, дельту расхода, approval round-trip, abort и «процесс не отвечает».
 */

const FAKE_OMP = String.raw`#!__BUN__
const write = (o) => process.stdout.write(JSON.stringify(o) + "\n");
write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

let tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let cost = 0;
let approvals = [];
let pendingPromptId = null;
let hang = false;
const approvalPrompt = new Map();

function bump(d) {
  tokens.input += d.input; tokens.output += d.output;
  tokens.cacheRead += d.cacheRead; tokens.cacheWrite += d.cacheWrite;
  tokens.total += d.input + d.output + d.cacheRead + d.cacheWrite;
  cost = Math.round((cost + d.cost) * 1e6) / 1e6;
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

function finishTurn(id, text) {
  write({ type: "message_end", message: assistant(text) });
  write({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash",
    result: { content: [{ type: "text", text: "command failed: exit 1" }] }, isError: true });
  write({ type: "agent_end", messages: [assistant(text)], isTerminal: true, yielded: true });
  write({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
}

function handle(f) {
  switch (f.type) {
    case "get_session_stats":
      write({ type: "response", id: f.id, command: "get_session_stats", success: true, data: {
        sessionId: "fake", tokens: { ...tokens }, cost,
        contextUsage: { tokens: 9916, contextWindow: 1000000, percent: 0.99 } } });
      return;
    case "get_state":
      write({ type: "response", id: f.id, command: "get_state", success: true, data: {
        model: { provider: "fake", id: "fake" }, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "prompt": {
      write({ type: "response", id: f.id, command: "prompt", success: true, data: { agentInvoked: true } });
      const msg = String(f.message);
      if (msg.includes("report")) {
        const text = JSON.stringify(approvals);
        write({ type: "message_end", message: assistant(text) });
        write({ type: "agent_end", messages: [assistant(text)], isTerminal: true, yielded: true });
        write({ type: "prompt_result", id: f.id, agentInvoked: true, status: "completed", sessionSettled: true });
        return;
      }
      if (msg.includes("hang")) {
        hang = true;
        pendingPromptId = f.id;
        // Детерминированный признак «prompt принят»: approval-кадр доходит до
        // хоста только после admission, поэтому тесту не нужны паузы.
        write({ type: "extension_ui_request", id: "gate-hang", method: "select",
          title: "Gate", options: ["Approve", "Deny"] });
        return;
      }
      if (msg.includes("abort-me")) {
        pendingPromptId = f.id;
        write({ type: "extension_ui_request", id: "gate-abort", method: "select",
          title: "Gate", options: ["Approve", "Deny"] });
        return;
      }
      if (msg.includes("approve")) {
        const uiId = "ui-" + (approvals.length + 1);
        approvalPrompt.set(uiId, f.id);
        write({ type: "extension_ui_request", id: uiId, method: "select",
          title: "Allow tool: bash\nrm -rf build", options: ["Approve", "Deny"], timeout: 60000 });
        return;
      }
      bump({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: 0.001 });
      finishTurn(f.id, "turn done: " + msg);
      return;
    }
    case "extension_ui_response": {
      approvals.push({ id: f.id, value: f.value, confirmed: f.confirmed, cancelled: f.cancelled });
      const promptId = approvalPrompt.get(f.id);
      if (promptId !== undefined) {
        approvalPrompt.delete(f.id);
        bump({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.0001 });
        finishTurn(promptId, "approved via " + String(f.value ?? f.confirmed));
      }
      return;
    }
    case "abort": {
      if (hang) return; // сценарий «процесс не отвечает»: ни ответа, ни prompt_result
      if (pendingPromptId !== null) {
        const id = pendingPromptId;
        pendingPromptId = null;
        write({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
        write({ type: "prompt_result", id, agentInvoked: true, status: "aborted", sessionSettled: true });
      }
      write({ type: "response", id: f.id, command: "abort", success: true, data: {} });
      return;
    }
    default:
      return;
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim().length > 0) handle(JSON.parse(line));
    nl = buffer.indexOf("\n");
  }
}
`;

let workDir = "";
let scriptPath = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "omp-rpc-link-"));
  scriptPath = join(workDir, "fake-omp");
  writeFileSync(scriptPath, FAKE_OMP.replace("__BUN__", process.execPath));
  chmodSync(scriptPath, 0o755);
});

afterAll(() => {
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true });
});

async function makeLink(overrides: Partial<OmpRpcLinkOptions> = {}): Promise<OmpRpcLink> {
  const link = new OmpRpcLink({
    bin: scriptPath,
    cwd: workDir,
    model: "fake/model",
    readyTimeoutMs: 5_000,
    commandTimeoutMs: 500,
    turnTimeoutMs: 5_000,
    closeTimeoutMs: 2_000,
    ...overrides,
  });
  await link.start();
  return link;
}

function nextApproval(link: OmpRpcLink): Promise<ApprovalRequest> {
  const { promise, resolve } = Promise.withResolvers<ApprovalRequest>();
  link.onApproval(resolve);
  return promise;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("OmpRpcLink", () => {
  test("стартует rpc-ui с --approval-mode always-ask, cwd и моделью задачи", async () => {
    const task = {
      id: "t1",
      goal: "проверка",
      cwd: workDir,
      model: "fake/task-model",
    } as Task;
    const link = (await rpcLinkFactory({ bin: scriptPath, readyTimeoutMs: 5_000 })(task)) as OmpRpcLink;
    try {
      expect(link.pid).not.toBeNull();
      const argv = readFileSync(`/proc/${link.pid}/cmdline`, "utf8").split("\0");
      expect(argv).toContain("--mode");
      expect(argv[argv.indexOf("--mode") + 1]).toBe("rpc-ui");
      expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("always-ask");
      expect(argv[argv.indexOf("--cwd") + 1]).toBe(workDir);
      expect(argv[argv.indexOf("--model") + 1]).toBe("fake/task-model");
      expect(argv).not.toContain("--no-ui");
    } finally {
      await link.close();
    }
  }, 15_000);

  test("собирает TurnOutcome по id и считает дельту расхода”, а не накопленный итог", async () => {
    const link = await makeLink();
    try {
      const first = await link.prompt("hello");
      expect(first.status).toBe("completed");
      expect(first.text).toBe("turn done: hello");
      expect(first.toolFailures).toHaveLength(1);
      expect(first.toolFailures[0]).toContain("bash");
      expect(first.toolFailures[0]).toContain("command failed: exit 1");
      expect(first.usage.inputTokens).toBe(100);
      expect(first.usage.outputTokens).toBe(20);
      expect(first.usage.cacheReadTokens).toBe(5);
      expect(first.usage.cacheWriteTokens).toBe(3);
      expect((first.usage as TurnUsage).costUsd).toBeCloseTo(0.001, 6);

      // Второй ход: counters в omp уже 200/40, но delta снова 100/20.
      const second = await link.prompt("hello again");
      expect(second.usage.inputTokens).toBe(100);
      expect(second.usage.outputTokens).toBe(20);
      expect((second.usage as TurnUsage).costUsd).toBeCloseTo(0.001, 6);
    } finally {
      await link.close();
    }
  }, 15_000);

  test("approval round-trip: select → answerApproval(allow) → value Approve", async () => {
    const link = await makeLink();
    try {
      const approval = nextApproval(link);
      const turn = link.prompt("please approve rm");
      const request = await approval;
      expect(request.title).toBe("Allow tool: bash");
      expect(request.detail).toBe("rm -rf build");
      await link.answerApproval(request.id, "allow");
      const outcome = await turn;
      expect(outcome.status).toBe("completed");
      expect(outcome.text).toBe("approved via Approve");
      expect(outcome.usage.inputTokens).toBe(10);

      const report = await link.prompt("report");
      expect(JSON.parse(report.text)).toEqual([{ id: request.id, value: "Approve" }]);
    } finally {
      await link.close();
    }
  }, 15_000);

  test("approval round-trip: deny отправляет Deny", async () => {
    const link = await makeLink();
    try {
      const approval = nextApproval(link);
      const turn = link.prompt("approve again");
      const request = await approval;
      await link.answerApproval(request.id, "deny");
      const outcome = await turn;
      expect(outcome.text).toBe("approved via Deny");
      const report = JSON.parse((await link.prompt("report")).text);
      expect(report).toEqual([{ id: request.id, value: "Deny" }]);
    } finally {
      await link.close();
    }
  }, 15_000);

  test("abort превращает ход в status aborted", async () => {
    const link = await makeLink();
    try {
      const admitted = nextApproval(link);
      const turn = link.prompt("abort-me");
      // Approval-кадр приходит только после admission — это и есть сигнал,
      // что abort уже не может быть отброшен как «вход до приёма».
      await admitted;
      await link.abort();
      const outcome = await turn;
      expect(outcome.status).toBe("aborted");
      expect(outcome.error).toBeUndefined();
    } finally {
      await link.close();
    }
  }, 15_000);

  test("abort не висит на молчащем процессе: таймаут и kill группы", async () => {
    const link = await makeLink({ commandTimeoutMs: 300 });
    const pid = link.pid;
    expect(pid).not.toBeNull();
    try {
      const admitted = nextApproval(link);
      const turn = link.prompt("hang forever");
      await admitted;
      const started = Date.now();
      await link.abort();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(link.alive).toBe(false);
      const outcome = await turn;
      expect(outcome.status).toBe("error");
      await link.close();
      // Группа убита: процесса нет ни в каком состоянии.
      expect(link.exitCode).not.toBeNull();
      expect(isAlive(pid!)).toBe(false);
    } finally {
      await link.close();
    }
  }, 15_000);

  test("close идемпотентен и доводит процесс до выхода с кодом 0", async () => {
    const link = await makeLink();
    const pid = link.pid!;
    await link.prompt("hello");
    await Promise.all([link.close(), link.close(), link.close()]);
    expect(link.alive).toBe(false);
    expect(link.exitCode).toBe(0);
    expect(isAlive(pid)).toBe(false);
    // prompt после close не бросает: контроллер получает честную ошибку связи.
    const outcome = await link.prompt("after close");
    expect(outcome.status).toBe("error");
    expect(outcome.usage.inputTokens).toBe(0);
  }, 15_000);
});
