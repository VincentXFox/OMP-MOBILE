import { spawn } from "node:child_process";
import type { CheckSpec, Criterion, Evidence } from "./types.ts";

/**
 * Раннер проверок приёмки.
 *
 * Проверки — обычные команды, а не «модель сказала, что всё ок»: результат
 * фиксируется кодом выхода и наблюдаемым выводом, и только он закрывает критерий.
 * Модель не может отключить проверку — критерии и их команды лежат в задаче и
 * записываются до первого действия.
 */

const MAX_OUTPUT_TAIL = 1200;

export interface CheckOutcome {
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  error?: string;
}

/** Запуск одной проверки; таймаут убивает всю группу процессов команды. */
export async function runCheck(spec: CheckSpec, cwd: string): Promise<CheckOutcome> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? 120_000, 1_000), 900_000);
  const { promise, resolve } = Promise.withResolvers<CheckOutcome>();
  {
    let settled = false;
    const child = spawn("/bin/sh", ["-c", spec.command], { cwd, env: process.env, detached: true });
    let out = "";
    const append = (chunk: Buffer): void => {
      out += chunk.toString("utf8");
      if (out.length > 64_000) out = out.slice(-32_000); // хвост важнее начала
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve({
        ok: false,
        exitCode: null,
        output: tail(out),
        durationMs: Date.now() - started,
        error: `проверка не уложилась в ${Math.round(timeoutMs / 1000)} с`,
      });
    }, timeoutMs);

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${out}\n${error ?? ""}`;
      const exitOk = code === (spec.expectExit ?? 0);
      const containsOk = spec.expectContains === undefined || text.includes(spec.expectContains);
      const absentOk = spec.expectAbsent === undefined || !text.includes(spec.expectAbsent);
      resolve({
        ok: exitOk && containsOk && absentOk,
        exitCode: code,
        output: tail(out),
        durationMs: Date.now() - started,
        ...(error !== undefined ? { error } : {}),
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  }
  return promise;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_OUTPUT_TAIL ? `…${trimmed.slice(-MAX_OUTPUT_TAIL)}` : trimmed;
}

export interface VerifyReport {
  /** Критерии, которые закрылись именно сейчас. */
  newlyPassed: Criterion[];
  /** Критерии, которые всё ещё не проходят. */
  failures: { criterion: Criterion; outcome: CheckOutcome }[];
  /** Все проверки этого прогона (журнал EVIDENCE). */
  evidence: Evidence[];
  allPassed: boolean;
}

/**
 * Прогон проверок. `onlyOpen` — точечный прогон после изменения (быстро),
 * `false` — полный набор перед завершением (приёмка).
 */
export async function verify(
  criteria: readonly Criterion[],
  cwd: string,
  opts: { onlyOpen?: boolean } = {},
): Promise<VerifyReport> {
  const report: VerifyReport = { newlyPassed: [], failures: [], evidence: [], allPassed: true };
  for (const criterion of criteria) {
    if (opts.onlyOpen === true && criterion.passed) continue;
    if (criterion.check === undefined) {
      // Критерий без машинной проверки закрыть нельзя: он требует ручной оценки и
      // не должен молча считаться выполненным.
      report.failures.push({
        criterion,
        outcome: { ok: false, exitCode: null, output: "у критерия нет машинной проверки", durationMs: 0 },
      });
      report.allPassed = false;
      continue;
    }
    const outcome = await runCheck(criterion.check, cwd);
    report.evidence.push({
      at: Date.now(),
      criterionId: criterion.id,
      command: criterion.check.command,
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      output: outcome.output,
      durationMs: outcome.durationMs,
    });
    if (outcome.ok) {
      if (!criterion.passed) report.newlyPassed.push(criterion);
      criterion.passed = true;
      criterion.lastResult = outcome.output.slice(-300) || "ok";
      criterion.checkedAt = Date.now();
    } else {
      criterion.passed = false;
      criterion.lastResult = outcome.error ?? outcome.output.slice(-300);
      criterion.checkedAt = Date.now();
      report.failures.push({ criterion, outcome });
      report.allPassed = false;
    }
  }
  return report;
}

/** Краткая сводка для следующего промпта: агенту передаётся проблема, а не «продолжай». */
export function failuresToInstruction(report: VerifyReport): string {
  const lines = report.failures.slice(0, 8).map((f) => {
    const cmd = f.criterion.check?.command ?? "(нет проверки)";
    const tailText = (f.outcome.error ?? f.outcome.output).split("\n").slice(-4).join(" | ").slice(0, 300);
    return `- ${f.criterion.id}: ${f.criterion.statement}\n  проверка: ${cmd}\n  результат: ${f.outcome.exitCode === null ? "нет кода" : `exit ${f.outcome.exitCode}`} — ${tailText}`;
  });
  return lines.join("\n");
}
