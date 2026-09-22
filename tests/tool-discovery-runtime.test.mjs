import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import registerCapabilities from "../extensions/capabilities.ts";
import registerTool from "../extensions/tool.ts";
import { discoveryMatches } from "../src/tool-discovery.ts";
import { withPixToolGuidance } from "../src/tool-guidance.ts";
import { goalSession, call, say, finish } from "./helpers/goal-session.mjs";

const settings = () => {
  const overrides = {};
  return { read: () => ({ ...overrides }), update: changes => {
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete overrides[name]; else overrides[name] = value;
    }
    return { ...overrides };
  } };
};
const specialist = pi => pi.registerTool({
  name: "computer", label: "Computer", description: "Browser and desktop interaction",
  promptSnippet: "SPECIALIST_GUIDANCE_SENTINEL",
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: "Specialist called" }], details: {} }; },
});
const extensions = choices => [pi => registerCapabilities(pi, choices), specialist, pi => registerTool(pi, choices)];
const tools = ["bash", "background", "goal", "discover_tools", "computer"];

test("real Pi loads a specialist on the next request and preserves it through /tool and turns", async t => {
  const choices = settings();
  const h = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "browser" })
    : index === 1 ? call("computer", {}) : say("done"), { extensions: extensions(choices), tools });
  await h.session.prompt("Use the browser fixture");
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests[0].tools.includes("discover_tools"));
  assert.ok(!h.requests[0].tools.includes("computer"));
  assert.ok(!h.requests[0].tools.includes("goal"));
  assert.ok(!h.requests[0].systemPrompt.includes("SPECIALIST_GUIDANCE_SENTINEL"));
  assert.ok(h.requests[1].tools.includes("computer"));
  assert.ok(h.requests[1].systemPrompt.includes("SPECIALIST_GUIDANCE_SENTINEL"));
  assert.deepEqual(choices.read(), {}, "discovery must not persist global choices");
  await h.session.prompt("/tool list");
  await h.session.prompt("Continue");
  assert.ok(h.requests.at(-1).tools.includes("computer"));
  await h.session.prompt("/tool computer off");
  await h.session.prompt("Continue without computer");
  assert.ok(!h.requests.at(-1).tools.includes("computer"));
  await h.session.prompt("/tool computer auto");
  assert.deepEqual(choices.read(), {});
  assert.ok(!h.session.getActiveToolNames().includes("computer"));
  assert.deepEqual(h.extensionErrors, []);
});

test("explicit off choices cannot be bypassed by discovery", async t => {
  const choices = settings(); choices.update({ computer: false });
  const h = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "computer" }) : say("done"),
    { extensions: extensions(choices), tools });
  await h.session.prompt("Try discovering computer");
  assert.ok(h.requests.every(request => !request.tools.includes("computer")));
  const result = h.requests[1].messages.find(message => message.role === "toolResult" && message.toolName === "discover_tools");
  assert.deepEqual(result.details.blocked, ["computer"]);
  assert.deepEqual(h.extensionErrors, []);
});

test("session-local discovery resets on reload; explicit on choices survive", async t => {
  const choices = settings();
  const h = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "computer" }) : say("done"),
    { extensions: extensions(choices), tools });
  await h.session.prompt("Discover computer");
  assert.ok(h.session.getActiveToolNames().includes("computer"));
  await h.session.reload();
  assert.ok(!h.session.getActiveToolNames().includes("computer"));
  choices.update({ computer: true });
  await h.session.reload();
  assert.ok(h.session.getActiveToolNames().includes("computer"));
  assert.deepEqual(h.extensionErrors, []);
});

test("goal schema appears only for an active goal and disappears upon completion", async t => {
  const choices = settings();
  const h = await goalSession(t, ({ goal }) => goal?.status === "active" ? finish(goal) : say("done"),
    { extensions: extensions(choices), tools });
  assert.ok(!h.session.getActiveToolNames().includes("goal"));
  await h.session.prompt("/goal Check the fixture");
  await h.until(() => h.state()?.status === "completed");
  await h.until(() => h.settledCount() > 0);
  assert.ok(h.requests.some(request => request.tools.includes("goal")));
  assert.ok(!h.session.getActiveToolNames().includes("goal"));
  assert.deepEqual(h.extensionErrors, []);
});

