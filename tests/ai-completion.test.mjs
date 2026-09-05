import assert from "node:assert/strict";
import test from "node:test";
import { AiCompletion, buildPrompt, normalizeContinuation, normalizeSuggestion, shouldRequestCompletion } from "../src/ai-completion.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeScheduler {
  pending = [];
  setTimeout(callback) { const handle = { callback }; this.pending.push(handle); return handle; }
  clearTimeout(handle) { this.pending = this.pending.filter(item => item !== handle); }
  fire() { const items = this.pending; this.pending = []; for (const { callback } of items) callback(); }
}

test("continuation replies are normalized into ghost suffixes", () => {
    assert.equal(normalizeContinuation("please run the tests", "please run"), " the tests");
  assert.equal(normalizeContinuation("\"  the tests\"\nsecond line", "please run "), "the tests second line");
  assert.equal(normalizeContinuation("mit this change", "com"), "mit this change");
  assert.equal(normalizeContinuation("", "anything"), undefined);
  assert.equal(normalizeContinuation("please run", "please run"), undefined);
  assert.equal(normalizeSuggestion("1. \"Run the tests\"\nor commit"), "Run the tests or commit");
});

test("only prose prompts of some length trigger requests", () => {
  assert.equal(shouldRequestCompletion(""), false);
  assert.equal(shouldRequestCompletion("/complete"), false);
  assert.equal(shouldRequestCompletion("!ls"), false);
  assert.equal(shouldRequestCompletion("fi"), false);
  assert.equal(shouldRequestCompletion("fix"), true);
});

test("prompts include a bounded excerpt of the recent conversation", () => {
  const turns = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn ${i} ${"x".repeat(2000)}` }));
  const { system, user } = buildPrompt({ kind: "continue", text: "now ru" }, turns);
  assert.match(system, /predict what the user will type/);
  assert.doesNotMatch(user, /turn 0|turn 1/);
  assert.match(user, /turn 5/);
  assert.match(user, /Typed so far:\nnow ru/);
  assert.ok(user.length < 800 * 3 + 2500 + 400);
  assert.match(buildPrompt({ kind: "suggest" }, []).user, /no prior conversation/);
});

test("typing debounces and cancels in-flight requests; results are cached", async () => {
  const scheduler = new FakeScheduler();
  const calls = [];
  const completion = new AiCompletion((prompt, signal) => {
    calls.push({ prompt, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      setTimeout(() => resolve(prompt.user.includes("commi\n") ? "t the change" : "mit the change"), 0);
    });
  }, { scheduler });
  let updates = 0;
  completion.onUpdate = () => updates++;
  completion.setConversation([{ role: "assistant", text: "Done." }]);

  assert.equal(completion.suffix("com"), undefined);
  assert.equal(completion.suffix("comm"), undefined);
  assert.equal(scheduler.pending.length, 1, "retyping replaces the pending timer");
  scheduler.fire();
  assert.equal(calls.length, 1);
  assert.equal(completion.suffix("commi"), undefined);
  assert.ok(calls[0].signal.aborted, "new input aborts the in-flight request");
  scheduler.fire();
  await tick(); await tick();
  assert.equal(calls.length, 2);
  assert.equal(completion.suffix("commi"), "t the change");
  assert.equal(updates, 1, "only the surviving request repaints");
  assert.equal(completion.suffix("commi"), "t the change");
  assert.equal(calls.length, 2, "cached text does not trigger another request");
});

test("empty editor proposes the next prompt once per conversation state", async () => {
  const scheduler = new FakeScheduler();
  let replies = 0;
  const completion = new AiCompletion(async prompt => {
    replies++;
    assert.match(prompt.system, /predict what the user will type/);
    return "Run npm test";
  }, { scheduler });
  assert.equal(completion.suffix(""), undefined, "no conversation, no suggestion");
  await tick();
  assert.equal(replies, 0);
  completion.setConversation([{ role: "assistant", text: "Fixed the bug." }]);
  assert.equal(completion.suffix(""), undefined);
  assert.equal(completion.suffix("   "), undefined);
  await tick();
  assert.equal(replies, 1);
  assert.equal(completion.suffix(""), "Run npm test");
  completion.setConversation([{ role: "assistant", text: "Tests pass." }]);
  assert.equal(completion.suffix(""), undefined, "new turn invalidates the old suggestion");
  await tick();
  assert.equal(replies, 2);
});

test("stale replies from a previous conversation state are discarded", async () => {
  let resolveFirst;
  const completion = new AiCompletion(() => new Promise(resolve => { resolveFirst = resolve; }));
  completion.setConversation([{ role: "assistant", text: "A" }]);
  completion.suffix("");
  completion.setConversation([{ role: "assistant", text: "B" }]);
  resolveFirst("stale");
  await tick();
  assert.notEqual(completion.suffix(""), "stale");
});
