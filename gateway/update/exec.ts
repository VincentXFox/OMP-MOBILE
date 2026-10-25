/** Запуск внешних команд с таймаутом и гарантированным убийством дерева:
 * рестарт шлюза во время `bun install` не должен оставлять полузаписанный node_modules. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  /** Сколько ждать после SIGTERM перед SIGKILL. */
  graceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;

export async function exec(argv: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  // Наследуем только необходимое: полный process.env унёс бы в дочерние команды
  // (git pull, bun install, systemctl) все секреты окружения агента и шлюза (E4).
  const baseEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "BUN_INSTALL", "PI_BUILD_URL", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "OMP_UPDATE_STATE_DIR", "OMP_UPDATE_BACKUPS_DIR", "OMP_CHAOS_ROOT", "OMP_RUNTIME_SOCKET", "OMP_RUNTIME_STATE_DIR", "OMP_CHAOS_BUN", "OMP_CHAOS_RUNTIME_MAIN", "OMP_CHAOS_RUNTIME_LOG"]) {
    const value = process.env[name];
    if (value !== undefined) baseEnv[name] = value;
  }
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: { ...baseEnv, ...(opts.env ?? {}) },
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid, "SIGTERM");
    setTimeout(() => killTree(proc.pid, "SIGKILL"), opts.graceMs ?? 5_000);
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr, timedOut, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Убить процесс и его группу: `-pid` работает, если ребёнок — лидер группы;
 * одиночный pid страхует остальные случаи. */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // не лидер группы
  }
  try {
    process.kill(pid, signal);
  } catch {
    // уже мёртв
  }
}

export function describeExec(argv: readonly string[], res: ExecResult, limit = 4000): string {
  const tail = (text: string): string => (text.length <= limit ? text : `${text.slice(0, limit)}… (+${text.length - limit} символов)`);
  const head = `$ ${argv.join(" ")}\n`;
  const body = `${res.stdout}${res.stderr}`.trim();
  const extra = res.timedOut ? "\n[таймаут: процесс и его группа убиты]" : "";
  return tail(`${head}${body}${extra}`);
}

export async function execOk(argv: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const res = await exec(argv, opts);
  if (res.code !== 0) throw new Error(describeExec(argv, res));
  return res;
}
