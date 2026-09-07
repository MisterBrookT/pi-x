/**
 * Real interface tests for the `/tool` panel.
 *
 * These drive the component the TUI actually renders, with the byte sequences a
 * terminal actually sends, and read the lines that actually reach the screen.
 * A mock that accepts "space" as a string would pass while the real panel
 * ignored a real space bar.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { buildPanel } from "../src/tool-panel.ts";
import { ToolPanelView } from "../src/tool-panel-view.ts";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ENTER = "\r";
const SPACE = " ";
const ESC = "\u001b";

/**
 * The same keys as a terminal that negotiated the Kitty keyboard protocol
 * sends them. pi asks every terminal to upgrade, so these are not an exotic
 * case: they are what the panel actually receives on a modern terminal.
 */
const KITTY = { esc: "\u001b[27u", space: "\u001b[32u", enter: "\u001b[13u", up: "\u001b[A", down: "\u001b[B" };
/** xterm's modifyOtherKeys form, used by terminals that decline Kitty. */
const MODIFY_OTHER_KEYS_ESC = "\u001b[27;1;27~";

const tool = (name, source = "builtin") => ({
	name,
	description: "d",
	parameters: { type: "object" },
	sourceInfo: { source, path: `<builtin:${name}>` },
});

const ALL = ["read", "bash", "web_search", "subagent", "bg_wait", "computer", "act_ui", "observe_ui", "mcp"].map((name) => tool(name));

const view = (active = ["read", "bash"]) => new ToolPanelView({ model: buildPanel(ALL, active) });

const screen = (panel) => panel.render(100).join("\n");

test("the panel lists basic tools individually and capabilities as single rows", () => {
	const text = screen(view());
	assert.match(text, /^> bash /m, "a basic tool has its own row");
	assert.match(text, /^ {2}read /m);
	for (const label of ["Web", "Subagent", "Computer", "MCP"]) {
		assert.match(text, new RegExp(`^ {2}${label} `, "m"), `${label} is one row`);
	}
	assert.doesNotMatch(text, /act_ui/, "backend primitives stay out of the top level");
	assert.doesNotMatch(text, /observe_ui/);
});

test("the tool name comes first on every row", () => {
	const text = screen(view());
	for (const line of text.split("\n").filter((l) => /^[>\s]\s\S/.test(l) && !/^\s*showing/.test(l))) {
		const first = line.replace(/^[>\s]\s+/, "").split(/\s+/)[0];
		assert.ok(/^[A-Za-z]/.test(first), `row should lead with a name: ${line}`);
	}
	// Provenance is trailing context, never a prefix that pushes names out of view.
	assert.match(text, /^ {2}read\s+\S+\s+~[\d,]+ est\. tokens · builtin$/m);
});

test("arrow keys move the cursor and wrap around", () => {
	const panel = view();
	assert.equal(panel.cursorIndex, 0);
	panel.handleInput(DOWN);
	assert.equal(panel.cursorIndex, 1);
	panel.handleInput(UP);
	panel.handleInput(UP);
	// Six rows: two basic tools, then the four capabilities.
	assert.equal(panel.cursorIndex, 5, "wraps to the last row");
	assert.match(screen(panel), /^> MCP/m);
});

test("space toggles the row under the cursor", () => {
	const panel = view();
	assert.deepEqual(panel.handleInput(SPACE), { type: "toggle", row: panel.selected });
	assert.equal(panel.selected.name, "bash", "rows lead with the costliest tool");
});

test("space on a capability row toggles the capability, not one tool", () => {
	const panel = view();
	while (panel.selected.kind !== "capability" || panel.selected.id !== "computer") panel.handleInput(DOWN);
	const action = panel.handleInput(SPACE);
	assert.equal(action.type, "toggle");
	assert.equal(action.row.kind, "capability");
	assert.equal(action.row.id, "computer");
});

test("enter on a capability opens its advanced view instead of toggling", () => {
	const panel = view();
	while (panel.selected.id !== "computer") panel.handleInput(DOWN);
	const action = panel.handleInput(ENTER);
	assert.equal(action.type, "enter", "enter must not be a toggle: that is what space is for");
	assert.equal(action.row.id, "computer");
});

test("the advanced view shows the child tools the top level hides", () => {
	const model = buildPanel(ALL, ["computer"]);
	const computer = model.rows.find((row) => row.id === "computer");
	const advanced = new ToolPanelView({
		model: {
			rows: computer.tools.map((entry) => ({
				kind: "tool",
				id: entry.name,
				name: entry.name,
				on: entry.active,
				tokens: entry.tokens,
				origin: entry.origin,
			})),
			activeTokens: 0,
			activeCount: 1,
			totalCount: computer.tools.length,
		},
		scope: { label: "Computer", summary: computer.summary },
	});
	const text = screen(advanced);
	assert.match(text, /Tools › Computer/, "the header says where you are");
	for (const name of ["computer", "act_ui", "observe_ui"]) {
		assert.match(text, new RegExp(`^[>\\s] ${name}`, "m"));
	}
	assert.match(text, /Esc back/, "escape returns to the top level, it does not close");
});

test("escape closes at the top level and goes back inside a capability", () => {
	assert.deepEqual(view().handleInput(ESC), { type: "close" });
	assert.deepEqual(advancedView().handleInput(ESC), { type: "back" });
});

const advancedView = (options = {}) =>
	new ToolPanelView({
		model: { rows: [], activeTokens: 0, activeCount: 0, totalCount: 0 },
		scope: { label: "Computer", summary: "s" },
		...options,
	});