test("discovery does not leak into another session sharing the same settings", async t => {
  const choices = settings();
  const first = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "computer" }) : say("done"),
    { extensions: extensions(choices), tools });
  await first.session.prompt("Discover computer");
  const second = await goalSession(t, () => say("done"), { extensions: extensions(choices), tools });
  assert.ok(first.session.getActiveToolNames().includes("computer"));
  assert.ok(!second.session.getActiveToolNames().includes("computer"));
});

test("goal commands respect explicit off choices", async t => {
  const choices = settings(); choices.update({ goal: false });
  const h = await goalSession(t, () => say("unexpected"), { extensions: extensions(choices), tools });
  await h.session.prompt("/goal Must not start");
  assert.equal(h.state(), null);
  assert.equal(h.requests.length, 0);
  assert.ok(!h.session.getActiveToolNames().includes("goal"));
});

test("tool-owned guidance follows activation without rewriting unrelated instructions", async t => {
  const choices = settings();
  const personal = "Use lsp_diagnostics when files need diagnostics; preserve this exact external instruction.";
  const definition = withPixToolGuidance({ name: "lsp_diagnostics", label: "Diagnostics", description: "Fixture", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } });
  const h = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "lsp_diagnostics" }) : say("done"), {
    extensions: [...extensions(choices), pi => {
      pi.registerTool(definition);
      pi.registerTool({ name: "external_rule", label: "External", description: "Fixture", parameters: Type.Object({}), promptGuidelines: [personal], async execute() { return { content: [], details: {} }; } });
    }], tools: [...tools, "lsp_diagnostics", "external_rule"],
  });
  await h.session.prompt("Find diagnostics");
  const guideline = definition.promptGuidelines[0];
  assert.ok(!h.requests[0].systemPrompt.includes(guideline));
  assert.ok(h.requests[0].systemPrompt.includes("use discover_tools to find a specialist"));
  assert.ok(h.requests[1].systemPrompt.includes(guideline));
  await h.session.prompt("/tool lsp_diagnostics off");
  await h.session.prompt("Continue");
  assert.ok(!h.requests.at(-1).systemPrompt.includes(guideline));
  for (const request of h.requests) assert.ok(request.systemPrompt.includes(personal));
  assert.deepEqual(h.extensionErrors, []);
});

test("Web auto withholds schemas until discovery, persists across reload, and respects off", async t => {
 const choices = settings(); choices.update({ web_search: "auto" });
 const web = pi => pi.registerTool({ name: "web_search", label: "Search", description: "Web search fixture", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "fixture result" }], details: {} }; } });
 const h = await goalSession(t, ({ index }) => index === 0 ? call("discover_tools", { query: "web_search" }) : index === 1 ? call("web_search", {}) : say("done"), { extensions: [...extensions(choices), web], tools: [...tools, "web_search"] });
 await h.session.prompt("Find a web source");
 assert.ok(!h.requests[0].tools.includes("web_search"));
 assert.ok(h.requests[1].tools.includes("web_search"));
 assert.equal(choices.read().web_search, "auto");
 await h.session.reload();
 assert.ok(!h.session.getActiveToolNames().includes("web_search"));
 await h.session.prompt("/tool web_search off");
 assert.equal(choices.read().web_search, false);
 assert.ok(!h.session.getActiveToolNames().includes("web_search"));
 assert.deepEqual(h.extensionErrors, []);
});

test("discovery is bounded, deterministic, skips backend primitives and unknown capabilities", () => {
  const catalog = ["computer", "act_ui", "lsp_fix", "lsp_diagnostics", "mcp__calendar", "ordinary_extension"].map(name => ({ name, description: name }));
  assert.deepEqual(discoveryMatches(catalog, "browser", 2), ["computer"]);
  assert.deepEqual(discoveryMatches(catalog, "lsp_fix", 2), ["lsp_fix"]);
  assert.equal(discoveryMatches(catalog, "code", 1).length, 1);
  assert.deepEqual(discoveryMatches(catalog, "calendar", 2), ["mcp__calendar"]);
  assert.deepEqual(discoveryMatches(catalog, "ordinary_extension", 2), []);
  assert.deepEqual(discoveryMatches(catalog, "unknown-capability", 2), []);
  assert.deepEqual(discoveryMatches(catalog, "   ", 2), []);
});
