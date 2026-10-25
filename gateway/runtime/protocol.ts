/**
 * Протокол PTY-рантайма OMP Pocket.
 *
 * Рантайм — отдельный процесс (`bun gateway/runtime/main.ts`, юнит
 * `omp-pocket-runtime.service`), который держит панели: настоящие PTY с
 * интерактивным bash, эмуляцию экрана и durable-состояние на диске. Шлюз
 * общается с ним построчным JSON-RPC по unix-сокету: рантайм переживает
 * рестарт шлюза (агенты не умирают), а шлюз — рестарт рантайма (панели
 * поднимаются из `panes.json`).
 *
 * Раньше эту роль играл herdr: `herdr tab create` + `agent start` + `pane
 * read/send-keys`, а связь «панель ↔ collab-хост» восстанавливалась по cwd и
 * /proc. Теперь идентичность панели — первоклассная: `sessionId`, `instanceId`,
 * `sessionFile`, `launchArgv` лежат в записи панели, а pid процесса виден через
 * `pane.processInfo` (наследники оболочки, а не угадывание по cwd).
 */

/** Статусы панели. `shell` — оболочка готова и свободна, `closed` — панель закрыта
 * пользователем. `starting/working/blocked/idle` проставляет шлюз: рантайм про
 * состояние агента в collab-реестре ничего не знает. */
export const PANE_STATUSES = ["shell", "starting", "working", "blocked", "idle", "closed"] as const;
export type PaneStatus = (typeof PANE_STATUSES)[number];

export interface RuntimePane {
  id: string;
  name: string;
  cwd: string;
  /** pid оболочки панели: по нему ищутся её процессы в /proc. */
  shellPid: number;
  cols: number;
  rows: number;
  createdAt: number;
  /** OSC-заголовок, который выставил процесс в панели (omp пишет туда имя сессии). */
  title: string | null;
  sessionId: string | null;
  instanceId: string | null;
  sessionFile: string | null;
  /** argv запуска агента без одноразовых селекторов сессии — опора `--restore`. */
  launchArgv: string[];
  status: PaneStatus;
  model?: string | null;
  /** Панель ждала подтверждения пользователя: восстановление идёт `--resume`,
   * а не `--restore`, чтобы не проиграть турн за спиной человека. */
  awaitingApproval?: boolean;
  /** Когда агент панели был поднят заново после рестарта рантайма: шлюз по этой
   * метке досылает продолжение турна ровно один раз. */
  restoredAt?: number | null;
}

export type RuntimeStreamEvent =
  | { event: "snapshot"; paneId: string; seq: number; data: { ansi: string; cols: number; rows: number; generation: string } }
  | { event: "data"; paneId: string; seq: number; data: { text: string } }
  | { event: "resize"; paneId: string; seq: number; data: { cols: number; rows: number } }
  | { event: "exit"; paneId: string; seq: number; data: { code: number | null } };

export interface ProcessEntry {
  pid: number;
  name: string;
  argv: string[];
  cmdline: string;
  cwd: string;
}

/** Форма ответа сохранена от прежнего API панелей (`pane process-info`): на неё
 * уже опирались проверки «кто сейчас в панели», и менять её без нужды незачем. */
export interface ProcessInfo {
  foreground_process_group_id: number | null;
  foreground_processes: ProcessEntry[];
}

export interface RuntimeHealth {
  version: 1;
  generation: string;
  pid: number;
  startedAt: number;
  ready: boolean;
  panes: number;
  /** Панели, которые не удалось поднять после рестарта рантайма: видно в /api/health. */
  restoreIssues: Array<{ paneId: string; sessionFile: string | null; error: string }>;
}

/** Предел одного управляющего кадра. */
export const MAX_FRAME = 1024 * 1024;
/** Предел одного кадра потока (снапшот экрана со скроллбеком). */
export const MAX_STREAM_FRAME = 8 * 1024 * 1024;
/** Предел пользовательского ввода в одном запросе. */
export const MAX_INPUT = 64 * 1024;

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

function defaultRuntimeDir(): string {
  const xdg = process.env["XDG_RUNTIME_DIR"];
  if (xdg !== undefined && xdg !== "") return xdg;
  return `/run/user/${process.getuid?.() ?? 0}`;
}

export function runtimeSocketPath(): string {
  const explicit = process.env["OMP_RUNTIME_SOCKET"];
  return explicit !== undefined && explicit !== "" ? explicit : `${defaultRuntimeDir()}/omp-pocket-runtime.sock`;
}

/** Состояние (panes.json, lock, inputrc) живёт в XDG_STATE_HOME: это не рунтайм-файлы,
 * они переживают перезагрузку. */
export function runtimeStateDir(): string {
  const explicit = process.env["OMP_RUNTIME_STATE_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const home = process.env["HOME"] ?? ".";
  const stateHome = process.env["XDG_STATE_HOME"];
  return stateHome !== undefined && stateHome !== "" ? `${stateHome}/omp-pocket/runtime` : `${home}/.local/state/omp-pocket/runtime`;
}
