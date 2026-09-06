import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerComputer from "../extensions/computer.ts";

const okResult = (text, stateId) => ({
	content: [{ type: "text", text }],
	details: { stateId },
});

/** A fake backend module matching the real bridge's executor signature. */
const createFakeBackend = () => {
	const seen = [];
	let counter = 0;
	const executor = (name) => (toolCallId, params, signal, onUpdate, ctx) => {
		seen.push({ name, toolCallId, params, ctx });
		counter += 1;
		return Promise.resolve(okResult(`@e1 window "App"\n@e9 button "Send"`, `S${counter}`));
	};
	let setupCalls = 0;
	return {
		seen,
		setupCalls: () => setupCalls,
		module: {
			executeFind: executor("find_roots"),
			executeObserve: executor("observe_ui"),
			executeSearchUi: executor("search_ui"),
			executeExpandUi: executor("expand_ui"),
			executeInspectUi: executor("inspect_ui"),
			executeAct: executor("act_ui"),
			executeReadText: executor("read_text"),
			executeWaitFor: executor("wait_for"),
			executeLaunchBrowser: executor("launch_browser"),
			executeNavigateBrowser: executor("navigate_browser"),
			executeEvaluateBrowser: (toolCallId, params) => {
				seen.push({ name: "evaluate_browser", params });
				return Promise.resolve({
					content: [{ type: "text", text: `@e1 page\nEvaluation value: 42` }],
					details: { stateId: "S99" },
				});
			},
			ensureComputerUseSetup: async () => {
				setupCalls += 1;
			},
		},
	};
};

const harness = ({ backend, mode = "tui", confirmAnswer = true, tcc = "kTCCServiceAccessibility|2\nkTCCServiceScreenCapture|2" } = {}) => {
	let tool;
	const pi = {
		registerTool: (value) => { tool = value; },
		registerCommand: () => {},
		exec: async () => ({ code: 0, stdout: tcc, stderr: "" }),
	};
	registerComputer(pi, backend ? { backend } : undefined);
	const confirms = [];
	const ctx = {
		mode,
		ui: {
			confirm: async (title, body) => {
				confirms.push(`${title}: ${body}`);
				return confirmAnswer;
			},
		},
	};
	return { tool, ctx, confirms };
};

/** Returns the parsed arguments; throws when the call does not match the schema. */
const validate = (tool, args) =>
	validateToolArguments(tool, { type: "toolCall", id: "test", name: tool.name, arguments: args });

test("registers a single computer tool with a valid schema", () => {
	const { tool } = harness();
	assert.equal(tool.name, "computer");
	assert.equal(tool.executionMode, "sequential");
	assert.deepEqual(validate(tool, { script: "return 1;" }), { script: "return 1;" });
	assert.deepEqual(validate(tool, { script: "x", maxActions: 5 }), { script: "x", maxActions: 5 });
	assert.throws(() => validate(tool, {}), "script is required");
	assert.throws(() => validate(tool, { script: "x", maxActions: 0 }), "maxActions has a floor");
});

test("the description documents the cua API the model must write against", () => {
	const { tool } = harness();
	for (const fragment of ["cua.observe", "state.act", "state.eval", "expect"]) {
		assert.match(tool.description, new RegExp(fragment.replace(".", "\\.")), `missing ${fragment}`);
	}
});

test("guidelines name the tool explicitly so bullets are unambiguous", () => {
	const { tool } = harness();
	assert.ok(tool.promptGuidelines.length > 0);
	for (const line of tool.promptGuidelines) assert.match(line, /computer/);
});

test("reports a clear install hint when the backend is absent", async () => {
	const { tool, ctx } = harness();
	const result = await tool.execute("call-1", { script: "return 1;" }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /pi install npm:@injaneity\/pi-computer-use/);
});

test("runs a script against the backend and returns its value", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module });
	const result = await tool.execute(
		"call-1",
		{ script: `const s = await cua.observe({ root: "@r1" }); await s.search({ text: "x" }); return s.id;` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, false);
	assert.equal(result.details.value, "S1");
	assert.deepEqual(backend.seen.map((c) => c.name), ["observe_ui", "search_ui"]);
	assert.equal(backend.setupCalls(), 1, "setup runs before the script");
});

