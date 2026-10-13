import { readFileSync, writeFileSync } from "node:fs";
import webpush from "web-push";

export interface GatewayConfig {
  token: string;
  port: number;
  host: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
}

export function loadConfig(path: string, overrides: { host?: string; port?: string }): GatewayConfig {
  let cfg: GatewayConfig;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GatewayConfig>;
    cfg = {
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : crypto.getRandomValues(new Uint8Array(32)).toHex(),
      port: typeof parsed.port === "number" ? parsed.port : 8088,
      host: typeof parsed.host === "string" ? parsed.host : "127.0.0.1",
      vapidPublicKey: typeof parsed.vapidPublicKey === "string" ? parsed.vapidPublicKey : "",
      vapidPrivateKey: typeof parsed.vapidPrivateKey === "string" ? parsed.vapidPrivateKey : "",
    };
  } catch {
    cfg = { token: crypto.getRandomValues(new Uint8Array(32)).toHex(), port: 8088, host: "127.0.0.1", vapidPublicKey: "", vapidPrivateKey: "" };
  }
  if (overrides.host) cfg.host = overrides.host;
  if (overrides.port) cfg.port = Number(overrides.port);
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    cfg.vapidPublicKey = keys.publicKey;
    cfg.vapidPrivateKey = keys.privateKey;
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}
