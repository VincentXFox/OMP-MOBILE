import { mintLink } from "../hosts.ts";
import type { EmptySnapshot } from "./empty-session.ts";

/** CLI-only reader: authentic view link, no user input, control token, or host mutation. */
export async function readEmptyViewSnapshot(expected: EmptySnapshot): Promise<unknown> {
  const { GuestClient } = await import("../../app/src/lib/client.ts");
  const link = await mintLink(expected.instanceId, true);
  if (link.notFound || link.stale || !link.url) throw new Error("Fresh read-only view link unavailable");
  const NativeSocket = globalThis.WebSocket;
  // This helper runs in its own CLI process on Thor1. Keep the tunnel override scoped
  // to that one client and only to the server addresses established by the audit.
  globalThis.WebSocket = class extends NativeSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      const url = new URL(String(address));
      if (["thor1.local", "192.168.1.4", "127.0.0.1", "localhost"].includes(url.hostname)) {
        url.protocol = "ws:"; url.hostname = "127.0.0.1"; url.port = "7466";
      } else {
        throw new Error("Read-only snapshot relay is not an audited local address");
      }
      super(url, protocols);
    }
  } as typeof WebSocket;
  let guest: InstanceType<typeof GuestClient> | undefined;
  try {
    guest = new GuestClient(link.url, "Empty session verification (read-only)");
    guest.connect();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const snap = guest.getSnapshot();
      if (snap.phase === "ended") throw new Error("Read-only snapshot connection ended");
      if (snap.phase === "live" && snap.header && snap.state && snap.loading === null && snap.readOnly) {
        if (snap.uiRequest !== null || snap.stream !== null || snap.droppedFrames !== 0) throw new Error("Read-only snapshot contains pending work or dropped frames");
        // Copy before closing the guest; do not expose links or their embedded keys.
        return JSON.parse(JSON.stringify({
          instanceId: expected.instanceId, sessionId: expected.sessionId, cwd: expected.cwd,
          header: snap.header, entries: snap.entries, state: snap.state,
          meta: { readOnly: snap.readOnly, capturedAt: new Date().toISOString(), pid: expected.meta.pid, activeTools: snap.activeTools.size, working: snap.working },
        }));
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Fresh read-only snapshot timed out");
  } finally {
    try { guest?.close(); } finally { globalThis.WebSocket = NativeSocket; }
  }
}
