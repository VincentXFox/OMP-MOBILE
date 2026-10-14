import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import webpush from "web-push";
import type { PushSubscription } from "web-push";
import type { OmpHost } from "./hosts.ts";
import type { GatewayConfig } from "./config.ts";
import { findSessionFile, parseSessionHead } from "./sessions.ts";

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export type { PushPayload };

interface HostEdge {
  generation: number;
  inputRequired: boolean;
  busy: boolean;
}

const VAPID_SUBJECT = "mailto:omp-pocket@localhost";

export function sessionSummary(sessionId: string): string | null {
    try {
      const file = findSessionFile(sessionId);
      if (!file) return null;
      const size = statSync(file).size;
      const start = Math.max(0, size - 256 * 1024);
      const fd = openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      const lines = buf.toString("utf8").split("\n").filter(Boolean).slice(1); // первая может быть обрезана
      for (let i = lines.length - 1; i >= 0; i--) {
        let e: unknown;
        try {
          e = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (e === null || typeof e !== "object" || !("message" in e)) continue;
        const msg = e.message;
        if (msg === null || typeof msg !== "object" || !("role" in msg) || msg.role !== "assistant") continue;
        if (!("content" in msg)) continue;
        const content: unknown = msg.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .filter((b): b is { type: "text"; text?: string } => !!b && typeof b === "object" && "type" in b && b.type === "text")
            .map(b => b.text ?? "")
            .join(" ");
        }
        text = text
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[[^\]]*\]\([^)]*\)/g, "$1")
          .replace(/[#*_>`~|-]{2,}/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length < 20) continue;
        return text.length > 160 ? `${text.slice(0, 157)}…` : text;
      }
      return null;
    } catch {
      return null;
    }
  }

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

  /** Public broadcast; reused by the update center for its own notifications. */
  async broadcast(payload: PushPayload): Promise<void> {
    await Promise.all(this.#subscriptions.map((s) => this.#send(s, payload)));
  }

  static #label(host: OmpHost): string {
    return host.sessionName ?? host.cwd.split("/").filter(Boolean).at(-1) ?? host.instanceId;
  }

  /** Имя задачи для пуша: реестр не всегда даёт sessionName — добираем из файла сессии (кэш). */
  static #titleCache = new Map<string, string>();
  static #taskLabel(host: OmpHost): string {
    if (host.sessionName) return host.sessionName;
    const cached = this.#titleCache.get(host.instanceId);
    if (cached) return cached;
    let title: string | null = null;
    try {
      const file = findSessionFile(host.sessionId ?? "");
      if (file) title = parseSessionHead(file).title;
    } catch {
      // нет доступа/файла — останется cwd
    }
    const label = title ?? host.cwd.split("/").filter(Boolean).at(-1) ?? host.instanceId;
    this.#titleCache.set(host.instanceId, label);
    return label;
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
      if (this.#firstRun || (prev && prev.generation !== host.generation)) {
        // На старте шлюза baseline молчит, КРОМЕ агентов, которые уже ждут
        // решения, — о них пользователь должен узнать сразу (иначе пуши
        // «пропадают» после любого рестарта шлюза).
        if (this.#firstRun && host.inputRequired) {
          await this.broadcast({ title: "Требуется разрешение", body: `${PushManager.#taskLabel(host)}: агент ждёт решения`, url: "/" });
        }
        continue;
      }
      const label = PushManager.#taskLabel(host);
      if (!prev?.inputRequired && host.inputRequired) {
        await this.broadcast({ title: "Требуется разрешение", body: `${label}: агент ждёт решения`, url: "/" });
      } else if (prev?.busy && !host.busy) {
        // Краткий пересказ в пуше: название задачи + чем именно закончил.
        const summary = sessionSummary(host.sessionId ?? "");
        await this.broadcast({
          title: `Задача выполнена: ${label}`,
          body: summary ?? "Открой OMP Pocket — там подробности",
          url: "/",
        });
      }
    }
    for (const [id] of this.#edges) {
      if (seen.has(id)) continue;
      this.#edges.delete(id);
      if (!this.#firstRun) await this.broadcast({ title: "Сессия закрыта", body: id, url: "/" });
    }
    this.#firstRun = false;
  }
}
