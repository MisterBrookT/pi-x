import assert from "node:assert/strict";
import test from "node:test";
import registerTodo from "../extensions/todo.ts";
import { goalSession, say, call, finish } from "./helpers/goal-session.mjs";

const options = { timeout: 15000 };
const reminders = (h, type) => h.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === type);
const text = request => JSON.stringify(request.messages);
const assertAppendOnly = (requests) => {
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual(requests[i].messages.slice(0, requests[i - 1].messages.length), requests[i - 1].messages,
      `request ${i} must retain every message from request ${i - 1}, including state reminders`);
    assert.equal(requests[i].systemPrompt, requests[i - 1].systemPrompt);
  }
};

test("goal reminders persist and preserve the request prefix across tool turns and completion", options, async t => {
  const h = await goalSession(t, ({ index, goal }) => index < 2
    ? call("bash", { command: "true" }, `check-${index}`)
    : index === 2 ? finish(goal) : say("Verified."));
  await h.session.prompt("/goal Verify the implementation and finish.");
  await h.until(() => h.settledCount() === 1);
  assert.equal(h.state().status, "completed");
  assert.equal(h.requests.length, 4);
  assertAppendOnly(h.requests);
  const saved = reminders(h, "pix-goal-context");
  assert.equal(saved.length, 2, "one active snapshot and one completed snapshot, not one per request");
  assert.ok(saved.every(entry => entry.display === false));
  assert.match(saved.at(-1).content, /completed/);
  assert.match(text(h.requests[0]), /Verify the implementation and finish/);
  assert.deepEqual(h.extensionErrors, []);
});

test("todo updates are durable after tool results, deduplicated, and do not start extra turns", options, async t => {
  const h = await goalSession(t, ({ index }) => {
    if (index === 0) return call("todo", { action: "replace", items: [{ text: "Inspect" }, { text: "Check", dependsOn: ["1"] }] });
    if (index === 1) return call("todo", { action: "set", updates: [{ id: "1", status: "done" }, { id: "2", status: "active" }] });
    if (index === 2) return call("todo", { action: "list" });
    return say("Ready.");
  }, { extensions: [registerTodo], tools: ["todo", "bash"] });
  await h.session.prompt("Inspect and check.");
  assert.equal(h.requests.length, 4);
  assertAppendOnly(h.requests);
  assert.equal(reminders(h, "pix-todo-state").length, 2, "list must not add another identical snapshot");
  assert.match(text(h.requests[2]), /\[active\] #2 Check/);
  for (const request of h.requests.slice(1)) {
    const messages = request.messages;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "assistant") continue;
      const calls = messages[i].content.filter(part => part.type === "toolCall");
      for (const [offset, tool] of calls.entries()) {
        assert.equal(messages[i + offset + 1]?.role, "toolResult", "no reminder may split tool calls and results");
        assert.equal(messages[i + offset + 1]?.toolCallId, tool.id);
      }
    }
  }
  assert.deepEqual(h.extensionErrors, []);
});

test("reload reuses both saved reminders and compaction restores missing state once", options, async t => {
  const pending = pi => pi.events.on("pix:background-state:query", query => { query.running += 1; });
  const compact = pi => pi.on("session_before_compact", (_event, ctx) => ({ compaction: {
    summary: "Earlier context omitted; no goal or todo details retained.",
    firstKeptEntryId: ctx.sessionManager.getLeafId(), tokensBefore: 10000,
  } }));
  const h = await goalSession(t, ({ index }) => index === 0
    ? call("todo", { action: "replace", items: [{ text: "Keep the exact plan" }] }) : say("Waiting."), {
    extensions: [registerTodo, pending, compact], tools: ["todo", "goal"],
    settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1 }, retry: { enabled: false } },
  });
  await h.session.prompt("/goal Keep the exact objective.");
  await h.until(() => h.settledCount() === 1);
  const goalBefore = structuredClone(h.state());
  const counts = () => [reminders(h, "pix-goal-context").length, reminders(h, "pix-todo-state").length];
  assert.deepEqual(counts(), [1, 1]);
  await h.session.reload();
  assert.deepEqual(h.state(), goalBefore);
  assert.deepEqual(counts(), [1, 1], "reload does not duplicate saved reminders");
  await h.session.prompt("Check progress.");
  assertAppendOnly(h.requests);
  assert.deepEqual(counts(), [1, 1]);
  await h.session.compact();
  assert.deepEqual(counts(), [2, 2], "each reminder lost to compaction is restored once");
  assert.deepEqual(h.state(), goalBefore);
  const requestCount = h.requests.length;
  await h.session.sendCustomMessage({ customType: "external-wake", content: "Background work finished.", display: false }, { triggerTurn: true });
  assert.equal(h.requests.length, requestCount + 1);
  assert.match(text(h.requests.at(-1)), /Keep the exact objective/);
  assert.match(text(h.requests.at(-1)), /Keep the exact plan/);
  await h.session.prompt("Check again.");
  assertAppendOnly(h.requests.slice(requestCount));
  assert.deepEqual(counts(), [2, 2]);
  assert.deepEqual(h.extensionErrors, []);
});

test("automatic overflow recovery restores goal and todo before the retry", options, async t => {
  let compactions = 0;
  let retryIndex;
  const observe = pi => pi.on("session_compact", () => { compactions++; });
  const h = await goalSession(t, ({ index, goal, context }) => {
    if (index === 0) return call("todo", { action: "replace", items: [{ text: "Retain the plan" }] });
    if (index === 1) throw new Error("prompt is too long: 40000 tokens > 32768 maximum");
    if (!context.tools?.length) return say("Summary with no goal or plan details.");
    if (goal.status === "active") {
      retryIndex = index;
      assert.equal(compactions, 1);
      assert.match(JSON.stringify(context.messages), /Retain the objective/);
      assert.match(JSON.stringify(context.messages), /Retain the plan/);
      return finish(goal);
    }
    return say("Finished.");
  }, { extensions: [registerTodo, observe], tools: ["todo", "goal"], settings: {
    compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 }, retry: { enabled: false },
  } });
  await h.session.prompt("/goal Retain the objective.");
  await h.until(() => h.settledCount() > 0);
  assert.equal(h.state()?.status, "completed");
  assert.equal(compactions, 1);
  assert.ok(retryIndex > 1);
  assertAppendOnly(h.requests.slice(retryIndex));
  assert.deepEqual(h.extensionErrors, []);
});

test("inactive goal changes append a superseding state instead of removing old instructions", options, async t => {
  const h = await goalSession(t, () => say("Waiting."));
  await h.session.prompt("/goal First objective");
  await h.until(() => h.state()?.status === "paused");
  const before = h.requests.at(-1);
  await h.session.prompt("/goal clear");
  await h.session.prompt("Explain the current state.");
  assertAppendOnly([before, h.requests.at(-1)]);
  assert.match(reminders(h, "pix-goal-context").at(-1).content, /off/i);
  assert.equal(h.state(), null);
});
