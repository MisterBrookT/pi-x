import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerTodo, { hasTodoDependencyCycle, unmetTodoDependencies } from "../extensions/todo.ts";

const createTodoHarness = (sessionManager = SessionManager.inMemory()) => {
  let tool;
  let command;
  let widget;
  let activeTools = ["read", "todo"];
  const handlers = new Map();
  const notifications = [];
  const theme = new Theme(
    { accent: "#00ffff", text: "#ffffff", muted: "#888888", error: "#ff0000", toolTitle: "#00ffff", thinkingXhigh: "#ffffff" },
    { selectedBg: "#000000" }, "truecolor",
  );
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(value) { tool = value; },
    registerCommand(name, value) { assert.equal(name, "todo"); command = value; },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(value) { activeTools = value; },
  };
  registerTodo(pi);
  const ctx = {
    sessionManager,
    ui: {
      setWidget(name, value) {
        assert.equal(name, "pix-todo");
        widget = typeof value === "function" ? value(undefined, theme) : value;
      },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  const call = async (input) => {
    const args = validateToolArguments(tool, { type: "toolCall", id: "test", name: "todo", arguments: tool.prepareArguments(input) });
    const result = await tool.execute("test", args, undefined, undefined, ctx);
    sessionManager.appendMessage({ role: "toolResult", toolCallId: "test", toolName: "todo", ...structuredClone(result), isError: result.isError ?? false, timestamp: 0 });
    return result;
  };
  return {
    call, tool, theme, sessionManager, notifications,
    event: (name) => handlers.get(name)({}, ctx),
    command: (args) => command.handler(args, ctx),
    activeTools: () => activeTools,
    widget: () => widget,
    render: (width = 100) => widget?.render(width).map(stripVTControlCharacters) ?? [],
  };
};

const text = (result) => result.content[0].text;

const rejectsWithoutChange = async (call, input, message) => {
  const before = (await call({ action: "list" })).details;
  await assert.rejects(call(input), message);
  const after = (await call({ action: "list" })).details;
  assert.deepEqual(after.items, before.items);
  assert.equal(after.nextId, before.nextId);
};

test("todo dependencies block work until every prerequisite is done", async () => {
  const { call } = createTodoHarness();
  await call({ action: "add", text: "Inspect backend" });
  await call({ action: "add", text: "Inspect frontend" });
  await call({ action: "add", text: "Integrate", dependsOn: [1, "2"] });

  const listed = await call({ action: "list" });
  assert.match(text(listed), /\[blocked: #1, #2\] #3 Integrate \(depends on #1, #2\)/);

  await rejectsWithoutChange(call, { action: "set", id: 3, status: "active" }, /#3 is blocked by #1, #2/);

  await call({ action: "set", id: 1, status: "done" });
  await rejectsWithoutChange(call, { action: "set", id: 3, status: "done" }, /#3 is blocked by #2/);

  await call({ action: "set", id: 2, status: "done" });
  const ready = await call({ action: "set", id: 3, status: "active" });
  assert.equal(ready.isError, undefined);
  assert.equal(text(ready), "#3 → active");
});

test("todo rejects unknown and self dependencies without consuming an ID", async () => {
  const { call } = createTodoHarness();
  await rejectsWithoutChange(call, { action: "add", text: "Invalid", dependsOn: [99] }, /unknown dependencies: #99/);
  await rejectsWithoutChange(call, { action: "add", text: "Invalid", dependsOn: [1] }, /#1 cannot depend on itself/);

  const valid = await call({ action: "add", text: "First valid item" });
  assert.equal(text(valid), "Added #1");
});

test("todo dependency helpers identify blocked tasks and cycles", () => {
  const items = [
    { id: "1", text: "One", status: "pending", dependsOn: ["2"] },
    { id: "2", text: "Two", status: "done", dependsOn: ["1"] },
  ];
  assert.deepEqual(unmetTodoDependencies(items[0], items), []);
  assert.equal(hasTodoDependencyCycle(items), true);
  assert.equal(hasTodoDependencyCycle([{ ...items[0], dependsOn: [] }, items[1]]), false);
});

for (const dependentStatus of ["active", "done"]) {
  test(`reopening a prerequisite refuses to invalidate ${dependentStatus} dependents`, async () => {
    const { call } = createTodoHarness();
    await call({ action: "add", text: "Prerequisite" });
    await call({ action: "add", text: "Dependent", dependsOn: ["1"] });
    await call({ action: "set", id: "1", status: "done" });
    await call({ action: "set", id: "2", status: dependentStatus });
    for (const status of ["pending", "active"]) {
      await rejectsWithoutChange(call, { action: "set", id: "1", status }, /Reset dependents #2 to pending first/);
    }
    await call({ action: "set", id: "2", status: "pending" });
    assert.equal((await call({ action: "set", id: "1", status: "pending" })).isError, undefined);
    assert.match(text(await call({ action: "list" })), /\[blocked: #1\] #2/);
  });
}

test("replace creates an entire parallel plan in one call and resets old IDs", async () => {
  const { call } = createTodoHarness();
  await call({ action: "add", text: "Old plan" });
  await call({ action: "add", text: "Old step" });
  const result = await call({ action: "replace", items: [
    { text: " Backend " },
    { text: "Frontend" },
    { text: "Summarize", dependsOn: [1, "2", "1"] },
  ] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.items, [
    { id: "1", text: "Backend", status: "pending" },
    { id: "2", text: "Frontend", status: "pending" },
    { id: "3", text: "Summarize", status: "pending", dependsOn: ["1", "2"] },
  ]);
  assert.match(text(result), /\[blocked: #1, #2\] #3/);
  assert.equal(text(await call({ action: "add", text: "Next" })), "Added #4");
});

test("replace supports forward dependencies and nested tasks without implicit ordering", async () => {
  const { call } = createTodoHarness();
  const result = await call({ action: "replace", items: [
    { text: "Review", dependsOn: ["1.1", "2"] },
    { text: "Child", parentId: 1 },
    { text: "Independent" },
  ] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.items.map(item => item.id), ["1", "1.1", "2"]);
  assert.equal(result.details.nextId, 3);
  assert.match(text(result), / {2}\[pending\] #1\.1 Child/);
  assert.equal((await call({ action: "set", id: "1.1", status: "active" })).isError, undefined);
  assert.equal((await call({ action: "set", id: "2", status: "active" })).isError, undefined);
  assert.equal(text(await call({ action: "add", text: "Another child", parentId: 1 })), "Added #1.2");
});

for (const [name, items, message] of [
  ["blank text", [{ text: "Good" }, { text: "  " }], /text is required/],
  ["missing dependency", [{ text: "Good", dependsOn: ["9"] }], /unknown dependencies/],
  ["self dependency", [{ text: "Bad", dependsOn: ["1"] }], /cannot depend on itself/],
  ["cycle", [{ text: "A", dependsOn: ["2"] }, { text: "B", dependsOn: ["1"] }], /cycle/],
  ["missing parent", [{ text: "Child", parentId: "9" }], /parentId/],
  ["nested parent", [{ text: "A" }, { text: "B", parentId: "1" }, { text: "C", parentId: "1.1" }], /parentId/],
]) {
  test(`invalid replacement (${name}) preserves the previous plan and ID allocation`, async () => {
    const { call } = createTodoHarness();
    await call({ action: "add", text: "Keep me" });
    await rejectsWithoutChange(call, { action: "replace", items }, message);
    assert.equal(text(await call({ action: "add", text: "Next" })), "Added #2");
  });
}

test("replace requires a non-empty items array without clearing existing work", async () => {
  const { call } = createTodoHarness();
  await call({ action: "add", text: "Keep" });
  await rejectsWithoutChange(call, { action: "replace" }, /items is required/);
  await assert.rejects(call({ action: "replace", items: [] }), /Validation failed/);
  await assert.rejects(call({ action: "replace", items: [{}] }), /Validation failed/);
  assert.match(text(await call({ action: "list" })), /#1 Keep/);
});

test("session restore and branch navigation preserve the correct whole plan", async () => {
  const original = createTodoHarness();
  const old = await original.call({ action: "add", text: "Old plan" });
  const oldLeaf = original.sessionManager.getLeafId();
  const replacement = await original.call({ action: "replace", items: [
    { text: "Parent" }, { text: "Child", parentId: "1", dependsOn: ["2"] }, { text: "Prerequisite" },
  ] });
  await original.call({ action: "set", id: "2", status: "done" });
  const latest = await original.call({ action: "list" });
  original.sessionManager.appendMessage({ role: "user", content: "Unrelated", timestamp: 0 });
  original.sessionManager.appendCustomEntry("other", {});
  original.sessionManager.appendMessage({ role: "toolResult", toolCallId: "other", toolName: "read", content: [], details: {}, isError: false, timestamp: 0 });

  const restored = createTodoHarness(original.sessionManager);
  restored.event("session_start");
  assert.deepEqual((await restored.call({ action: "list" })).details.items, latest.details.items);
  assert.equal(text(await restored.call({ action: "add", text: "More" })), "Added #3");
  // Saved snapshots must not be mutated by subsequent progress updates.
  assert.equal(replacement.details.items[2].status, "pending");

  restored.sessionManager.branch(oldLeaf);
  restored.event("session_tree");
  assert.deepEqual((await restored.call({ action: "list" })).details.items, old.details.items);
  assert.equal(text(await restored.call({ action: "add", text: "Alternate" })), "Added #2");
  restored.sessionManager.newSession();
  restored.event("session_start");
  assert.equal(text(await restored.call({ action: "list" })), "No todos");
  assert.deepEqual(restored.render(), []);
});

test("restores legacy numeric IDs and todos without dependencies", async () => {
  const h = createTodoHarness();
  h.sessionManager.appendMessage({ role: "toolResult", toolCallId: "legacy", toolName: "todo", content: [], isError: false, timestamp: 0, details: {
    action: "add", nextId: 3, items: [
      { id: 1, text: "Legacy", status: "done" },
      { id: 1.1, parentId: 1, text: "Child", status: "pending", dependsOn: [2] },
      { id: 2, text: "Other", status: "pending" },
    ],
  } });
  h.event("session_start");
  const items = (await h.call({ action: "list" })).details.items;
  assert.deepEqual(items[1], { id: "1.1", parentId: "1", text: "Child", status: "pending", dependsOn: ["2"] });
  assert.equal(items[0].dependsOn, undefined);
  assert.match(h.render().join("\n"), /× #1.1 Child ← #2/);
});

test("widget and slash command show readiness, progress and toggling", async () => {
  const h = createTodoHarness();
  await h.call({ action: "replace", items: [
    { text: "Inspect" }, { text: "Independent child", parentId: "1" }, { text: "Summarize", dependsOn: ["1"] },
  ] });
  assert.deepEqual(h.render(), ["○ #1 Inspect", "  ○ #1.1 Independent child", "× #2 Summarize ← #1"]);
  await h.call({ action: "set", id: "1", status: "active" });
  assert.match(h.render()[0], /^› #1/);
  assert.ok(h.widget().render(12).every(line => visibleWidth(line) <= 12));
  await h.command("");
  assert.match(h.notifications.at(-1).message, /\[blocked: #1\] #2/);

  await h.command("off");
  assert.deepEqual(h.activeTools(), ["read"]);
  assert.equal(h.widget(), undefined);
  await h.command("on");
  assert.deepEqual(h.activeTools(), ["read", "todo"]);
  assert.equal(h.render().length, 3);

  await h.call({ action: "set", id: "1", status: "done" });
  assert.deepEqual(h.render(), ["  ○ #1.1 Independent child", "○ #2 Summarize"]);
  await h.command("");
  assert.match(h.notifications.at(-1).message, /\[pending\] #2 Summarize/);
  for (const id of ["1.1", "2"]) await h.call({ action: "set", id, status: "done" });
  assert.equal(h.widget(), undefined);
});

test("tool result rendering reads failure status from Pi's renderer context", () => {
  const { tool, theme } = createTodoHarness();
  const result = { content: [{ type: "text", text: "Blocked" }], details: undefined };
  const options = { expanded: false, isPartial: false };
  const context = {
    args: { action: "set", id: "2", status: "active" }, toolCallId: "test", invalidate() {},
    lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true,
    argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: true,
  };
  const lines = tool.renderResult(result, options, theme, context).render(100);
  assert.ok(lines.join("\n").includes(theme.fg("error", "Blocked")));
});

test("widget stays bounded and clear resets the whole plan", async () => {
  const h = createTodoHarness();
  await h.call({ action: "replace", items: Array.from({ length: 8 }, (_, i) => ({ text: `Step ${i + 1}` })) });
  assert.equal(h.render().length, 6);
  await h.call({ action: "clear" });
  assert.equal(h.widget(), undefined);
  assert.equal(text(await h.call({ action: "list" })), "No todos");
  assert.equal(text(await h.call({ action: "add", text: "Fresh" })), "Added #1");
});
