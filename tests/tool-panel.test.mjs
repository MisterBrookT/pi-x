import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPanel,
	CAPABILITIES,
	capabilityTargets,
	capabilityById,
	formatTokens,
	panelSummary,
	panelGroup,
} from "../src/tool-panel.ts";

const tool = (name, description = "d") => ({
	name,
	description,
	parameters: { type: "object" },
	sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
});

const ALL = [
	"read", "bash", "todo",
	"web_search", "fetch_content",
	"subagent", "subagent_supervisor",
	"computer", "act_ui", "observe_ui", "launch_browser",
	"mcp", "mcpScript", "mcp__excalidraw",
].map((name) => tool(name));

test("basic tools are listed individually", () => {
	const model = buildPanel(ALL, ["read", "bash", "todo"]);
	const names = model.rows.filter((row) => row.kind === "tool").map((row) => row.name);
	assert.deepEqual(names.sort(), ["bash", "read", "todo"]);
});

test("the four capabilities are single rows, labelled as the user named them", () => {
	const model = buildPanel(ALL, []);
	const labels = model.rows.filter((row) => row.kind === "capability").map((row) => row.label);
	assert.deepEqual(labels, ["Subagent", "Computer", "MCP", "Web"]);
});

test("rows use fixed functional groups and alphabetical names, not schema cost", () => {
	const tools = ["write", "read", "bash", "todo", "goal", "background", "question", "lsp_fix", "lsp_diagnostics", "web_search", "subagent", "custom_z", "custom_a"].map(name => tool(name));
	const model = buildPanel(tools, []);
	assert.deepEqual(model.rows.map(row => row.id), ["bash", "read", "write", "background", "goal", "question", "subagent", "todo", "lsp_diagnostics", "lsp_fix", "web", "custom_a", "custom_z"]);
	assert.deepEqual([...new Set(model.rows.map(panelGroup))], ["Core tools", "Workflow", "Code checks", "Capabilities", "Other"]);
	const changedCosts = tools.toReversed().map((entry, i) => ({ ...entry, description: "x".repeat(i * 1000) }));
	assert.deepEqual(buildPanel(changedCosts, ["read"]).rows.map(row => row.id), model.rows.map(row => row.id));
});

test("the delegation capability is called Subagent, not Delegation", () => {
	const subagent = CAPABILITIES.find((capability) => capability.id === "subagent");
	assert.equal(subagent.label, "Subagent");
	assert.deepEqual(subagent.primary.sort(), ["subagent", "subagent_supervisor"]);
	assert.ok(!CAPABILITIES.some((capability) => /delegation/i.test(capability.label)));
});

test("no tool appears both individually and inside a capability", () => {
	const model = buildPanel(ALL, []);
	const individual = new Set(model.rows.filter((row) => row.kind === "tool").map((row) => row.name));
	for (const row of model.rows) {
		if (row.kind !== "capability") continue;
		for (const owned of row.tools) {
			assert.ok(!individual.has(owned.name), `${owned.name} is listed twice`);
		}
	}
});

test("MCP server tools fold into the MCP capability rather than the basic list", () => {
	const model = buildPanel(ALL, ["mcp__excalidraw"]);
	const individual = model.rows.filter((row) => row.kind === "tool").map((row) => row.name);
	assert.ok(!individual.includes("mcp__excalidraw"));
	const mcp = model.rows.find((row) => row.id === "mcp");
	assert.ok(mcp.tools.some((entry) => entry.name === "mcp__excalidraw"));
});

test("turning Computer on enables only the wrapper, not the backend primitives", () => {
	// Enabling the capability must cost one schema, not twelve; the wrapper
	// calls the primitives itself.
	const computer = capabilityById("computer");
	const targets = capabilityTargets(computer, true, ALL.map((entry) => entry.name));
	assert.deepEqual(targets, ["computer"]);
});

test("turning Computer off clears the primitives too, leaving no schema behind", () => {
	const computer = capabilityById("computer");
	const targets = capabilityTargets(computer, false, ALL.map((entry) => entry.name));
	assert.ok(targets.includes("computer"));
	for (const name of ["act_ui", "observe_ui", "launch_browser"]) {
		assert.ok(targets.includes(name), `${name} should be turned off with the capability`);
	}
});

test("turning MCP off also clears the per-server tools it cannot name in advance", () => {
	const mcp = capabilityById("mcp");
	const targets = capabilityTargets(mcp, false, ALL.map((entry) => entry.name));
	assert.ok(targets.includes("mcp__excalidraw"));
});

test("a capability reads as on when its primary tools are active", () => {
	const on = buildPanel(ALL, ["computer"]).rows.find((row) => row.id === "computer");
	assert.equal(on.on, true);
	assert.equal(on.activeCount, 1);
	assert.equal(on.toolCount, 4, "the advanced view still holds every tool it owns");

	const off = buildPanel(ALL, []).rows.find((row) => row.id === "computer");
	assert.equal(off.on, false);
});

test("a capability whose package is absent is not shown", () => {
	const model = buildPanel([tool("read"), tool("bash")], ["read"]);
	assert.deepEqual(model.rows.map((row) => row.kind), ["tool", "tool"]);
});

test("Computer and MCP default off, Web and Subagent default on", () => {
	const defaults = Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.defaultOn]));
	assert.deepEqual(defaults, { web: true, subagent: true, computer: false, mcp: false });
});

test("token figures are labelled as estimates, not measurements", () => {
	assert.equal(formatTokens(1234), "~1,234 est. tokens");
	assert.match(panelSummary(buildPanel(ALL, ["read"])), /estimated/);
});
