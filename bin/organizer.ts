#!/usr/bin/env bun
// organizer — раскладка агентов по столовым папкам (~/OMP/<slug>) и фиксация
// ответственностей. Запускается суточным таймером omp-pocket-organizer.timer
// и вручную; из приложения то же самое делает POST /api/crew/organize.
//
//   organizer status            последний прогон, режим, следующий по расписанию
//   organizer run               разложить и применить
//   organizer run --dry-run     показать план, ничего не менять
//   organizer run --model X     указать модель для решения (fuzzy match omp)
//
// Exit codes: 0 ок; 1 раскладка не удалась; 2 битый конфиг шлюза (push не уйдёт).

import { loadConfig } from "../gateway/config.ts";
import { crewRoot, crewSnapshot } from "../gateway/crew.ts";
import { organizerStatus, runOrganizer } from "../gateway/organizer.ts";
import { PushManager } from "../gateway/push.ts";

const SUBSCRIPTIONS = new URL("../gateway/subscriptions.json", import.meta.url).pathname;
const CONFIG = new URL("../gateway/config.json", import.meta.url).pathname;

function usage(): void {
  process.stdout.write(`organizer — штат агентов: папки и ответственности

Usage:
  organizer status            последний прогон, режим, следующий по расписанию, столы
  organizer run [--dry-run]   разложить агентов по столам (--dry-run — только план)
  organizer run --model <id>  решать моделью <id> (по умолчанию модель omp)
  organizer -h | без команд   эта справка
`);
}

function stamp(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function statusCommand(): void {
  const state = organizerStatus();
  const crew = crewSnapshot();
  const lines = [
    `корень штата: ${crewRoot()}`,
    `столов: ${crew.desks.length} · привязок: ${Object.keys(crew.bindings).length}`,
    `последний прогон: ${stamp(state.lastRunAt)} (${state.lastTrigger ?? "—"}, ${state.lastMode ?? "—"})`,
    `следующий: ${stamp(state.nextRunAt)}${state.running ? " · сейчас идёт раскладка" : ""}`,
    `итог: ${state.lastSummary ?? "—"}${state.lastError !== null ? ` · ошибка: ${state.lastError}` : ""}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (crew.desks.length === 0) return;
  process.stdout.write("\n");
  for (const desk of crew.desks) {
    process.stdout.write(`${desk.slug}\t${desk.role}\t${desk.sessions.length} агент(ов)\t${desk.dir}\n`);
  }
}

async function notify(payload: { title: string; body: string; url: string }): Promise<void> {
  try {
    const push = new PushManager(loadConfig(CONFIG, {}), SUBSCRIPTIONS);
    await push.broadcast(payload);
  } catch (err) {
    process.stderr.write(`push: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "-h" || command === "--help") {
    usage();
    return;
  }
  if (command === "status") {
    statusCommand();
    return;
  }
  if (command !== "run") {
    usage();
    process.exitCode = 5;
    return;
  }
  const dryRun = rest.includes("--dry-run");
  const modelIndex = rest.indexOf("--model");
  const model = modelIndex >= 0 ? rest[modelIndex + 1] : undefined;
  const report = await runOrganizer({ trigger: dryRun ? "cli-dry" : "cli", dryRun, model, notify: dryRun ? undefined : notify });
  process.stdout.write(`${report.summary}\n`);
  for (const desk of report.desks) {
    process.stdout.write(`  ${desk.created ? "+" : "="} ${desk.slug} ← ${desk.sessions.length} агент(ов) · ${desk.role}\n`);
  }
  for (const error of report.errors) process.stdout.write(`  ! ${error}\n`);
  process.stdout.write(`за ${Math.round(report.durationMs / 100) / 10} с · режим ${report.mode}\n`);
  if (!report.ok) process.exitCode = 1;
}

await main();
