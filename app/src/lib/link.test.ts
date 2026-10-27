import { expect, test } from "bun:test";
import { formatCollabLink, parseCollabLink, rebaseCollabLink } from "./link";

const KEY = new Uint8Array(32).map((_, i) => i + 1);
const WRITE_TOKEN = new Uint8Array(16).map((_, i) => 200 + i);
const ROOM = "z8erfhwDzX97aZEJAfdhkQ";
const LAN_ORIGIN = "https://thor1.local:8443";
const PUBLIC_ORIGIN = "https://pocket.example.com";

/** Так ссылку отдаёт шлюз: абсолютный LAN-адрес и тот же адрес в фрагменте. */
function gatewayLink(): string {
	return `${LAN_ORIGIN}/#${formatCollabLink(LAN_ORIGIN, ROOM, KEY, WRITE_TOKEN)}`;
}

test("gateway link is rebound to the public page origin and keeps room + key", () => {
	const original = gatewayLink();
	const before = parseCollabLink(original);
	if ("error" in before) throw new Error(before.error);
	const rebased = rebaseCollabLink(original, PUBLIC_ORIGIN);
	const after = parseCollabLink(rebased);
	if ("error" in after) throw new Error(after.error);
	expect(after.wsUrl).toBe(`wss://pocket.example.com/r/${ROOM}`);
	expect(rebased).not.toContain("thor1.local");
	expect([...after.key]).toEqual([...before.key]);
	expect([...(after.writeToken ?? [])]).toEqual([...(before.writeToken ?? [])]);
});

test("link already on the page origin stays usable (same relay, same secrets)", () => {
	const original = formatCollabLink(PUBLIC_ORIGIN, ROOM, KEY);
	const rebased = rebaseCollabLink(original, PUBLIC_ORIGIN);
	const parsed = parseCollabLink(rebased);
	if ("error" in parsed) throw new Error(parsed.error);
	expect(parsed.wsUrl).toBe(`wss://pocket.example.com/r/${ROOM}`);
	expect([...parsed.key]).toEqual([...KEY]);
});

test("http page is left alone: wss to its host would not upgrade", () => {
	const original = gatewayLink();
	expect(rebaseCollabLink(original, "http://127.0.0.1:5173")).toBe(original);
});

test("unreadable link passes through untouched instead of throwing", () => {
	expect(rebaseCollabLink("https://thor1.local:8443/#nonsense", PUBLIC_ORIGIN)).toBe("https://thor1.local:8443/#nonsense");
});
