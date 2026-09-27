import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { remoteAppHtml } from "../src/remote-web.ts";
import { runningHelpers } from "../src/remote-helpers.ts";

const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
// Load only the pure rendering functions from the phone app, without its DOM bootstrapping.
const pick = prefix => script.split("\n").find(line => line.startsWith(prefix)) ?? assert.fail(`missing ${prefix}`);
const app = runInNewContext([
  pick("const esc="), pick("const shibaFace="), pick("function avatarHtml"), pick("function avatarMood"), pick("function helperLine"),
  pick("function imagesHtml"), pick("function tool("), pick("function background("), pick("function activity("), pick("function transcript("), pick("let transcriptRun"),
  "({ transcript, avatarMood, helperLine, run: () => transcriptRun })",
].join("\n"), { current: { id: "s" }, loadedImages: new Map() });

test("Shiba avatar appears once per consecutive assistant run and never on user messages", () => {
  const html = app.transcript([
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "one" },
    { id: "a2", role: "assistant", text: "", tools: [{ id: "t", name: "bash", output: "ok" }] },
    { id: "a3", role: "assistant", text: "two" },
    { id: "u2", role: "user", text: "again" },
    { id: "a4", role: "assistant", text: "three" },
  ]);
  assert.equal(html.match(/class="av /g).length, 2);
  assert.match(html, /data-key="a1"><span class="av idle"/);
  assert.match(html, /class="msg assistant cont" data-key="a3"><div class="bubble/);
  assert.match(html, /data-key="a4"><span class="av idle"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('data-key="a1"')), /class="av/);
  assert.equal(app.run(), true, "a streaming row after an assistant run continues it without a second avatar");
});

test("avatar mood follows busy state and the busy-to-idle done window", () => {
  assert.equal(app.avatarMood(true, 0, 5), "working");
  assert.equal(app.avatarMood(false, 3000, 1000), "done");
  assert.equal(app.avatarMood(false, 3000, 3001), "idle");
  assert.match(script, /moodBusy&&!busy\)\{doneUntil=now\+3000/);
});

test("avatar CSS defines moods, blink, and a reduced-motion override", () => {
  for (const rule of [".av.idle .ey-line", ".av.working .ey-dot", ".av.working svg{animation:av-tilt", ".av.done .ey-hap", ".av.done{animation:av-hop .25s"])
    assert.ok(remoteAppHtml.includes(rule), rule);
  assert.match(remoteAppHtml, /@media\(prefers-reduced-motion:reduce\)\{\.av,\.av \*\{animation:none!important\}\}/);
});

test("running subagents are read from pi-subagents status files for this session only", () => {
  const dir = join(import.meta.dirname, "fixtures", "subagent-runs");
  const helpers = runningHelpers("/parent/session.jsonl", dir, 10_000);
  assert.deepEqual(helpers, [{ id: "run-a", agent: "worker", task: "Fix the relay reconnect", tools: 22, activityAt: 9000, idleMs: 1000, state: "running" }]);
  assert.deepEqual(runningHelpers(undefined, dir), []);
  assert.deepEqual(runningHelpers("/parent/session.jsonl", join(dir, "missing")), []);
});

test("helper line shows tools and activity, and turns amber after two idle minutes", () => {
  const line = app.helperLine({ id: "r", agent: "worker", task: "Fix <it>", tools: 22, idleMs: 8000 });
  assert.match(line, /<b>worker<\/b><span>· 22 tools · active 8s ago/);
  assert.match(line, /Fix &lt;it&gt;/);
  assert.doesNotMatch(line, /stale/);
  assert.match(app.helperLine({ id: "r", agent: "w", tools: 1, idleMs: 180_000 }), /helper stale.*1 tool ·/);
});