test("backend executors receive the tool call id and context", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module });
	await tool.execute("call-42", { script: `await cua.observe(); return 1;` }, undefined, undefined, ctx);
	assert.equal(backend.seen[0].toolCallId, "call-42");
	assert.equal(backend.seen[0].ctx, ctx);
});

test("an irreversible action prompts through ctx.ui.confirm and proceeds when allowed", async () => {
	const backend = createFakeBackend();
	const { tool, ctx, confirms } = harness({ backend: backend.module, confirmAnswer: true });
	const result = await tool.execute(
		"call-1",
		{ script: `const s = await cua.observe(); await s.act({ action: "press", ref: "@e9" }); return "sent";` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(confirms.length, 1);
	assert.match(confirms[0], /press @e9/);
	assert.equal(result.details.value, "sent");
	assert.ok(backend.seen.some((c) => c.name === "act_ui"));
});

test("declining the prompt fails the script and never reaches the backend", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module, confirmAnswer: false });
	const result = await tool.execute(
		"call-1",
		{ script: `const s = await cua.observe(); await s.act({ action: "press", ref: "@e9" }); return "sent";` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /User declined/);
	assert.ok(!backend.seen.some((c) => c.name === "act_ui"));
});

test("without a TUI there is no gate, so irreversible actions are refused", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module, mode: "headless" });
	const result = await tool.execute(
		"call-1",
		{ script: `const s = await cua.observe(); await s.act({ action: "press", ref: "@e9" }); return 1;` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /without a confirmation gate/);
	assert.ok(!backend.seen.some((c) => c.name === "act_ui"));
});

test("maxActions bounds the script and the failure names the budget", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module });
	const result = await tool.execute(
		"call-1",
		{
			script: `let s = await cua.observe(); while (true) s = await s.act({ action: "click", ref: "@e1" });`,
			maxActions: 2,
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /exceeded 2 UI actions/);
	assert.equal(result.details.actions, 2);
});

test("the rendered result carries log, trace, and result for the model", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module });
	const result = await tool.execute(
		"call-1",
		{ script: `const s = await cua.observe(); log("looking"); return 7;` },
		undefined,
		undefined,
		ctx,
	);
	const text = result.content[0].text;
	assert.match(text, /Log:\n {2}looking/);
	assert.match(text, /Trace \(1 calls, 0 actions\)/);
	assert.match(text, /Result: 7/);
});

test("a failing script still returns the trace of what already ran", async () => {
	const backend = createFakeBackend();
	const { tool, ctx } = harness({ backend: backend.module });
	const result = await tool.execute(
		"call-1",
		{ script: `await cua.observe(); await cua.roots(); throw new Error("late failure");` },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /observe_ui/);
	assert.match(result.content[0].text, /find_roots/);
	assert.match(result.content[0].text, /Error: late failure/);
});

test("a missing permission blocks the script before the backend is touched", async () => {
	const backend = createFakeBackend();
	let tool;
	registerComputer(
		{
			registerTool: (v) => { tool = v; },
			registerCommand: () => {},
			exec: async () => ({ code: 0, stdout: "kTCCServiceAccessibility|0", stderr: "" }),
		},
		{ backend: backend.module },
	);
	const result = await tool.execute("c1", { script: "return 1;" }, undefined, undefined, { mode: "tui", ui: {} });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Accessibility — denied/);
	assert.equal(backend.setupCalls(), 0, "setup is not attempted without permissions");
	assert.equal(backend.seen.length, 0);
});

test("/computer-check reports backend and permission state together", async () => {
	const backend = createFakeBackend();
	let command;
	registerComputer(
		{
			registerTool: () => {},
			registerCommand: (name, value) => {
				assert.equal(name, "computer-check");
				command = value;
			},
			exec: async () => ({ code: 0, stdout: "kTCCServiceAccessibility|2\nkTCCServiceScreenCapture|2", stderr: "" }),
		},
		{ backend: backend.module },
	);
	const notices = [];
	await command.handler("", { ui: { notify: (text, level) => notices.push({ text, level }) } });
	assert.equal(notices[0].level, "info");
	assert.match(notices[0].text, /Backend @injaneity\/pi-computer-use loaded/);
	assert.match(notices[0].text, /Computer use is ready/);
});
