import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import registerCapabilities from "../extensions/capabilities.ts";
import registerTool from "../extensions/tool.ts";
import { toolSettings } from "../src/tool-settings.ts";
import { buildPanel, defaultToolMode, toolChoice } from "../src/tool-panel.ts";
import { MCP_TOOL_NAMES, discoveryMatches } from "../src/tool-discovery.ts";
import { goalSession, call, say } from "./helpers/goal-session.mjs";

const root = await mkdtemp(join(tmpdir(), "pix-mcp-runtime-"));
const environment = { PI_CODING_AGENT_DIR: root, PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory", PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1" };
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await rm(root, { recursive: true, force: true });
});

async function setup(t, script = () => say("done"), server = false, overrides = {}, fromFile = false) {
  const dir = await mkdtemp(join(root, "case-"));
  const { registerMcp } = await createJiti(import.meta.url).import("../extensions/mcp.ts");
  const settings = toolSettings(dir);
  settings.update(overrides);
  let owned;
  const config = { mcpServers: server ? { fixture: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-stdio.mjs", import.meta.url))], lifecycle: "eager", directTools: server === "search" ? "search" : true } } : {}, settings: { notifyOnStartupConnect: false, mcpFooterStatus: "off" } };
  const configPath = join(dir, "mcp.json");
  if (fromFile) await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const h = await goalSession(t, script, { tools: null, extensions: [
    pi => registerCapabilities(pi, settings),
    pi => { registerMcp(pi, settings, fromFile ? { configPath } : { config }); const state = {}; pi.events.emit(MCP_TOOL_NAMES, state); owned = state.names; },
    pi => registerTool(pi, settings),
  ] });
  return { ...h, settings, owned, configPath };
}

test("real MCP engine cannot enable its gateway during startup; auto remains deferred", async t => {
  const h = await setup(t);
  assert.ok(h.owned.has("mcp"));
  assert.ok(!h.session.getActiveToolNames().includes("mcp"));
  await h.session.prompt("Check available tools");
  assert.ok(!h.requests[0].tools.includes("mcp"));
  assert.ok(!h.requests[0].systemPrompt.includes("MCP gateway"));
  assert.deepEqual(h.settings.read(), {});
  assert.deepEqual(h.extensionErrors, []);
});

test("MCP discovery exposes a concise gateway; on/off/default stay synchronized", async t => {
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcp" }) : say("done"));
  await h.session.prompt("Discover MCP");
  assert.ok(h.requests[1].tools.includes("mcp"), JSON.stringify({ requests: h.requests.map(r => r.tools), results: h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult"), errors: h.extensionErrors }));
  assert.ok(h.requests[1].systemPrompt.includes("Search and call MCP server tools"));
  assert.ok(!h.requests[1].tools.includes("mcpScript"), "an exact gateway request should not load scripting");
  assert.deepEqual(h.settings.read(), {});
  await h.session.prompt("/tool mcp off");
  assert.ok(!h.session.getActiveToolNames().includes("mcp"));
  await h.session.prompt("/tool mcp on");
  assert.ok(h.session.getActiveToolNames().includes("mcp"));
  await h.session.prompt("/tool mcp auto");
  assert.ok(!h.session.getActiveToolNames().includes("mcp"));
  assert.deepEqual(h.settings.read(), {});
  assert.deepEqual(h.extensionErrors, []);
});

test("saved MCP off survives initialization, discovery attempts, and reload", async t => {
  const h = await setup(t, ({ index }) => index % 2 === 0 ? call("discover_tools", { query: "mcp", limit: 1 }) : say("done"), false, { mcp: false });
  await h.session.prompt("Find MCP");
  assert.ok(!h.requests[1].tools.includes("mcp"));
  await h.session.reload();
  await h.session.prompt("Find MCP again");
  assert.ok(h.requests.every(request => !request.tools.includes("mcp")));
  assert.equal(h.settings.read().mcp, false);
  assert.deepEqual(h.extensionErrors, []);
});

test("MCP discovery resets on reload and new sessions", async t => {
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcp" }) : say("done"));
  await h.session.prompt("Find MCP");
  assert.ok(h.session.getActiveToolNames().includes("mcp"));
  await h.session.reload();
  assert.ok(!h.session.getActiveToolNames().includes("mcp"));
  const fresh = await setup(t);
  assert.ok(!fresh.session.getActiveToolNames().includes("mcp"));
  assert.deepEqual(fresh.extensionErrors, []);
  assert.deepEqual(h.extensionErrors, []);
});

test("existing MCP configuration is read without conversion or rewriting", async t => {
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcp" }) : index === 1 ? call("mcp", { tool: "fixture_echo", args: { text: "config verified" } }) : say("done"), true, {}, true);
  const before = await readFile(h.configPath, "utf8");
  await h.session.prompt("Use the existing server configuration");
  assert.match(JSON.stringify(h.sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult")), /echo:config verified/);
  assert.equal(await readFile(h.configPath, "utf8"), before);
  assert.deepEqual(h.extensionErrors, []);
});

test("MCP setup suggests no third-party servers of its own", async () => {
  const { KNOWN_SERVER_PRESETS, loadMcpConfig } = await createJiti(import.meta.url).import("../vendor/mcp/config.ts");
  assert.deepEqual(KNOWN_SERVER_PRESETS, [], "no vendor menu of unrequested integrations");
  assert.deepEqual(Object.keys(loadMcpConfig(undefined, root).mcpServers ?? {}), [], "nothing is configured implicitly");
});

test("custom-prefix MCP tools share discovery and panel policies without renaming", () => {
  const names = new Set(["fixture_echo"]);
  assert.equal(defaultToolMode("fixture_echo", names), "auto");
  assert.equal(toolChoice("fixture_echo", { mcp: false }, names), false, "family off covers newly registered tools");
  assert.equal(toolChoice("fixture_echo", { mcp: false, fixture_echo: true }, names), true, "an explicit individual choice wins");
  assert.deepEqual(discoveryMatches([{ name: "fixture_echo", description: "Echo text" }], "fixture_echo", 1, names), ["fixture_echo"]);
  const panel = buildPanel([{ name: "fixture_echo", description: "Echo text", parameters: {} }], [], undefined, names);
  assert.equal(panel.rows.length, 1);
  assert.equal(panel.rows[0].id, "mcp");
  assert.deepEqual(discoveryMatches([{ name: "mcp" }, { name: "mcpScript" }], "MCP", 2), ["mcp"]);
  assert.deepEqual(discoveryMatches([{ name: "mcp" }], "mcp", 0), []);
});

test("MCP search mode activates matched direct tools through the real runtime", async t => {
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcp" }) : index === 1 ? call("mcp", { search: "echo" }) : index === 2 ? call("fixture_echo", { text: "search verified" }) : say("done"), "search");
  await h.session.prompt("Find and call echo");
  assert.ok(h.requests[2].tools.includes("fixture_echo"));
  assert.match(JSON.stringify(h.sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult")), /echo:search verified/);
  assert.deepEqual(h.extensionErrors, []);
});

test("vendored scripting worker can search, describe, and call a real MCP server", async t => {
  const code = 'const found = await tools.search({query: "echo"}); const tool = await tools.describe({path: found.items[0].path}); emit(await tools.call(tool.path, {text: "script verified"}));';
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcpScript" }) : index === 1 ? call("mcpScript", { code }) : say("done"), true);
  await h.session.prompt("Run the MCP script");
  assert.ok(!h.requests[1].tools.includes("mcp"), "scripting discovery should not load the gateway");
  assert.match(JSON.stringify(h.sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult")), /echo:script verified/);
  assert.deepEqual(h.extensionErrors, []);
});

test("real stdio MCP transport discovers and calls a server tool without leaking schemas at startup", async t => {
  const h = await setup(t, ({ index }) => index === 0 ? call("discover_tools", { query: "mcp", limit: 1 }) : index === 1 ? call("mcp", { tool: "fixture_echo", args: { text: "contract verified" } }) : say("done"), true);
  await h.session.prompt("Call the local MCP fixture");
  assert.ok(!h.requests[0].tools.some(name => h.owned.has(name)));
  const results = h.sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "mcp");
  assert.match(JSON.stringify(results), /echo:contract verified/);
  assert.ok(h.owned.has("fixture_echo"), "retain the server's existing direct-tool name");
  assert.ok(!h.requests[2].tools.includes("fixture_echo"), "a gateway call does not opt into unrelated direct schemas");
  await h.session.prompt("/tool mcp off");
  await h.session.prompt("/mcp reconnect fixture");
  assert.ok(!h.session.getActiveToolNames().some(name => h.owned.has(name)), "reconnect must respect off");
  await h.session.prompt("/tool mcp auto");
  await h.session.prompt("/mcp reconnect fixture");
  assert.ok(!h.session.getActiveToolNames().some(name => h.owned.has(name)), "reconnect must not activate auto tools");
  assert.deepEqual(h.extensionErrors, []);
});
