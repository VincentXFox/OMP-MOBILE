import { listHosts, type OmpHost } from "../hosts.ts";
import { listPanes as listRuntimePanes, paneProcesses, type ManagedPane } from "../panes.ts";
import { classifySession } from "./classify.ts";
import { newRecoveryState, type Checkpoint, type LogicalSession } from "./model.ts";
import { probeOmpProcesses, type OmpProcessProbe } from "../update/probes.ts";
import { binaryVersion } from "../update/release.ts";

export interface PaneInfo {
  paneId: string;
  pid: number | null;
  cmdline: string;
  argv: string[];
  sessionFile: string | null;
  cwd: string | null;
  /** Что панель сама знает о своей сессии: связывание переживает промах pid-пробы. */
  sessionId: string | null;
  instanceId: string | null;
  /** argv запуска панели — запасной источник, когда проба процессов пуста. */
  launchArgv: string[];
}

/** Панель → текущий процесс в ней. Единственный надёжный способ связать
 * collab-хост (pid) с панелью, чтобы перезапустить именно её. */
export async function listPanes(): Promise<PaneInfo[]> {
  const panes = (await listRuntimePanes().catch(() => [] as ManagedPane[])).filter((pane) => pane.status !== "closed");
  const result: PaneInfo[] = [];
  // Панелей единицы: список приходит одним запросом, параллельный обход не нужен.
  for (const pane of panes) {
    const process = await firstChildProcess(pane);
    result.push({
      paneId: pane.paneId,
      pid: process?.pid ?? null,
      cmdline: process?.cmdline ?? "",
      argv: process?.argv ?? [],
      sessionFile: pane.sessionFile,
      cwd: pane.cwd,
      sessionId: pane.sessionId,
      instanceId: pane.instanceId,
      launchArgv: [...pane.launchArgv],
    });
  }
  return result;
}

/** Процесс агента в панели: потомок оболочки, которого перезапускаем. Порядок
 * процессов в ответе произвольный, поэтому сначала ищем `omp` по argv[0], и лишь
 * если такого нет — берём первого потомка (панель без живого агента). */
async function firstChildProcess(pane: ManagedPane): Promise<{ pid: number; cmdline: string; argv: string[] } | null> {
  const processes = await paneProcesses(pane.paneId).catch(() => null);
  if (processes === null) return null;
  const children = processes.filter((proc) => proc.pid !== pane.shellPid);
  const child = children.find((proc) => {
    const executable = proc.argv[0] ?? proc.name;
    return executable === "omp" || executable.endsWith("/omp");
  }) ?? children[0];
  return child === undefined ? null : { pid: child.pid, cmdline: child.cmdline, argv: child.argv };
}

/** Флаги, несовместимые с `--restore` (omp отвергает их комбинацию). */
const ONESHOT_FLAGS: Record<string, true> = {
  "--resume": true,
  "-r": true,
  "--restore": true,
  "--continue": true,
  "-c": true,
  "--session": true,
  "--fork": true,
  "--from-claude": true,
  "--from-codex": true,
  "--goal": true,
  "--no-session": true,
};
/** Флаги без значения. */
const BARE_ONESHOT: Record<string, true> = { "--continue": true, "-c": true, "--no-session": true, "--from-claude": true, "--from-codex": true };

/** argv запуска без одноразовых селекторов сессии: `--restore <file>` добавляется
 * заново. `--continue`, оставшийся от старта панели, ломал восстановление. */
