import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reopenAfterBoot } from "../plugins/remote/reopen.ts";

function setup(ids, panes) {
  const dir = mkdtempSync(join(tmpdir(), "reopen-")), files = {};
  writeFileSync(join(dir, "registered-at-shutdown.json"), JSON.stringify({ ids }));
  for (const id of ids) { const f = join(dir, `2026-10-10T00-00-00-000Z_${id}.jsonl`); writeFileSync(f, JSON.stringify({ type: "session", cwd: "/w/" + id }) + "\n"); files[id] = f; }
  const opened = [], sleeps = [], log = [];
  let t = 1_000_000, load = 1;
  const otty = JSON.stringify({ data: panes.map((id, i) => ({ id: "p" + i, agent: "Pi", agent_session_id: `2026-10-10T00-00-00-000Z_${id}`, process: id })) });
  const deps = { dir, boot: 500_000, now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; load = 1; }, load: () => load, otty: async () => otty,
    findSession: id => files[id], open: async (cwd, jsonl) => { opened.push([cwd, jsonl]); }, log: l => log.push(l) };
  return { dir, deps, opened, sleeps, log, setLoad: v => { load = v; } };
}

test("reopens shutdown sessions with no pane, in their cwd, 10 s apart; loop-* only if listed; once per boot", async () => {
  const s = setup(["a", "loop-1", "live"], ["live"]);
  assert.deepEqual(await reopenAfterBoot(s.deps), ["a", "loop-1"]);
  assert.deepEqual(s.opened.map(o => o[0]), ["/w/a", "/w/loop-1"]);
  assert.match(s.opened[0][1], /_a\.jsonl$/, "absolute JSONL path");
  assert.deepEqual(s.sleeps, [10_000]);
  assert.ok(s.log.some(l => /reopened a/.test(l)));
  assert.deepEqual(await reopenAfterBoot(s.deps), [], "never twice per boot");
  assert.equal(s.opened.length, 2);
});

test("waits while load > 20; respects the 15-min guard; skips missing files; Otty down = nothing", async () => {
  const s = setup(["a", "b"], []);
  writeFileSync(join(s.dir, "auto-launches.json"), JSON.stringify({ b: 1_000_000 - 60_000 }));
  s.setLoad(30);
  assert.deepEqual(await reopenAfterBoot(s.deps), ["a"]);
  assert.ok(s.sleeps.length >= 1 && s.log.some(l => /waiting/.test(l)));
  assert.ok(s.log.some(l => /skip b/.test(l)));
  assert.ok(JSON.parse(readFileSync(join(s.dir, "auto-launches.json"), "utf8")).a, "recorded for the guard");
  const d = setup(["x"], []); d.deps.otty = async () => null;
  assert.deepEqual(await reopenAfterBoot(d.deps), []);
  const m = setup(["x"], []); m.deps.findSession = () => undefined;
  assert.deepEqual(await reopenAfterBoot(m.deps), []);
});
