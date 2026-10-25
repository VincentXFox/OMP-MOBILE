import { test } from "node:test";
import assert from "node:assert/strict";
import { superAgentName } from "./super.ts";

const id = "01a17095-17f9-70f3-b002-f79db42f55a8";
const internal = { name: `handover:${id}`, cwd: "/OMP/herdr-remove" };

test("internal handover display uses the meaningful current session header before registry name", () => {
  const host = { sessionTitle: "Убрать Herdr без потери сессий", sessionName: "Old registry name" };
  assert.equal(superAgentName(internal, host), host.sessionTitle);
  assert.equal(internal.name, `handover:${id}`);
});

test("explicit custom pane names stay unchanged", () => {
  const host = { sessionTitle: "Current header", sessionName: "Registry" };
  for (const name of ["My custom panel", "  Custom with spaces  ", "handover:manual-label", "prefix handover:" + id]) {
    assert.equal(superAgentName({ ...internal, name }, host), name);
  }
});

test("blank and internal host labels are skipped in favour of registry name or readable cwd", () => {
  for (const name of [internal.name, "", "   "]) {
    const pane = { ...internal, name };
    assert.equal(superAgentName(pane, { sessionTitle: "  ", sessionName: "Рабочая сессия" }), "Рабочая сессия");
    assert.equal(superAgentName(pane, { sessionTitle: id, sessionName: internal.name }), "herdr-remove");
    assert.equal(superAgentName(pane, { sessionTitle: internal.name, sessionName: id }), "herdr-remove");
    assert.equal(superAgentName(pane, null), "herdr-remove");
  }
});

test("missing host preserves custom names and root cwd remains readable", () => {
  assert.equal(superAgentName({ name: "Custom", cwd: "/OMP/project" }, null), "Custom");
  assert.equal(superAgentName({ name: "", cwd: "/" }, null), "/");
});
