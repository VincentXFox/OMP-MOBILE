/**
 * Сопровождение панелей: то, что нужно делать на каждом опросе реестра.
 *
 * Три задачи:
 *  1. связать панель с живым collab-хостом (привязка теряется при рестарте
 *     рантайма: агент возвращается под новым instanceId) и взять инстанс под
 *     учёт шлюза — иначе «Остановить» в приложении отвечает «not_started_here»;
 *  2. дописать панели файл сессии, если его ещё нет — omp создаёт файл не
 *     мгновенно, а без файла панель нечем восстанавливать;
 *  3. довести турны, вернувшиеся после рестарта рантайма: демон поднимает панель
 *     и помечает её `restoredAt`, а omp сам продолжает только турн без
 *     `session_exit` — остальным нужен явный промпт продолжения.
 *
 * Раньше это были разные механизмы (одноразовый догон при старте агента и
 * проверка смены поколения), и оба могли «промахнуться» по времени: метку демон
 * ставит уже после рестарта, а агент регистрируется секундами позже. Проверка на
 * каждом опросе идемпотентна и таких промахов не делает.
 *
 * Промпт продолжения отправляется ровно один раз:
 * - проход по панели помечается в модульной карте `inFlight`, поэтому следующий
 *   тик опроса (и стартовый догон) не запустит второй проход, пока первый ждёт
 *   готовности сессии (до минуты);
 * - прямо перед отправкой метка `restoredAt` перечитывается у демона и
 *   сверяется со значением, взятым на входе в проход: если метку уже сняли
 *   (продолжение отправил другой проход или оркестратор обновления) или
 *   заменили (панель восстановлена заново) — промпт не шлём;
 * - метку снимает только определённый исход: продолжение отправлено, продолжать
 *   нечего или агента в панели нет. Транзиентные неудачи (панель не нашлась,
 *   сессия не стала idle, исключение) метку оставляют, но не более трёх попыток
 *   на панель — после этого метка снимается с записью в лог.
 */

import { bindPane, listPanes, panePids, paneProcesses, runtimeHealth, type ManagedPane, type PaneBinding } from "../panes.ts";
import { listHosts, type OmpHost } from "../hosts.ts";
import { findSessionFile } from "../sessions.ts";
import { adoptStartedInstance } from "../agents.ts";
import { continueAfterRestore } from "./afterRestore.ts";

export interface SweepOutcome {
  paneId: string;
  sessionId: string | null;
  continued: boolean;
  blocked: string | null;
}

/** Проходы продолжения, уже идущие по панели.
 *
 * Опрос живёт на `setInterval(5000)`, а `continueAfterRestore` ждёт до минуты:
 * без этой карты следующий тик увидел бы ту же метку `restoredAt` и запустил бы
 * второй проход по той же панели. Карта модульная, поэтому защищает и от
 * параллельного вызова — из стартового догона и из опроса. */
const inFlight = new Set<string>();

/** Транзиентные неудачи продолжения: метка восстановления, по которой шли
 * попытки, и их число. Метка в значении — чтобы новый рестарт рантайма не
 * наследовал счётчик прошлого восстановления. */
const attempts = new Map<string, { marker: number; count: number }>();

/** Предел повторов транзиентной неудачи: после него метку снимаем, иначе панель
 * крутилась бы в вечных повторах. */
const MAX_CONTINUATION_ATTEMPTS = 3;

/** Исходы продолжения, которые имеет смысл повторить на следующем проходе. */
const TRANSIENT_BLOCKS = [
  "панель восстановленной сессии не найдена",
  "сессия не стала idle за 30 с",
];

/** Снять метку восстановления, если она всё ещё та же.
 *
 * За время прохода метку могли сменить (панель восстановлена заново) — чужую
 * гасить нельзя. Если демон не ответил совсем, метку всё равно снимаем: иначе
 * после уже отправленного промпта следующий проход отправил бы его повторно. */
async function clearRestoredAt(paneId: string, marker: number): Promise<void> {
  let panes: ManagedPane[] | null = null;
  try {
    panes = await listPanes();
  } catch {
    panes = null;
  }
  const current = panes?.find((item) => item.paneId === paneId);
  if (current !== undefined && current.restoredAt !== marker) return;
  await bindPane(paneId, { restoredAt: null }).catch(() => undefined);
}

/** Окончательный исход (продолжение отправлено, продолжать нечего, агента нет,
 * повтор бессмысленен): метку снимаем, счётчик попыток забываем. */
