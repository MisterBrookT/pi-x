import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import registerCapabilities from "../extensions/capabilities.ts";
import registerTool from "../extensions/tool.ts";
import { createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { withSpecialistExposure } from "../src/tool-discovery.ts";
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
const specialist = pi => pi.registerTool(withSpecialistExposure({
  name: "computer", label: "Computer", description: "Browser and desktop interaction",
  promptSnippet: "SPECIALIST_GUIDANCE_SENTINEL",
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: "Specialist called" }], details: {} }; },
}));
// The CLI loads tool_search as a built-in extension; SDK sessions add it themselves.
const extensions = choices => [createToolSearchExtension(), pi => registerCapabilities(pi, choices), specialist, pi => registerTool(pi, choices)];
const tools = ["bash", "background", "goal", "tool_search", "computer"];

test("real Pi loads a specialist on the next request and preserves it through /tool and turns", async t => {
  const choices = settings();
  const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "browser" })
    : index === 1 ? call("computer", {}) : say("done"), { extensions: extensions(choices), tools });
  await h.session.prompt("Use the browser fixture");
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests[0].tools.includes("tool_search"), "tool_search is on without any MCP server");
  assert.ok(!h.requests[0].tools.includes("discover_tools"));
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
  const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "computer" }) : say("done"),
    { extensions: extensions(choices), tools });
  await h.session.prompt("Try discovering computer");
  assert.ok(h.requests.every(request => !request.tools.includes("computer")));
  const result = h.requests[1].messages.find(message => message.role === "toolResult" && message.toolName === "tool_search");
  assert.deepEqual(result.details.blocked, ["computer"]);
  assert.deepEqual(h.extensionErrors, []);
});

test("discovery survives a reload of the same session; explicit choices still win", async t => {
  const choices = settings();
  const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "computer" }) : say("done"),
    { extensions: extensions(choices), tools });
  await h.session.prompt("Discover computer");
  assert.ok(h.session.getActiveToolNames().includes("computer"));
  await h.session.reload();
  assert.ok(h.session.getActiveToolNames().includes("computer"), "a reload keeps what this session discovered");
  choices.update({ computer: false });
  await h.session.reload();
  assert.ok(!h.session.getActiveToolNames().includes("computer"), "an explicit off still wins");
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
  const first = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "computer" }) : say("done"),
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
  const definition = withSpecialistExposure(withPixToolGuidance({ name: "lsp_diagnostics", label: "Diagnostics", description: "Fixture", parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } }));
  const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "lsp_diagnostics" }) : say("done"), {
    extensions: [...extensions(choices), pi => {
      pi.registerTool(definition);
      pi.registerTool({ name: "external_rule", label: "External", description: "Fixture", parameters: Type.Object({}), promptGuidelines: [personal], async execute() { return { content: [], details: {} }; } });
    }], tools: [...tools, "lsp_diagnostics", "external_rule"],
  });
  await h.session.prompt("Find diagnostics");
  const guideline = definition.promptGuidelines[0];
  assert.ok(!h.requests[0].systemPrompt.includes(guideline));
  assert.ok(h.requests[1].systemPrompt.includes(guideline));
  await h.session.prompt("/tool lsp_diagnostics off");
  await h.session.prompt("Continue");
  assert.ok(!h.requests.at(-1).systemPrompt.includes(guideline));
  for (const request of h.requests) assert.ok(request.systemPrompt.includes(personal));
  assert.deepEqual(h.extensionErrors, []);
});

test("Web auto withholds schemas until discovery, stays discovered across reload, and respects off", async t => {
 const choices = settings(); choices.update({ web_search: "auto" });
 const web = pi => pi.registerTool(withSpecialistExposure({ name: "web_search", label: "Search", description: "Web search fixture", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "fixture result" }], details: {} }; } }));
 const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "web search" }) : index === 1 ? call("web_search", {}) : say("done"), { extensions: [...extensions(choices), web], tools: [...tools, "web_search"] });
 await h.session.prompt("Find a web source");
 assert.ok(!h.requests[0].tools.includes("web_search"));
 assert.ok(h.requests[1].tools.includes("web_search"));
 assert.equal(choices.read().web_search, "auto");
 await h.session.reload();
 assert.ok(h.session.getActiveToolNames().includes("web_search"), "a reload mid-task must not drop web search");
 await h.session.prompt("/tool web_search off");
 assert.equal(choices.read().web_search, false);
 assert.ok(!h.session.getActiveToolNames().includes("web_search"));
 assert.deepEqual(h.extensionErrors, []);
});