test("escape goes back when the terminal encodes it as a Kitty sequence", () => {
	// Regression: the panel compared raw bytes against "\u001b", so Esc did
	// nothing on any terminal that accepted pi's keyboard-protocol upgrade.
	setKittyProtocolActive(true);
	try {
		assert.deepEqual(advancedView().handleInput(KITTY.esc), { type: "back" });
		assert.deepEqual(view().handleInput(KITTY.esc), { type: "close" });
	} finally {
		setKittyProtocolActive(false);
	}
});

test("escape goes back when the terminal encodes it as modifyOtherKeys", () => {
	assert.deepEqual(advancedView().handleInput(MODIFY_OTHER_KEYS_ESC), { type: "back" });
});

test("space and enter also work in their Kitty encodings", () => {
	setKittyProtocolActive(true);
	try {
		const panel = view();
		assert.equal(panel.handleInput(KITTY.space).type, "toggle");
		while (panel.selected.id !== "computer") panel.handleInput(KITTY.down);
		assert.equal(panel.handleInput(KITTY.enter).type, "enter");
		assert.equal(panel.handleInput(KITTY.up).type, "move");
	} finally {
		setKittyProtocolActive(false);
	}
});

test("the panel matches keys through the host's keybindings, not its own copy", () => {
	// `ui.custom` hands the factory pi's KeybindingsManager. Reading it is what
	// makes a user's rebound select keys work inside this panel too.
	const asked = [];
	const keybindings = {
		matches: (data, keybinding) => {
			asked.push(keybinding);
			return keybinding === "tui.select.cancel" && data === "x";
		},
	};
	assert.deepEqual(advancedView({ keybindings }).handleInput("x"), { type: "back" });
	assert.ok(asked.includes("tui.select.cancel"));
});

test("the default keybindings are pi's real select bindings", () => {
	// Guards the wiring rather than a hardcoded list: if pi rebinds cancel, the
	// panel follows without a change here.
	const kb = getKeybindings();
	assert.ok(kb.matches(ESC, "tui.select.cancel"));
	assert.deepEqual(advancedView().handleInput(ESC), { type: "back" });
});

test("the hint line names the keys that actually work on the current row", () => {
	const panel = view();
	assert.match(screen(panel), /Space toggle · Esc close/, "a plain tool has nothing to open");

	while (panel.selected.kind !== "capability") panel.handleInput(DOWN);
	assert.match(screen(panel), /Space toggle · Enter open · Esc close/);
});

test("a capability row shows how many of its tools are on, as an estimate", () => {
	const panel = view(["computer"]);
	const line = screen(panel).split("\n").find((l) => l.includes("Computer"));
	assert.match(line, /1\/3 tools/, "so the advanced view holds no surprises");
	assert.match(line, /~[\d,]+ est\. tokens/);
	assert.match(line, /▸/, "and signals that it opens");
});

test("a capability row names the packages its tools came from", () => {
	// Provenance is the question "is this mine or a third party's", and a
	// capability can span packages, so one name is not enough.
	const mixed = [
		tool("computer", "npm:@brooktang/pi-x"),
		tool("act_ui", "npm:@injaneity/pi-computer-use"),
		tool("observe_ui", "npm:@injaneity/pi-computer-use"),
		tool("read"),
	];
	const panel = new ToolPanelView({ model: buildPanel(mixed, ["computer"]) });
	const line = screen(panel).split("\n").find((l) => l.includes("Computer"));
	assert.match(line, /pi-x, pi-computer-use/, "both packages are named, the local one first");
	assert.match(screen(panel), /^> read\s+\S+\s+~[\d,]+ est\. tokens · builtin$/m, "a plain tool still names its origin");
});

test("provenance survives a themed render at a realistic width", () => {
	// Regression: the row was trimmed by string length, so the ANSI escapes a
	// theme adds counted as visible cells and cut the trailing origin off rows
	// that fit the screen. Plain-theme tests could not see it.
	const theme = {
		title: (t) => `\u001b[1m${t}\u001b[0m`,
		muted: (t) => `\u001b[90m${t}\u001b[0m`,
		label: (t) => `\u001b[36m${t}\u001b[0m`,
		value: (t) => `\u001b[32m${t}\u001b[0m`,
		cursor: "›",
	};
	const panel = new ToolPanelView({ model: buildPanel(ALL, ["read"]), theme });
	const text = panel.render(72).join("\n");
	assert.match(text, /builtin/, "the origin is still on the row");
	assert.doesNotMatch(text, /…/, "nothing was trimmed: the row fits in 72 cells");
});

test("the header states the active count and calls the token figure estimated", () => {
	assert.match(screen(view(["read", "bash"])), /2 of 9 tools active · ~[\d,]+ est\. tokens per request \(estimated\)/);
});

test("toggling refreshes the rendered state without moving the cursor", () => {
	const panel = view(["read", "bash"]);
	assert.match(screen(panel), /^> bash\s+on/m);

	// The extension rebuilds the model after a toggle and hands it back.
	panel.setModel(buildPanel(ALL, ["read"]));
	assert.equal(panel.cursorIndex, 0, "the cursor stays where the user left it");
	assert.match(screen(panel), /^> bash\s+off/m);
	assert.match(screen(panel), /^ {2}read\s+on/m, "other rows keep their state");
});

test("an unrecognised key changes nothing", () => {
	const panel = view();
	const before = screen(panel);
	assert.deepEqual(panel.handleInput("q"), { type: "none" });
	assert.equal(screen(panel), before);
});

test("a long list scrolls rather than overflowing the terminal", () => {
	const many = Array.from({ length: 40 }, (_, i) => tool(`tool_${String(i).padStart(2, "0")}`));

	const panel = new ToolPanelView({ model: buildPanel(many, []), maxVisible: 8 });
	const rows = screen(panel).split("\n").filter((l) => /tool_\d\d/.test(l));
	assert.equal(rows.length, 8);
	assert.match(screen(panel), /showing 1-8 of 40/);
});