async function settleContinuation(paneId: string, marker: number): Promise<void> {
  attempts.delete(paneId);
  await clearRestoredAt(paneId, marker);
}

/** Транзиентная неудача: метку оставляем, чтобы следующий проход попробовал
 * снова; после `MAX_CONTINUATION_ATTEMPTS` неудач снимаем её и пишем в лог. */
async function deferContinuation(paneId: string, marker: number, reason: string): Promise<void> {
  const previous = attempts.get(paneId);
  const count = previous !== undefined && previous.marker === marker ? previous.count + 1 : 1;
  if (count < MAX_CONTINUATION_ATTEMPTS) {
    attempts.set(paneId, { marker, count });
    return;
  }
  attempts.delete(paneId);
  await clearRestoredAt(paneId, marker);
  console.log(`[runtime] панель ${paneId}: продолжение не отправлено окончательно после ${MAX_CONTINUATION_ATTEMPTS} попыток (${reason})`);
}

/** Проход продолжения по одной восстановленной панели.
 *
 * `null` — проход пропущен: панель уже не несёт ту же метку восстановления
 * (продолжение отправил другой проход или оркестратор обновления, либо панель
 * восстановлена заново), поэтому промпт не шлём. */
async function followRestoredPane(pane: ManagedPane, marker: number, versions: { from: string | null; to: string | null }): Promise<SweepOutcome | null> {
  const fresh = (await listPanes().catch(() => [] as ManagedPane[])).find((item) => item.paneId === pane.paneId) ?? pane;
  const agentPid = await agentPidIn(pane.paneId, pane.shellPid);

  // Панель без агента или без файла сессии: продолжать нечего — исход окончательный.
  if (fresh.sessionFile === null || agentPid === null) {
    await settleContinuation(pane.paneId, marker);
    return { paneId: pane.paneId, sessionId: null, continued: false, blocked: null };
  }

  // Перепроверка прямо перед отправкой: пока шли запросы к демону (и пока другой
  // проход ждал готовности сессии), метку могли снять или заменить. Сравниваем
  // именно значение: метка-число уникальна на каждое восстановление.
  const current = (await listPanes().catch(() => [] as ManagedPane[])).find((item) => item.paneId === pane.paneId);
  if (current === undefined || current.restoredAt !== marker) return null;

  try {
    const outcome = await continueAfterRestore(current.sessionFile ?? fresh.sessionFile, current.cwd, agentPid, versions);
    const blocked = outcome.blocked;
    if (!outcome.continued && blocked !== null && TRANSIENT_BLOCKS.some((prefix) => blocked.startsWith(prefix))) {
      // Транзиентно: метку оставляем, следующий проход попробует снова.
      await deferContinuation(pane.paneId, marker, blocked);
    } else {
      // Продолжение отправлено, продолжать нечего (blocked === null) или отказ по
      // существу (ждёт подтверждения пользователя): метку снимаем окончательно.
      await settleContinuation(pane.paneId, marker);
    }
    return { paneId: pane.paneId, sessionId: outcome.sessionId, continued: outcome.continued, blocked: outcome.blocked };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Исключение — тоже транзиентный исход: метку оставляем до следующего прохода.
    await deferContinuation(pane.paneId, marker, message);
    return { paneId: pane.paneId, sessionId: null, continued: false, blocked: message };
  }
}

/** Процесс агента внутри панели: omp, а не оболочка панели. */
async function agentPidIn(paneId: string, shellPid: number): Promise<number | null> {
  const processes = await paneProcesses(paneId).catch(() => []);
  const agent = processes.find((proc) => proc.pid !== shellPid && proc.name.startsWith("omp"));
  const first = processes.find((proc) => proc.pid !== shellPid);
  return (agent ?? first)?.pid ?? null;
}

/** Живой хост этой панели. Точная привязка — по instanceId; если её нет (агент
 * вернулся под новым id), сверяем pid с деревом процессов панели: два агента в
 * одном каталоге — обычное дело, и угадывание по cwd связало бы чужого. */
async function hostOfPane(pane: ManagedPane, hosts: OmpHost[]): Promise<OmpHost | null> {
  const byInstance = hosts.find((host) => host.instanceId === pane.instanceId && host.alive);
  if (byInstance !== undefined) return byInstance;
  const pids = await panePids(pane.paneId).catch(() => [] as number[]);
  const byPid = hosts.find((host) => host.alive && pids.includes(host.pid));
  if (byPid !== undefined) return byPid;
  const bySession = hosts.find((host) => host.alive && pane.sessionId !== null && host.sessionId === pane.sessionId);
  return bySession ?? null;
}

