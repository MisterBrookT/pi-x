import test from "node:test";
import assert from "node:assert/strict";
import { ensureUnlocked } from "../plugins/foryou/unlock.ts";

const wait = async () => {};
test("unlock: does nothing when open, types the saved login when locked, reports failure and missing login", async () => {
  const typed = [];
  assert.equal(await ensureUnlocked({ locked: async () => false, type: async p => typed.push(p), wait }), "open");
  assert.deepEqual(typed, []);
  let state = true;
  assert.equal(await ensureUnlocked({ locked: async () => state, password: async () => "pw", type: async p => { typed.push(p); state = false; }, wait }), "unlocked");
  assert.deepEqual(typed, ["pw"]);
  assert.equal(await ensureUnlocked({ locked: async () => true, password: async () => "pw", type: async () => {}, wait }), "failed");
  assert.equal(await ensureUnlocked({ locked: async () => true, password: async () => undefined, type: async () => assert.fail("no typing"), wait }), "no-login");
});
