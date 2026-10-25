import { exec } from "./exec.ts";
import type { UpdatePaths } from "./paths.ts";

export interface CodeState {
  /** Локальный HEAD (полный sha). */
  head: string | null;
  /** Ветка, на которой стоим. */
  branch: string | null;
  /** SHA удалённой ветки (без fetch — через ls-remote). */
  remote: string | null;
  /** Сколько коммитов удалённая ветка опережает локальную (0 = обновлять нечего). */
  behind: number | null;
  /** Есть ли локальные незакоммиченные изменения. */
  dirty: string[];
}

async function git(paths: UpdatePaths, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const res = await exec([paths.gitBin, ...args], { cwd: paths.repoDir, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" } });
  return { code: res.code, out: res.stdout.trim() };
}

/** Состояние кода без побочных эффектов: без fetch, без изменения refs. */
export async function readCodeState(paths: UpdatePaths): Promise<CodeState> {
  const [headRes, branchRes, upstreamRes, dirtyRes] = await Promise.all([
    git(paths, ["rev-parse", "HEAD"], 10_000),
    git(paths, ["rev-parse", "--abbrev-ref", "HEAD"], 10_000),
    git(paths, ["remote", "get-url", "origin"], 10_000),
    git(paths, ["status", "--porcelain"], 15_000),
  ]);
  const head = headRes.code === 0 && headRes.out !== "" ? headRes.out : null;
  const branch = branchRes.code === 0 && branchRes.out !== "" && branchRes.out !== "HEAD" ? branchRes.out : null;
  const dirty = dirtyRes.code === 0 ? dirtyRes.out.split("\n").map((line) => line.trim()).filter((line) => line !== "") : [];
  let remote: string | null = null;
  let behind: number | null = null;
  if (upstreamRes.code === 0 && branch !== null) {
    const ls = await git(paths, ["ls-remote", "origin", `refs/heads/${branch}`], 20_000);
    if (ls.code === 0) {
      remote = ls.out.split("\n")[0]?.split("\t")[0]?.trim() ?? null;
      if (remote !== null && head !== null) {
        const has = await git(paths, ["cat-file", "-e", remote], 10_000);
        if (has.code !== 0) {
          // объекта нет локально: неизвестно, новее ли он — считаем, что проверка нужна
          behind = null;
        } else {
          const isAncestor = await git(paths, ["merge-base", "--is-ancestor", remote, head], 10_000);
          if (isAncestor.code === 0) {
            behind = 0;
          } else {
            const count = await git(paths, ["rev-list", "--count", `${head}..${remote}`], 10_000);
            behind = count.code === 0 ? Number(count.out) || 0 : null;
          }
        }
      }
    }
  }
  return { head, branch, remote, behind, dirty };
}
