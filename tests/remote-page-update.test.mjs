import test from "node:test";
import assert from "node:assert/strict";
import { pageUpdateScript } from "../plugins/remote/remote-relay-web.ts";

// Runs the real script with a fake page; returns how many reloads happened after `ms` of fake time.
function run({ build = "new", visible = true, typingAgo = Infinity } = {}) {
  let reloads = 0, timer, now = 1e6;
  const handlers = {}, el = { id: typingAgo < Infinity ? "input" : "x", value: "" };
  const g = {
    PIX_BUILD: "old", Date: { now: () => now }, setInterval: (f) => { timer = f; },
    fetch: async () => ({ json: async () => ({ build }) }),
    location: { reload: () => reloads++ }, sessionStorage: {},
    document: { visibilityState: visible ? "visible" : "hidden", activeElement: el, getElementById: () => el, addEventListener() {} },
    addEventListener: (k, f) => { handlers[k] = f; },
  };
  g.window = { pixLastKey: now + 31000 - typingAgo };
  new Function(...Object.keys(g), pageUpdateScript)(...Object.values(g));
  return { tick: async () => { now += 31000; timer(); await new Promise(r => setTimeout(r, 0)); return reloads; } };
}

test("open page picks up a new deploy within ~30 s, without being touched", async () => {
  assert.equal(await run().tick(), 1);
});
test("never reloads while brook is typing, or for the same build, or while hidden", async () => {
  assert.equal(await run({ typingAgo: 2000 }).tick(), 0);
  assert.equal(await run({ build: "old" }).tick(), 0);
  assert.equal(await run({ visible: false }).tick(), 0);
});
