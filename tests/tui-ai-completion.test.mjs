import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PIX_COMPLETE_CONFIG = join(await mkdtemp(join(tmpdir(), "pix-complete-")), "pix-complete.json");
const { default: smartEditor } = await import("../extensions/smart-editor.ts");

const stripCursor = line => line.split("\u001B_pi:c\u0007").join("");
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const plain = text => text;
const editorTheme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: text => `<g>${text}</g>`, scrollInfo: plain, noMatch: plain } };

function createHarness({ replies, model = { provider: "pix-anthropic", id: "claude-haiku-4-5" } }) {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) { (handlers.get(event) ?? handlers.set(event, []).get(event)).push(handler); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  smartEditor(pi);
  const requests = [];
  const notifications = [];
  let factory;
  let selection;
  const ctx = {
    mode: "tui",
    hasUI: true,
    scopedModels: [],
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "user", content: "fix the failing test" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fixed. You may want to run the full suite next." }] } },
      { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ignored" }] } },
    ] },
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? { provider, id } : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [{ provider: "pix-anthropic", id: "claude-haiku-4-5" }, { provider: "openai", id: "gpt-5-mini" }],
      async complete(chosen, context, options) {
        requests.push({ model: chosen, text: context.messages[0].content[0].text, options });
        return { stopReason: "stop", content: [{ type: "text", text: replies(context.messages[0].content[0].text) }] };
      },
    },
    ui: {
      setEditorComponent(value) { factory = value; },
      notify(message, level) { notifications.push({ message, level }); },
      select: async () => selection,
    },
  };
  const start = async () => { for (const handler of handlers.get("session_start")) await handler({}, ctx); };
  const editor = () => {
    const created = factory({ requestRender() {}, terminal: { rows: 24 } }, editorTheme, { matches: () => false });
    created.focused = true;
    return created;
  };
  return { start, editor, requests, notifications, handlers, ctx, command: args => commands.get("complete").handler(args, ctx), select: value => { selection = value; } };
}

test("AI completion is off by default and /complete on persists the preference", async () => {
  const h = createHarness({ replies: () => "the full suite" });
  await h.start();
  const editor = h.editor();
  editor.setText("run ");
  editor.render(80);
  await tick(400);
  assert.equal(h.requests.length, 0, "disabled completion never calls the model");
  await h.command("on");
  assert.match(h.notifications.at(-1).message, /AI completion is on \(pix-anthropic\/claude-haiku-4-5\)/);
  assert.deepEqual(JSON.parse(await readFile(process.env.PIX_COMPLETE_CONFIG, "utf8")), { enabled: true });
  await h.command("bogus");
  assert.match(h.notifications.at(-1).message, /Usage: \/complete/);
});

test("AI ghost text renders from conversation context and is accepted with Tab", async () => {
  const h = createHarness({ replies: text => (text.includes("Partial message") ? "the full suite" : "Commit the fix") });
  await h.start();
  const editor = h.editor();

  editor.render(80);
  await tick();
  assert.match(stripCursor(editor.render(80)[1]), /<g>Commit the fix<\/g>/, "empty editor shows a next-prompt suggestion");
  assert.match(h.requests[0].text, /Agent: Fixed\./);
  assert.doesNotMatch(h.requests[0].text, /ignored/, "tool output stays out of the excerpt");
  assert.deepEqual(h.requests[0].model, { provider: "pix-anthropic", id: "claude-haiku-4-5" });

  editor.setText("run ");
  editor.render(80);
  await tick(400);
  assert.match(stripCursor(editor.render(80)[1]), /run <g>the full suite<\/g>/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "run the full suite");

  editor.setText("/complete");
  await tick(400);
  assert.equal(h.requests.length, 2, "slash commands never request completions");

  await h.handlers.get("agent_end")[0]({}, h.ctx);
  editor.setText("");
  editor.render(80);
  await tick();
  assert.equal(h.requests.length, 3, "a finished agent turn refreshes the next-prompt suggestion");
});

test("enabled AI completion replaces history and dictionary suggestions entirely", async () => {
  let resolveReply;
  const h = createHarness({ replies: () => "unused" });
  h.ctx.modelRegistry.complete = (_model, context) => new Promise(resolve => {
    if (context.messages[0].content[0].text.includes("Partial message")) resolveReply = resolve;
  });
  await h.start();
  await h.command("on");
  const editor = h.editor();
  editor.setText("fix");
  editor.render(80);
  await tick(400);
  assert.ok(resolveReply, "the continuation request was sent");
  assert.doesNotMatch(editor.render(80)[1], /<g>/, "no history ghost while the model is still answering");
  await tick(400);
  resolveReply({ stopReason: "stop", content: [{ type: "text", text: " the flaky test" }] });
  await tick(); await tick();
  assert.match(stripCursor(editor.render(80)[1]), /fix<g> ?the flaky test<\/g>/);
});

test("/complete model picks from the registry and an unavailable model falls back to history", async () => {
  const h = createHarness({ replies: () => "unused", model: { provider: "openai", id: "gpt-5-mini" } });
  await h.start();
  await h.command("on");
  assert.equal(h.notifications.at(-1).level, "warning");
  assert.match(h.notifications.at(-1).message, /unavailable/);
  const editor = h.editor();
  editor.setText("fix");
  editor.render(80);
  await tick(400);
  assert.equal(h.requests.length, 0);
  assert.match(stripCursor(editor.render(80)[1]), /fix<g> the failing test<\/g>/, "history completion still works");

  h.select("openai/gpt-5-mini");
  await h.command("model");
  assert.match(h.notifications.at(-1).message, /on \(openai\/gpt-5-mini\)/);
  assert.deepEqual(JSON.parse(await readFile(process.env.PIX_COMPLETE_CONFIG, "utf8")), { enabled: true, model: { provider: "openai", id: "gpt-5-mini" } });
  await h.command("off");
  assert.match(h.notifications.at(-1).message, /is off/);
});
