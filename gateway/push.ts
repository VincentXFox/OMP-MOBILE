import { readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";
import type { PushSubscription } from "web-push";
import type { OmpHost } from "./hosts.ts";
import type { GatewayConfig } from "./config.ts";

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

interface HostEdge {
  generation: number;
  inputRequired: boolean;
  busy: boolean;
}

const VAPID_SUBJECT = "mailto:omp-pocket@localhost";

export class PushManager {
  #vapidDetails: { subject: string; publicKey: string; privateKey: string };
  #subscriptionsPath: string;
  #subscriptions: PushSubscription[] = [];
  #edges = new Map<string, HostEdge>(); // dynamic per-instance membership
  #firstRun = true;

  constructor(config: GatewayConfig, subscriptionsPath: string) {
    this.#vapidDetails = { subject: VAPID_SUBJECT, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    this.#subscriptionsPath = subscriptionsPath;
    webpush.setVapidDetails(VAPID_SUBJECT, config.vapidPublicKey, config.vapidPrivateKey);
    try {
      const parsed: unknown = JSON.parse(readFileSync(subscriptionsPath, "utf8"));
      if (Array.isArray(parsed)) {
        this.#subscriptions = parsed.filter(
          (s): s is PushSubscription =>
            typeof s === "object" && s !== null && "endpoint" in s && typeof s.endpoint === "string",
        );
      }
    } catch {
      /* first run or corrupt file */
    }
  }

  save(sub: unknown): { ok: boolean } {
    if (typeof sub !== "object" || sub === null || !("endpoint" in sub) || typeof sub.endpoint !== "string") {
      return { ok: false };
    }
    const typed = sub as PushSubscription; // endpoint verified above; remaining shape owned by web-push
    this.#subscriptions = this.#subscriptions.filter((s) => s.endpoint !== typed.endpoint);
    this.#subscriptions.push(typed);
    this.#persist();
    return { ok: true };
  }

  remove(endpoint: unknown): { ok: boolean } {
    if (typeof endpoint !== "string") return { ok: false };
    const before = this.#subscriptions.length;
    this.#subscriptions = this.#subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.#subscriptions.length !== before) this.#persist();
    return { ok: true };
  }

  #persist(): void {
    writeFileSync(this.#subscriptionsPath, JSON.stringify(this.#subscriptions, null, 2) + "\n");
  }

  async #send(sub: PushSubscription, payload: PushPayload): Promise<void> {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: this.#vapidDetails });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode; // web-push error shape
      if (status === 404 || status === 410) {
        this.#subscriptions = this.#subscriptions.filter((s) => s.endpoint !== sub.endpoint);
        this.#persist();
      }
    }
  }

  async #broadcast(payload: PushPayload): Promise<void> {
    await Promise.all(this.#subscriptions.map((s) => this.#send(s, payload)));
  }

  static #label(host: OmpHost): string {
    return host.sessionName ?? host.cwd.split("/").filter(Boolean).at(-1) ?? host.instanceId;
  }

  async poll(hosts: OmpHost[]): Promise<void> {
    const seen = new Set<string>();
    for (const host of hosts) {
      seen.add(host.instanceId);
      const prev = this.#edges.get(host.instanceId);
      this.#edges.set(host.instanceId, {
        generation: host.generation,
        inputRequired: host.inputRequired,
        busy: host.busy,
      });
      if (this.#firstRun || (prev && prev.generation !== host.generation)) continue; // skip boot + rotated instances
      const label = PushManager.#label(host);
      if (!prev?.inputRequired && host.inputRequired) {
        await this.#broadcast({ title: "Требуется разрешение", body: `${label}: агент ждёт решения`, url: "/" });
      } else if (prev?.busy && !host.busy) {
        await this.#broadcast({ title: "Агент завершил", body: label, url: "/" });
      }
    }
    for (const [id] of this.#edges) {
      if (seen.has(id)) continue;
      this.#edges.delete(id);
      if (!this.#firstRun) await this.#broadcast({ title: "Сессия закрыта", body: id, url: "/" });
    }
    this.#firstRun = false;
  }
}