/** Current registry state, including a model switched after original startup. */
export function runtimeBindingForHost(pane: ManagedPane, host: OmpHost): PaneBinding | null {
  const sessionFile = pane.sessionFile ?? host.sessionFile;
  const status = host.busy ? "working" : host.inputRequired ? "blocked" : "idle";
  const model = `${host.model.provider}/${host.model.id}`;
  if (pane.instanceId === host.instanceId && pane.sessionId === host.sessionId && pane.sessionFile === sessionFile && pane.status === status && pane.awaitingApproval === host.inputRequired && pane.model === model) return null;
  return { instanceId: host.instanceId, sessionId: host.sessionId, sessionFile, awaitingApproval: host.inputRequired, status, model };
}

/** Связать панели с живыми хостами и взять их инстансы под учёт шлюза. */
async function syncPaneHosts(panes: ManagedPane[], hosts: OmpHost[]): Promise<number> {
  let synced = 0;
  for (const pane of panes) {
    if (pane.status === "closed") continue;
    const host = await hostOfPane(pane, hosts);
    if (host === null) continue;
    adoptStartedInstance(host.instanceId);
    const binding = runtimeBindingForHost(pane, host);
    if (binding === null) continue;
    await bindPane(pane.paneId, binding).catch(() => undefined);
    synced += 1;
  }
  return synced;
}

/** Дописать панелям файл сессии, когда omp его создаст. */
async function bindMissingSessionFiles(panes: ManagedPane[], hosts: OmpHost[]): Promise<number> {
  let bound = 0;
  for (const pane of panes) {
    if (pane.sessionFile !== null || pane.sessionId === null) continue;
    const host = hosts.find((item) => item.instanceId === pane.instanceId) ?? hosts.find((item) => item.sessionId === pane.sessionId);
    const file = host?.sessionFile ?? findSessionFile(pane.sessionId);
    if (file === null || file === undefined) continue;
    await bindPane(pane.paneId, { sessionFile: file }).catch(() => undefined);
    bound += 1;
  }
  return bound;
}

/** Один проход сопровождения: привязки, файлы сессий, продолжение восстановленных турнов. */
export async function maintainPanes(versions: { from: string | null; to: string | null } = { from: null, to: null }): Promise<SweepOutcome[]> {
  const panes = await listPanes().catch(() => [] as ManagedPane[]);
  if (panes.length === 0) return [];
  const hosts = (await listHosts().catch(() => ({ hosts: [] as OmpHost[] }))).hosts;
  const synced = await syncPaneHosts(panes, hosts);
  if (synced > 0) console.log(`[runtime] привязка панелей обновлена: ${synced}`);
  const bound = await bindMissingSessionFiles(panes, hosts);
  if (bound > 0) console.log(`[runtime] файл сессии дописан ${bound} панелям`);

  const outcomes: SweepOutcome[] = [];
  for (const pane of panes) {
    if (typeof pane.restoredAt !== "number") continue;
    // Проход по панели уже идёт (предыдущий тик опроса или стартовый догон):
    // повторять его нельзя — промпт продолжения ушёл бы второй раз.
    if (inFlight.has(pane.paneId)) continue;
    inFlight.add(pane.paneId);
    try {
      const outcome = await followRestoredPane(pane, pane.restoredAt, versions);
      if (outcome !== null) outcomes.push(outcome);
    } catch (err) {
      // Проход упал вне обработки продолжения: это транзиентный исход.
      const message = err instanceof Error ? err.message : String(err);
      await deferContinuation(pane.paneId, pane.restoredAt, message);
      outcomes.push({ paneId: pane.paneId, sessionId: null, continued: false, blocked: message });
    } finally {
      inFlight.delete(pane.paneId);
    }
  }
  return outcomes;
}

let lastGeneration: string | null = null;

/** Тот же проход плюс след в логе при смене поколения рантайма (диагностика). */
export async function watchPanes(versions: { from: string | null; to: string | null } = { from: null, to: null }): Promise<SweepOutcome[]> {
  const health = await runtimeHealth().catch(() => null);
  const generation = health?.generation ?? null;
  if (generation !== null && generation !== lastGeneration) {
    if (lastGeneration !== null) console.log(`[runtime] поколение рантайма сменилось: ${lastGeneration} → ${generation}`);
    lastGeneration = generation;
  }
  return maintainPanes(versions);
}
