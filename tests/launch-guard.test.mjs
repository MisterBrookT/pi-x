import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoLaunchAllowed, recordRegistered } from "../plugins/core/launch-guard.ts";
import { startForYou } from "../plugins/foryou/proactive-store.ts";

const H = 3_600_000;
const fresh = t => { const d = mkdtempSync(join(tmpdir(), "pix-guard-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const pastList = (dir, ids, at) => { const f = join(dir, "registered.json"); writeFileSync(f, JSON.stringify({ ids })); utimesSync(f, at / 1000, at / 1000); };

test("reboot storm: repeated daemon rounds start For you once, not once per round", t => {
  const dir = fresh(t), boot = Date.now() - 10 * H;
  const rounds = Array.from({ length: 50 }, (_, i) => autoLaunchAllowed("pix-foryou", { dir, boot, now: Date.now() + i * 15_000 }));
  assert.equal(rounds.filter(Boolean).length, 1, "50 rounds within the cooldown: one launch");
  const hourly = Array.from({ length: 50 }, (_, i) => autoLaunchAllowed("pix-foryou", { dir, boot, now: Date.now() + H + i * 60_000 }));
  assert.equal(hourly.filter(Boolean).length, 4, "at most one per 15 min");
});

test("right after a boot only sessions registered before it may start", t => {
  const dir = fresh(t), now = Date.now(), boot = now - 60_000;
  assert.equal(autoLaunchAllowed("pix-foryou", { dir, boot, now }), false, "no record: nothing starts");
  pastList(dir, ["pix-foryou"], boot - H);
  assert.equal(autoLaunchAllowed("other", { dir, boot, now }), false);
  assert.equal(autoLaunchAllowed("pix-foryou", { dir, boot, now }), true);
});

test("the first hub write after boot keeps the pre-boot list for the guard", t => {
  const dir = fresh(t), now = Date.now(), boot = now - 60_000;
  pastList(dir, ["pix-foryou"], boot - H);
  recordRegistered(["news-docs"], dir, boot);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "registered-at-shutdown.json"), "utf8")).ids, ["pix-foryou"]);
  recordRegistered(["news-docs", "x"], dir, boot);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "registered-at-shutdown.json"), "utf8")).ids, ["pix-foryou"], "later writes do not overwrite it");
  assert.equal(autoLaunchAllowed("pix-foryou", { dir, boot, now }), true);
});

test("loop sessions never auto-start", t => {
  const dir = fresh(t);
  assert.equal(autoLaunchAllowed("loop-546a09e3", { dir, boot: 1, now: Date.now() }), false);
  assert.equal(existsSync(join(dir, "auto-launches.json")), false);
});

test("startForYou does not launch when the guard holds it", async () => {
  let launched = 0;
  await assert.rejects(startForYou("hi", { mode: "tailnet", launch: async () => { launched++; }, allowed: () => false }));
  await startForYou("hi", { mode: "tailnet", launch: async () => { launched++; }, allowed: () => true });
  assert.equal(launched, 1);
});
