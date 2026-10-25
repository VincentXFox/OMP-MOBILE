import { afterEach, expect, test } from "bun:test";
import { getTerminal } from "./gateway";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function serveSnapshot(body: object): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		expect(init?.method ?? "GET").toBe("GET");
		calls.push(String(input));
		return Response.json(body);
	}) as typeof fetch;
	return calls;
}

test("default terminal request and response keep the plain API contract", async () => {
	const body = { paneId: "pane-1", text: " plain  \n" };
	const calls = serveSnapshot(body);
	expect(await getTerminal("instance-1")).toEqual(body);
	expect(calls).toEqual(["/api/agents/instance-1/terminal"]);
});

test("ANSI is opt-in and returned format identifies styled snapshots", async () => {
	const body = { paneId: "pane-1", text: "\x1b[32mgreen", format: "ansi" as const };
	const calls = serveSnapshot(body);
	expect(await getTerminal("instance-1", "ansi")).toEqual(body);
	expect(calls).toEqual(["/api/agents/instance-1/terminal?format=ansi"]);
});

test("an older gateway response without format falls back to plain text", async () => {
	const body = { paneId: "pane-1", text: "ordinary output" };
	serveSnapshot(body);
	expect(await getTerminal("instance-1", "ansi")).toEqual(body);
});