test("Pix turns on native tool_search without MCP or an explicit tool list", async t => {
  const choices = settings();
  const h = await goalSession(t, () => say("done"), { extensions: extensions(choices), tools: null });
  await h.session.prompt("hello");
  assert.ok(h.requests[0].tools.includes("tool_search"));
  assert.ok(!h.requests[0].tools.includes("computer"));
  assert.ok(!h.requests[0].tools.includes("discover_tools"));
  assert.deepEqual(h.extensionErrors, []);
});

test("an explicit off blocks a codemode script from calling a deferred specialist", async t => {
  const choices = settings(); choices.update({ computer: false });
  const code = "return await tools.computer({});";
  const h = await goalSession(t, ({ index }) => index === 0 ? call("codemode", { code }) : say("done"),
    { extensions: [createCodemodeExtension(), ...extensions(choices)], tools: [...tools, "codemode"] });
  await h.session.prompt("Script the computer");
  const result = h.requests[1].messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
  const text = result.content.map(part => part.text ?? "").join("\n");
  assert.ok(!text.includes("Specialist called"), text);
  assert.match(text, /disabled by the user/);
  assert.deepEqual(h.extensionErrors, []);
});

test("Pix specialists register deferred so Pi's tool_search can load them", () => {
  for (const name of ["computer", "lsp_diagnostics", "lsp_fix", "subagent_supervisor", "web_search", "fetch_content", "get_search_content", "source_check", "video_content"]) {
    const tool = withSpecialistExposure({ name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } });
    assert.equal(tool.exposure, "deferred", name);
    assert.ok(tool.namespace?.name, name);
  }
  for (const name of ["bash", "subagent", "todo", "mcp__calendar__list", "ordinary_extension"]) {
    const tool = withSpecialistExposure({ name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } });
    assert.equal(tool.exposure, undefined, name);
  }
});

test("real Pi discovers the deferred goal tool and starts a goal inside the current turn without a wake", async t => {
  const choices = settings();
  const objective = "Fix the fixture bug, add a regression test, and pass the check.";
  const h = await goalSession(t, ({ index, goal }) => index === 0 ? call("tool_search", { query: "goal substantial multi-step work" })
    : index === 1 ? call("goal", { status: "active", objective })
    : index === 2 ? finish(goal, "completed", "Ran the check: passed.") : say("done"), { extensions: extensions(choices), tools });
  await h.session.prompt("Do this substantial task until it is done");
  await h.session.agent.waitForIdle();
  assert.ok(!h.requests[0].tools.includes("goal"), "goal schema is deferred until discovered");
  assert.ok(h.requests[1].tools.includes("goal"));
  assert.equal(h.state().status, "completed");
  assert.equal(h.state().objective, objective);
  assert.equal(h.state().continuations, 0, "the start needs no continuation");
  assert.ok(JSON.stringify(h.requests[2].messages).includes("Active user goal"), "the goal context joins the running turn");
  assert.equal(h.requests.length, 4, "no extra wake turn");
  assert.ok(!JSON.stringify(h.requests).includes("pix-goal-wake"));
  assert.deepEqual(choices.read(), {});
  assert.deepEqual(h.extensionErrors, []);
});

test("an explicit goal off blocks discovery and agent starts", async t => {
  const choices = settings(); choices.update({ goal: false });
  const h = await goalSession(t, ({ index }) => index === 0 ? call("tool_search", { query: "goal" })
    : index === 1 ? call("goal", { status: "active", objective: "Must not start" }) : say("done"), { extensions: extensions(choices), tools });
  await h.session.prompt("Try to start a goal");
  assert.equal(h.state(), null);
  assert.ok(h.requests.every(request => !request.tools.includes("goal")));
  assert.deepEqual(h.extensionErrors, []);
});
