import { settingsFor } from "./helpers/tool-settings.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKittyProtocolActive } from "@earendil-works/pi-tui";
import registerTool from "../extensions/tool.ts";

const tool = (name, description = "d") => ({
	name,
	description,
	parameters: { type: "object" },
	sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
});

// `grep` stands in for an expensive individually-listed tool: `computer` is now
// a capability id, so using it here would exercise the knob, not a plain tool.
const HEAVY = "grep";

const harness = ({ all = ["read", "bash", HEAVY], active = ["read", "bash", HEAVY], sessionManager = SessionManager.inMemory(), mode = "tui", settings = settingsFor(sessionManager) } = {}) => {
	let activeTools = [...active];
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	const pi = {
		getAllTools: () => all.map((name) => tool(name, name === HEAVY ? "x".repeat(3000) : "d")),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => { activeTools = [...names]; },
		registerCommand: (name, value) => commands.set(name, value),
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
			sessionManager.appendCustomEntry(customType, data);
		},
	};
	registerTool(pi, settings);
	const notices = [];
	const custom = [];
	const ctx = {
		mode,
		sessionManager,
		ui: {
			notify: (message, level) => notices.push({ message, level }),
			custom: async (factory, options) => { custom.push({ factory, options }); },
		},
	};
	return {
		ctx, notices, entries, sessionManager, settings,
		/**
		 * Build the component the way pi's `ui.custom` does, with a real
		 * `KeybindingsManager` and a real theme shape, so the keys the panel reads
		 * are the keys the host would actually give it.
		 */
		mountPanel: async () => {
			await commands.get("tool").handler("", ctx);
			const { factory } = custom.at(-1);
			const results = [];
			const component = await factory(
				{ requestRender: () => {} },
				{ fg: (_colour, text) => text, bold: (text) => text },
				new KeybindingsManager(TUI_KEYBINDINGS),
				(result) => results.push(result),
			);
			return { component, results };
		},
		activeTools: () => activeTools,
		run: (args = "") => commands.get("tool").handler(args, ctx),
		completions: (prefix) => commands.get("tool").getArgumentCompletions(prefix),
		emit: (event) => handlers.get(event)?.({}, ctx),
		commandNames: () => [...commands.keys()],
	};
};

test("/tool registers one command", () => {
	assert.deepEqual(harness().commandNames(), ["tool"]);
});

test("/tool list shows every tool with its cost, grouped by origin", async () => {
	const h = harness({ active: ["read"] });
	await h.run("list");
	const text = h.notices.at(-1).message;
	assert.match(text, /1 of 3 tools active/);
	assert.match(text, /^builtin {2}\(1\/3 active · ~\d+ tok\)$/m, "the group states its own share");
	assert.match(text, /^ {2}on {2}read/m);
	assert.match(text, new RegExp(`^ {2}off ${HEAVY}`, "m"));
	// Within a group the heaviest tool leads, so the cost is obvious.
	const body = text.split("\n").filter((line) => line.startsWith("  "));
	assert.ok(body[0].includes(HEAVY), "the most expensive tool leads");
});

test("disabling a tool removes it from the active set and reports the saving", async () => {
	const h = harness();
	await h.run(`${HEAVY} off`);
	assert.ok(!h.activeTools().includes(HEAVY));
	assert.match(h.notices.at(-1).message, /grep off · frees ~[\d,]+ est\. tokens per request/);
});

test("enabling a tool restores it", async () => {
	const h = harness({ active: ["read"] });
	await h.run(`${HEAVY} on`);
	assert.ok(h.activeTools().includes(HEAVY));
});

test("a choice survives reload and branch navigation", async () => {
	const h = harness();
	await h.run(`${HEAVY} off`);

	// A fresh load of the same session must reach the same active set.
	const reloaded = harness({ sessionManager: h.sessionManager });
	await reloaded.emit("session_start");
	assert.ok(!reloaded.activeTools().includes(HEAVY), "the choice is restored");
	assert.ok(reloaded.activeTools().includes("read"), "untouched tools are left alone");

	await reloaded.emit("session_tree");
	assert.ok(!reloaded.activeTools().includes(HEAVY), "and holds after branch navigation");
});

test("only explicit choices persist, so new tools are not silently withheld", async () => {
	// Saving the resolved set would freeze the session against later releases:
	// a tool added afterwards would be missing from the list and stay off.
	const h = harness();
	await h.run(`${HEAVY} off`);
	assert.deepEqual(h.settings.read(), { [HEAVY]: false });
	assert.equal(h.entries.length, 0, "choices no longer write conversation entries");

	const upgraded = harness({
		sessionManager: h.sessionManager,
		all: ["read", "bash", HEAVY, "brand_new_tool"],
		active: ["read", "bash", HEAVY, "brand_new_tool"],
	});
	await upgraded.emit("session_start");
	assert.ok(upgraded.activeTools().includes("brand_new_tool"), "a newly shipped tool stays available");
	assert.ok(!upgraded.activeTools().includes(HEAVY), "the explicit choice still holds");
});