export function launchArgvOf(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const [flag] = arg.split("=");
    if (flag !== undefined && ONESHOT_FLAGS[flag] === true) {
      if (!BARE_ONESHOT[flag] && !arg.includes("=")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function sessionFileFor(host: OmpHost, pane: PaneInfo | null, proc: OmpProcessProbe | null): string | null {
  if (proc?.sessionFile !== null && proc?.sessionFile !== undefined) return proc.sessionFile;
  if (pane?.sessionFile !== null && pane?.sessionFile !== undefined) return pane.sessionFile;
  return host.sessionFile;
}

/**
 * Связывание живых collab-хостов с панелями рантайма (чистая часть чекпоинта).
 *
 * Пид процесса агента — точная связь, но проба процессов панели может не увидеть
 * агента (пустой `processInfo`, гонка после рестарта демона). Тогда законные данные
 * панели — её `sessionId`/`instanceId`: без этого фолбэка сессия попадала в
 * «вне панелей рантайма» и оставалась на старом образе после обновления.
 * Одну панель двум хостам не отдаём: первым выигрывает точный pid.
 */
export function bindSessions(
	hosts: readonly OmpHost[],
	panes: readonly PaneInfo[],
	procs: readonly OmpProcessProbe[],
	only: string | null = null,
): LogicalSession[] {
	const paneByPid = new Map<number, PaneInfo>();
	const paneBySession = new Map<string, PaneInfo>();
	const paneByInstance = new Map<string, PaneInfo>();
	for (const pane of panes) {
		if (pane.pid !== null) paneByPid.set(pane.pid, pane);
		if (pane.sessionId !== null) paneBySession.set(pane.sessionId, pane);
		if (pane.instanceId !== null) paneByInstance.set(pane.instanceId, pane);
	}
	const procByPid = new Map<number, OmpProcessProbe>();
	for (const proc of procs) procByPid.set(proc.pid, proc);
	const claimed = new Set<string>();

	const sessions: LogicalSession[] = [];
	for (const host of hosts) {
		if (!host.alive) continue;
		// частичное применение (перезапуск одной сессии) — по подстроке cwd или sessionId
		if (only !== null && !host.cwd.includes(only) && !host.sessionId.includes(only)) continue;
		const byPid = paneByPid.get(host.pid) ?? null;
		if (byPid !== null) claimed.add(byPid.paneId);
		const bySession = paneBySession.get(host.sessionId);
		const byInstance = paneByInstance.get(host.instanceId);
		const pane = byPid ?? (bySession !== undefined && !claimed.has(bySession.paneId) ? bySession : null) ??
			(byInstance !== undefined && !claimed.has(byInstance.paneId) ? byInstance : null);
		if (pane !== null && pane !== byPid) claimed.add(pane.paneId);
		const proc = procByPid.get(host.pid) ?? null;
		const file = sessionFileFor(host, pane, proc);
		const turn = file === null ? null : classifySession(file);
		const argv = launchArgvOf(proc?.argv ?? (pane !== null && pane.argv.length > 0 ? pane.argv : (pane?.launchArgv ?? [])));
		sessions.push({
			logicalId: `${host.cwd}::${host.sessionId}`,
			sessionId: host.sessionId,
			cwd: host.cwd,
			files: file === null ? [] : [file],
			lazy: file === null,
			model: host.model === null ? null : `${host.model.provider}/${host.model.id}`,
			label: host.sessionName ?? host.sessionTitle ?? host.sessionPreview ?? null,
			paneId: pane?.paneId ?? null,
			launchArgv: argv.length > 0 ? argv : ["omp", "--cwd", host.cwd, "--allow-home"],
			pid: host.pid,
			turn,
			awaitingApproval: host.inputRequired,
			recovery: newRecoveryState(),
			updatedAt: new Date().toISOString(),
		});
	}
	return sessions;
}

/** Снимок всех живых сессий перед обновлением: кто, где, с каким argv и в каком
 * состоянии турна. Это опора восстановления — без него `--restore` даёт лишь транскрипт. */
export async function buildCheckpoint(jobId: string, only: string | null = null): Promise<Checkpoint> {
  const [hostsOut, panes, procs, version] = await Promise.all([
    listHosts().catch(() => ({ hosts: [] as OmpHost[] })),
    listPanes().catch(() => [] as PaneInfo[]),
    Promise.resolve(probeOmpProcesses()),
    binaryVersion(process.env["OMP_UPDATE_OMP_BIN"] ?? `${process.env["HOME"] ?? ""}/.local/bin/omp`).catch(() => null),
  ]);
  return {
    schema: 1,
    jobId,
    createdAt: new Date().toISOString(),
    ompVersion: version,
    sessions: bindSessions(hostsOut.hosts, panes, procs, only),
  };
}
