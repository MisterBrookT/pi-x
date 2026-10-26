import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { relayRouter } = await createJiti(import.meta.url).import("../plugins/remote/remote-relay-agent.ts");

test("regression (10-26 Clash outage): relay switches route after two failures and back again", () => {
  const r = relayRouter("proxy");
  r.fail(); assert.equal(r.pick(), "proxy");
  r.fail(); assert.equal(r.pick(), "direct");
  r.ok(); r.fail(); assert.equal(r.pick(), "direct");
  r.fail(); assert.equal(r.pick(), "proxy");
});
