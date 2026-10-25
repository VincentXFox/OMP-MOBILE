#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { listHosts } from "../gateway/hosts.ts";
import { findSessionFile, listSessions } from "../gateway/sessions.ts";
import { materializeEmptySession } from "../gateway/recovery/empty-session.ts";
import { readEmptyViewSnapshot } from "../gateway/recovery/view-snapshot.ts";

export function parseMaterializeArgs(argv: string[]): { sessionId: string; snapshotPath: string; output: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--session", "--snapshot", "--output"].includes(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error("Usage: materialize-empty-session.ts --session UUID --snapshot /fresh/view-snapshot.json --output /exact/native/session.jsonl");
    flags.set(key, value);
  }
  if (flags.size !== 3) throw new Error("Required: --session UUID --snapshot PATH --output PATH");
  return { sessionId: flags.get("--session")!, snapshotPath: flags.get("--snapshot")!, output: flags.get("--output")! };
}

export async function materializeMain(argv: string[]): Promise<void> {
  const args = parseMaterializeArgs(argv);
  const result = await materializeEmptySession({ ...args, checkpointPath: `${args.snapshotPath}.materialize-${randomUUID()}.json`, sessionsRoot: join(homedir(), ".omp", "agent", "sessions") }, {
    hosts: async () => (await listHosts()).hosts,
    sessions: () => listSessions(new Set()),
    findSessionFile,
    readSnapshot: readEmptyViewSnapshot,
  });
  console.log(JSON.stringify(result));
}
if (import.meta.main) await materializeMain(process.argv.slice(2));