test("a later choice supersedes an earlier one for the same tool", async () => {
	const h = harness();
	await h.run(`${HEAVY} off`);
	await h.run(`${HEAVY} on`);
	const reloaded = harness({ sessionManager: h.sessionManager, active: [] });
	await reloaded.emit("session_start");
	assert.ok(reloaded.activeTools().includes(HEAVY));
});

test("a saved choice for a tool that no longer exists is ignored", async () => {
	const h = harness();
	await h.run(`${HEAVY} off`);
	const without = harness({ sessionManager: h.sessionManager, all: ["read"], active: ["read"] });
	await without.emit("session_start");
	assert.deepEqual(without.activeTools(), ["read"]);
});

test("querying one tool reports its state without changing anything", async () => {
	const h = harness();
	await h.run(HEAVY);
	assert.match(h.notices.at(-1).message, /grep is on · ~[\d,]+ est\. tokens · builtin/);
	assert.deepEqual(h.activeTools().sort(), ["bash", "grep", "read"]);
	assert.equal(h.entries.length, 0, "a query is not a change");
});

test("querying a capability reports how many of its tools are on", async () => {
	const h = harness({ all: ["read", "computer", "act_ui"], active: ["read", "computer"] });
 h.settings.update({computer:true});
	await h.run("computer");
	assert.match(h.notices.at(-1).message, /Computer is on · 1\/2 tools · ~[\d,]+ est\. tokens/);
	assert.equal(h.entries.length, 0, "a query is not a change");
});

test("an unknown name is refused with a pointer to the list", async () => {
	const h = harness();
	await h.run("nope off");
	assert.equal(h.notices.at(-1).level, "error");
	assert.match(h.notices.at(-1).message, /No tool or capability named nope/);
});

test("without a TUI the command prints the table instead of opening a picker", async () => {
	const h = harness({ mode: "print" });
	await h.run();
	assert.match(h.notices.at(-1).message, /tools active/);
});

test("completions offer tool names annotated with state and cost", () => {
	const h = harness({ active: ["read"] });
	const options = h.completions(HEAVY);
	assert.equal(options.length, 1);
	assert.equal(options[0].value, HEAVY);
	assert.match(options[0].description, /off · ~[\d,]+ est\. tokens · builtin/);
	assert.equal(h.completions("zzz"), null);
});

test("completions never offer the same name twice", () => {
	// A capability's primary tool is both a capability row and a child tool.
	const h = harness({ all: ["read", "computer", "act_ui"], active: ["computer"] });
	const values = h.completions("").map((option) => option.value);
	assert.deepEqual(values, [...new Set(values)]);
});

/**
 * The panel as the host mounts it.
 *
 * The user-visible failure was "Esc does not go back", which lives in the seam
 * between pi's `ui.custom` and this panel, not in either alone. These drive the
 * real factory with pi's real `KeybindingsManager`.
 */
const ESC = "\u001b";
const KITTY_ESC = "\u001b[27u";
const ENTER = "\r";

test("Esc inside a capability goes back to the top level instead of closing", async () => {
	const h = harness({ all: ["read", "computer", "act_ui"], active: ["read"] });
	const { component, results } = await h.mountPanel();

	// Walk to the Computer row and open it.
	while (!component.render(80).join("\n").match(/^› Computer/m)) component.handleInput("\u001b[B");
	component.handleInput(ENTER);
	assert.match(component.render(80).join("\n"), /Tools › Computer/);

	component.handleInput(ESC);
	assert.doesNotMatch(component.render(80).join("\n"), /Tools › Computer/, "Esc returned to the top level");
	assert.equal(results.length, 0, "and did not close the panel");

	component.handleInput(ESC);
	assert.equal(results.length, 1, "a second Esc closes it");
});

test("Esc still goes back when the terminal speaks the Kitty keyboard protocol", async () => {
	setKittyProtocolActive(true);
	try {
		const h = harness({ all: ["read", "computer", "act_ui"], active: ["read"] });
		const { component, results } = await h.mountPanel();
		while (!component.render(80).join("\n").match(/^› Computer/m)) component.handleInput("\u001b[B");
		component.handleInput("\u001b[13u");
		assert.match(component.render(80).join("\n"), /Tools › Computer/);

		component.handleInput(KITTY_ESC);
		assert.doesNotMatch(component.render(80).join("\n"), /Tools › Computer/);
		assert.equal(results.length, 0);
	} finally {
		setKittyProtocolActive(false);
	}
});

test("the mounted panel shows provenance on capability and tool rows alike", async () => {
	const h = harness({ all: ["read", "computer", "act_ui"], active: ["read"] });
	const { component } = await h.mountPanel();
	const text = component.render(80).join("\n");
	assert.match(text, /^› read\s+\S+\s+~[\d,]+ est\. tokens · builtin$/m);
	assert.match(text, /^ {2}Computer\s.*· builtin {2}▸$/m, "a capability names its packages too");
});

test('settings write failure in a keyboard callback does not crash the TUI', async () => {
 const settings={read:()=>({}),update:()=>{throw new Error('settings busy');}};
 const h=harness({settings});
 const {component}=await h.mountPanel();
 assert.doesNotThrow(()=>component.handleInput(' '));
 assert.match(h.notices.at(-1).message,/Could not update tool settings: settings busy/);
});
