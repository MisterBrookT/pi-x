import assert from "node:assert/strict";
import test from "node:test";
import { AiCompletion, normalizeContinuation, buildPrompt } from "../plugins/editor/ai-completion.ts";
import { completionSuggestion } from "../plugins/editor/index.ts";

function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (h) => timers.delete(h),
    advance(ms) { now += ms; for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(k); t.fn(); } },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("a phrase stops at the first sentence end or newline and stays short", () => {
  assert.equal(normalizeContinuation("the tests. Then deploy it.", "run "), "the tests.");
  assert.equal(normalizeContinuation(" wait for it\nand more", "no"), " wait for it");
  assert.equal(normalizeContinuation("a b c d e f g h i j k l", "x "), "a b c d e f g h");
  assert.equal(normalizeContinuation("ok now deploy it", "ok now "), "deploy it");
  assert.equal(normalizeContinuation("", "abc"), undefined);
  assert.doesNotMatch(buildPrompt("hi there", []).system, /history/i);
});

test("typing never waits: debounced, cancelled on keypress, timed out, stale results dropped", async () => {
  const s = clock(); const calls = [];
  const ai = new AiCompletion((prompt, signal) => new Promise((resolve, reject) => {
    calls.push({ prompt, signal, resolve });
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }), { scheduler: s });
  assert.equal(ai.suffix("deploy th"), undefined, "nothing synchronous");
  s.advance(299); assert.equal(calls.length, 0, "debounced until ~300ms idle");
  ai.cancel(); assert.equal(ai.suffix("deploy the"), undefined);  // a keypress restarts the debounce
  s.advance(299); assert.equal(calls.length, 0);
  s.advance(1); assert.equal(calls.length, 1);
  ai.cancel(); assert.ok(calls[0].signal.aborted, "keypress cancels the in-flight request");
  calls[0].resolve("late text"); await tick();
  assert.equal(ai.suffix("deploy the"), undefined, "a cancelled reply is never shown");
  s.advance(300); assert.equal(calls.length, 2);
  s.advance(1500); assert.ok(calls[1].signal.aborted, "hard timeout");
  calls[1].resolve("too late"); await tick();
  ai.cancel(); assert.equal(ai.suffix("deploy the"), undefined);
  s.advance(300); calls[2].resolve(" relay now. And more."); await tick();
  assert.equal(ai.suffix("deploy the"), " relay now.");
  assert.equal(ai.suffix("deploy ther"), undefined, "a result only matches the exact text it was asked for");
});

test("word completion shows at once; the AI phrase replaces it only once it has arrived", () => {
  const words = { suffix: (t) => (t.endsWith("dep") ? "loy" : undefined) };
  let ready = false;
  const ai = { isEnabled: () => true, completion: { suffix: () => (ready ? "loy the relay" : undefined) } };
  assert.equal(completionSuggestion("now dep", words, ai), "loy");
  ready = true;
  assert.equal(completionSuggestion("now dep", words, ai), "loy the relay");
  assert.equal(completionSuggestion("/dep", words, ai), undefined);
  assert.equal(completionSuggestion("now dep", words, { isEnabled: () => false, completion: ai.completion }), "loy");
});
