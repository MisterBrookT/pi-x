import assert from "node:assert/strict";
import test from "node:test";
import {
	BudgetExceededError,
	ConfirmationRequiredError,
	DEFAULT_BUDGET,
	ScriptHaltedError,
	createCuaRuntime,
	extractEvaluationValue,
	isIrreversible,
	labelForRef,
	renderOutcome,
	stateIdOf,
	summarizeActions,
} from "../src/computer-script.ts";
import { ScriptCompileError, compileScript, runScript } from "../src/computer-runner.ts";

/** Fake backend: records calls, returns outlines with incrementing state ids. */
const createFakeOperations = (overrides = {}) => {
	const calls = [];
	let counter = 0;
	const state = (text) => {
		counter += 1;
		return { content: [{ type: "text", text }], details: { stateId: `S${counter}` } };
	};
	const record = (name) => (params) => {
		calls.push({ name, params });
		return Promise.resolve(state(`@e1 window "App"\n@e9 button "Send"`));
	};
	const operations = {
		find: record("find"),
		observe: record("observe"),
		search: record("search"),
		expand: record("expand"),
		inspect: record("inspect"),
		act: record("act"),
		readText: record("readText"),
		waitFor: record("waitFor"),
		launchBrowser: record("launchBrowser"),
		navigateBrowser: record("navigateBrowser"),
		evaluateBrowser: (params) => {
			calls.push({ name: "evaluateBrowser", params });
			return Promise.resolve({
				content: [{ type: "text", text: `@e1 page\nEvaluation value: ${JSON.stringify(["a", "b"])}` }],
				details: { stateId: "S99" },
			});
		},
		...overrides,
	};
	return { operations, calls };
};

/**
 * `options.operations` overrides individual backend methods; everything else is
 * passed to the runtime. Spreading options last would put the raw override
 * object back on the `operations` key and drop the fake, so it is removed here.
 */
const runtimeFor = ({ operations: overrides, ...rest } = {}) => {
	const { operations, calls } = createFakeOperations(overrides);
	return { runtime: createCuaRuntime({ ...rest, operations }), calls };
};

test("observe returns a state carrying the backend stateId and outline", async () => {
	const { runtime } = runtimeFor();
	const state = await runtime.cua.observe({ root: "@r1" });
	assert.equal(state.id, "S1");
	assert.match(state.text, /button "Send"/);
});

test("returned states clone safely, directly and inside result containers", async () => {
	const { runtime } = runtimeFor();
	const outcome = await runScript(`
		const observed = await cua.observe();
		await observed.search({ text: "App" });
		const acted = await observed.act({ action: "setText", ref: "@e1", text: "hi" });
		const page = await cua.launchBrowser("https://example.com");
		const navigated = await page.navigate("https://example.org");
		const rebound = await cua.state(observed.id);
		return { observed, states: [acted, page, navigated, rebound] };
	`, runtime);
	assert.equal(outcome.error, undefined);
	const states = [outcome.value.observed, ...outcome.value.states];
	for (const state of states) {
		assert.equal(typeof state.search, "function", "methods remain usable in scripts");
		assert.deepEqual(structuredClone(state), { id: state.id, text: state.text });
	}
	assert.deepEqual(structuredClone(outcome.value), {
		observed: { id: states[0].id, text: states[0].text },
		states: states.slice(1).map(({ id, text }) => ({ id, text })),
	});
	assert.doesNotThrow(() => structuredClone(outcome));
});

test("act threads the successor stateId so the script never re-observes", async () => {
	const { runtime, calls } = runtimeFor();
	const first = await runtime.cua.observe();
	const second = await first.act({ action: "setText", ref: "@e1", text: "hi" });
	assert.equal(first.id, "S1");
	assert.equal(second.id, "S2");
	const actCall = calls.find((c) => c.name === "act");
	assert.equal(actCall.params.stateId, "S1", "acts against the state it was derived from");
});

test("queries are answered against the owning state id", async () => {
	const { runtime, calls } = runtimeFor();
	const state = await runtime.cua.observe();
	await state.search({ text: "Send" });
	await state.inspect("@e9");
	assert.equal(calls.find((c) => c.name === "search").params.stateId, "S1");
	assert.equal(calls.find((c) => c.name === "inspect").params.stateId, "S1");
});

test("expect is forwarded to the backend verbatim", async () => {
	const { runtime, calls } = runtimeFor();
	const state = await runtime.cua.observe();
	const expect = { text: "Sent", until: "present", timeoutMs: 2000 };
	await state.act({ action: "press", ref: "@e1" }, expect);
	assert.deepEqual(calls.find((c) => c.name === "act").params.expect, expect);
});

test("action budget stops a runaway loop before it acts", async () => {
	const { runtime } = runtimeFor({ budget: { maxActions: 2, maxCalls: 100 } });
	let state = await runtime.cua.observe();
	state = await state.act({ action: "click", ref: "@e1" });
	state = await state.act({ action: "click", ref: "@e1" });
	await assert.rejects(
		() => state.act({ action: "click", ref: "@e1" }),
		(error) => error instanceof BudgetExceededError && /2 UI actions/.test(error.message),
	);
	assert.equal(runtime.actionCount(), 2, "the refused action is not counted");
});

test("non-mutating queries do not consume the action budget", async () => {
	const { runtime } = runtimeFor({ budget: { maxActions: 1, maxCalls: 100 } });
	const state = await runtime.cua.observe();
	await state.search({ text: "a" });
	await state.inspect("@e9");
	await state.act({ action: "click", ref: "@e1" });
	assert.equal(runtime.actionCount(), 1);
});

test("call budget bounds even a read-only runaway script", async () => {
	const { runtime } = runtimeFor({ budget: { maxActions: 50, maxCalls: 3 } });
	const state = await runtime.cua.observe();
	await state.search({ text: "a" });
	await state.search({ text: "b" });
	await assert.rejects(() => state.search({ text: "c" }), BudgetExceededError);
});

test("irreversible actions are refused when no confirmation gate is wired", async () => {
	const { runtime, calls } = runtimeFor();
	const state = await runtime.cua.observe();
	await assert.rejects(
		() => state.act({ action: "press", ref: "@e9" }),
		(error) => error instanceof ConfirmationRequiredError && /without a confirmation gate/.test(error.message),
	);
	assert.equal(calls.filter((c) => c.name === "act").length, 0, "nothing reached the backend");
});

test("a declined confirmation aborts without touching the backend", async () => {
	const { runtime, calls } = runtimeFor({ confirm: async () => false });
	const state = await runtime.cua.observe();
	await assert.rejects(() => state.act({ action: "press", ref: "@e9" }), ConfirmationRequiredError);
	assert.equal(calls.filter((c) => c.name === "act").length, 0);
});

test("an approved irreversible action is asked once, not once per loop iteration", async () => {
	const asked = [];
	const { runtime } = runtimeFor({
		confirm: async (summary) => {
			asked.push(summary);
			return true;
		},
	});
	let state = await runtime.cua.observe();
	for (let i = 0; i < 3; i += 1) state = await state.act({ action: "press", ref: "@e9" });
	assert.equal(asked.length, 1, "the identical summary is remembered");
	assert.equal(asked[0], "press @e9");
});

test("reversible actions never prompt", async () => {
	let asked = 0;
	const { runtime } = runtimeFor({
		confirm: async () => {
			asked += 1;
			return true;
		},
	});
	const state = await runtime.cua.observe();
	await state.act({ action: "setText", ref: "@e1", text: "draft" });
	assert.equal(asked, 0);
});

test("labelForRef resolves an element label from the outline", () => {
	const outline = `@e1 window "App"\n@e9   button "Send"\n@e10  button "Save draft"`;
	assert.equal(labelForRef(outline, "@e9"), 'button "Send"');
	assert.equal(labelForRef(outline, "@e10"), 'button "Save draft"');
	assert.equal(labelForRef(outline, "@e404"), undefined);
});

test("isIrreversible keys on the element label, not the action verb", () => {
	const outline = `@e9 button "Send"\n@e10 button "Save draft"`;
	assert.equal(isIrreversible([{ action: "press", ref: "@e9" }], outline), true);
	assert.equal(isIrreversible([{ action: "press", ref: "@e10" }], outline), false);
	assert.equal(isIrreversible([{ action: "setText", ref: "@e9", text: "x" }], outline), false);
});

test("summarizeActions produces a stable, human-readable summary", () => {
	assert.equal(
		summarizeActions([
			{ action: "setText", ref: "@e7", text: "hello" },
			{ action: "press", ref: "@e9" },
		]),
		'setText @e7 "hello"; press @e9',
	);
});

test("eval returns the parsed value, not the outline text", async () => {
	const { runtime } = runtimeFor();
	const state = await runtime.cua.observe();
	assert.deepEqual(await state.eval("[...document.links].map(a => a.href)"), ["a", "b"]);
});

test("extractEvaluationValue falls back to raw text for non-JSON", () => {
	assert.deepEqual(extractEvaluationValue("x\nEvaluation value: {\"a\":1}"), { a: 1 });
	assert.equal(extractEvaluationValue("x\nEvaluation value: undefined"), "undefined");
	assert.equal(extractEvaluationValue("no marker here"), undefined);
});

test("every backend call and log line lands in the trace in order", async () => {
	const { runtime } = runtimeFor({ confirm: async () => true });
	const state = await runtime.cua.observe();
	runtime.log("checking");
	await state.act({ action: "press", ref: "@e9" });
	assert.deepEqual(
		runtime.events.map((e) => `${e.kind}:${e.name}`),
		["call:observe_ui", "log:checking", "call:act_ui", "action:press @e9"],
	);
});

// --- runner ---------------------------------------------------------------

test("a script can loop and return a value in one call", async () => {
	const { runtime, calls } = runtimeFor();
	const outcome = await runScript(
		`
		const state = await cua.observe({ root: "@r1" });
		let n = 0;
		for (let i = 0; i < 3; i += 1) { await state.search({ text: "row" + i }); n += 1; }
		log("searched", n);
		return n;
		`,
		runtime,
	);
	assert.equal(outcome.error, undefined);
	assert.equal(outcome.value, 3);
	assert.equal(calls.filter((c) => c.name === "search").length, 3);
	assert.equal(outcome.events.filter((e) => e.kind === "call").length, 4, "one observe plus three searches");
});

test("a script failure returns the trace so the failing step is identifiable", async () => {
	const { runtime } = runtimeFor();
	const outcome = await runScript(
		`
		const state = await cua.observe();
		await state.search({ text: "ok" });
		throw new Error("boom at step three");
		`,
		runtime,
	);
	assert.match(outcome.error.message, /boom at step three/);
	assert.equal(outcome.events.filter((e) => e.kind === "call").length, 2, "prior steps are still visible");
});

test("budget errors surface as an outcome error rather than escaping the runner", async () => {
	const { runtime } = runtimeFor({ budget: { maxActions: 1, maxCalls: 100 } });
	const outcome = await runScript(
		`
		let state = await cua.observe();
		while (true) state = await state.act({ action: "click", ref: "@e1" });
		`,
		runtime,
	);
	assert.ok(outcome.error instanceof BudgetExceededError);
	assert.equal(outcome.actions, 1);
});

test("denied globals are shadowed inside the script", async () => {
	const { runtime } = runtimeFor();
	for (const name of ["require", "process", "fetch", "globalThis"]) {
		const outcome = await runScript(`return typeof ${name};`, runtime);
		assert.equal(outcome.error, undefined, `${name} should evaluate, not throw`);
		assert.equal(outcome.value, "undefined", `${name} must not be reachable by name`);
	}
});

test("a syntactically invalid script fails to compile with a clear message", () => {
	assert.throws(() => compileScript("this is ( not javascript"), ScriptCompileError);
	assert.throws(() => compileScript("   "), (error) => error instanceof ScriptCompileError && /non-empty/.test(error.message));
});

test("renderOutcome shows log, trace, and result", () => {
	const text = renderOutcome({
		value: 2,
		actions: 1,
		events: [
			{ kind: "call", name: "observe_ui" },
			{ kind: "log", name: "found 2 rows" },
			{ kind: "call", name: "act_ui", detail: "press @e9" },
		],
	});
	assert.match(text, /Log:\n {2}found 2 rows/);
	assert.match(text, /Trace \(2 calls, 1 actions\)/);
	assert.match(text, /Result: 2/);
});

test("renderOutcome reports the error instead of a result when the script failed", () => {
	const text = renderOutcome({ value: undefined, actions: 0, events: [], error: new Error("nope") });
	assert.match(text, /Error: nope/);
	assert.doesNotMatch(text, /Result:/);
});

test("cua.state rebinds a stateId from an earlier tool call", async () => {
	const { runtime, calls } = runtimeFor();
	const state = await runtime.cua.state("S7");
	assert.equal(state.id, "S7", "keeps the requested id rather than inventing one");
	const call = calls.find((c) => c.name === "search");
	assert.equal(call.params.stateId, "S7");
	await state.search({ text: "x" });
	assert.equal(calls.filter((c) => c.name === "search").at(-1).params.stateId, "S7");
});

test("cua.state rejects an empty id instead of guessing", async () => {
	const { runtime } = runtimeFor();
	await assert.rejects(() => runtime.cua.state(""), /requires a stateId/);
});

test("an evicted state surfaces the backend error to the script", async () => {
	const { runtime } = runtimeFor({
		operations: { search: () => Promise.reject(new Error("State 'S7' is unavailable or was evicted.")) },
	});
	const outcome = await runScript(`return (await cua.state("S7")).id;`, runtime);
	assert.match(outcome.error.message, /unavailable or was evicted/);
});

test("a batched transaction reaches the backend as one call", async () => {
	const { runtime, calls } = runtimeFor();
	const state = await runtime.cua.observe();
	await state.act([
		{ action: "setText", ref: "@e7", text: "hello" },
		{ action: "keypress", keys: ["Return"] },
	]);
	const actCalls = calls.filter((c) => c.name === "act");
	assert.equal(actCalls.length, 1, "one round trip, not two");
	assert.equal(actCalls[0].params.actions.length, 2);
	assert.equal(runtime.actionCount(), 2, "both steps count against the budget");
});

test("irreversible labels cover the policy categories, not just send", () => {
	const outline = [
		'@e1 button "Send"',
		'@e2 button "Delete forever"',
		'@e3 button "Confirm payment"',
		'@e4 button "Unsubscribe"',
		'@e5 button "Install"',
		'@e6 button "Allow location access"',
		'@e7 button "Save draft"',
		'@e8 button "Back"',
	].join("\n");
	for (const ref of ["@e1", "@e2", "@e3", "@e4", "@e5", "@e6"]) {
		assert.equal(isIrreversible([{ action: "press", ref }], outline), true, `${ref} should be gated`);
	}
	for (const ref of ["@e7", "@e8"]) {
		assert.equal(isIrreversible([{ action: "press", ref }], outline), false, `${ref} should not prompt`);
	}
});

test("desktop observations report the state id under details.capture", () => {
	assert.equal(stateIdOf({ details: { capture: { stateId: "uuid-1" } } }), "uuid-1");
});

test("browser observations report the state id at the top level", () => {
	assert.equal(stateIdOf({ details: { stateId: "S3" } }), "S3");
});

test("a result carrying no state id yields undefined rather than a stale guess", () => {
	assert.equal(stateIdOf({ details: { tool: "observe_ui" } }), undefined);
	assert.equal(stateIdOf(undefined), undefined);
});

test("a desktop-shaped observation drives the loop end to end", async () => {
	// Shapes copied from a real backend response: desktop results nest the id
	// under `capture`, which an earlier version of this module missed.
	const seen = [];
	let n = 0;
	const { runtime } = runtimeFor({
		operations: {
			observe: (params) => {
				seen.push({ name: "observe", params });
				return Promise.resolve({
					content: [{ type: "text", text: '@e1 AXWindow "Notes"\n@e9 AXButton "Save draft"' }],
					details: { tool: "observe_ui", capture: { stateId: "uuid-a" } },
				});
			},
			act: (params) => {
				seen.push({ name: "act", params });
				n += 1;
				return Promise.resolve({
					content: [{ type: "text", text: "Successor diff" }],
					details: { tool: "act_ui", capture: { stateId: `uuid-${n}` } },
				});
			},
		},
	});
	const state = await runtime.cua.observe({ root: "@r1" });
	assert.equal(state.id, "uuid-a");
	const next = await state.act({ action: "setText", ref: "@e1", text: "hi" });
	assert.equal(next.id, "uuid-1", "the successor id comes from the act result");
	assert.equal(seen.find((c) => c.name === "act").params.stateId, "uuid-a");
});

test("repeated eval on one binding follows the advancing epoch", async () => {
	// The backend advances a page's epoch on every evaluation, so a second call
	// using the original id fails with a stale-state error. The binding must
	// track the successor internally.
	const seen = [];
	let n = 0;
	const { runtime } = runtimeFor({
		operations: {
			launchBrowser: () => Promise.resolve({
				content: [{ type: "text", text: "@e1 page" }],
				details: { tool: "launch_browser", stateId: "P0" },
			}),
			evaluateBrowser: (params) => {
				seen.push(params.stateId);
				if (params.stateId !== `P${n}`) {
					return Promise.reject(new Error(`State is stale: expected epoch ${n}`));
				}
				n += 1;
				return Promise.resolve({
					content: [{ type: "text", text: `Evaluation value: ${n}` }],
					details: { tool: "evaluate_browser", stateId: `P${n}` },
				});
			},
		},
	});
	const page = await runtime.cua.launchBrowser("https://example.com");
	assert.equal(await page.eval("1"), 1);
	assert.equal(await page.eval("2"), 2, "a second eval must not reuse the original id");
	assert.equal(await page.eval("3"), 3);
	assert.deepEqual(seen, ["P0", "P1", "P2"]);
});

test("navigate also advances the binding so a following eval works", async () => {
	const seen = [];
	const { runtime } = runtimeFor({
		operations: {
			launchBrowser: () => Promise.resolve({ content: [], details: { stateId: "P0" } }),
			navigateBrowser: () => Promise.resolve({ content: [{ type: "text", text: "@e1 page" }], details: { stateId: "P1" } }),
			evaluateBrowser: (params) => {
				seen.push(params.stateId);
				return Promise.resolve({ content: [{ type: "text", text: "Evaluation value: true" }], details: { stateId: "P2" } });
			},
		},
	});
	const page = await runtime.cua.launchBrowser();
	const next = await page.navigate("https://example.org");
	assert.equal(next.id, "P1");
	await next.eval("document.title");
	assert.deepEqual(seen, ["P1"], "eval runs against the post-navigation state");
});

test("an occluded act failure is rewritten before the script sees it", async () => {
	// Payload shape taken from a real failure: a macOS permission dialog on top.
	const raw =
		'Target is occluded by ["role": "AXStaticText", ' +
		'"value": "“Otty” wants access to control “Google Chrome”.", "canPress": false]';
	const { runtime } = runtimeFor({ operations: { act: () => Promise.reject(new Error(raw)) } });
	const state = await runtime.cua.observe();
	await assert.rejects(
		() => state.act({ action: "click", ref: "@e1" }),
		(error) => {
			assert.match(error.message, /covered on screen by/);
			assert.match(error.message, /wants access to control/);
			assert.doesNotMatch(error.message, /canPress/, "the raw property dump is hidden");
			return true;
		},
	);
});

test("a non-occlusion act failure keeps its original message", async () => {
	const { runtime } = runtimeFor({
		operations: { act: () => Promise.reject(new Error("Outline ref '@e9' is stale or not available.")) },
	});
	const state = await runtime.cua.observe();
	await assert.rejects(() => state.act({ action: "click", ref: "@e1" }), /is stale or not available/);
});

test("a script may launch only one browser", async () => {
	// Each launch spawns a real Chrome with a throwaway profile, and the backend
	// only kills the most recent one, so repeats leave orphaned windows behind.
	const { runtime, calls } = runtimeFor();
	await runtime.cua.launchBrowser("https://example.com");
	await assert.rejects(
		() => runtime.cua.launchBrowser("https://other.example"),
		(error) => {
			assert.match(error.message, /already launched a browser/);
			assert.match(error.message, /state\.navigate\(url\)/, "the message names the alternative");
			return true;
		},
	);
	assert.equal(calls.filter((call) => call.name === "launchBrowser").length, 1, "the second launch never reaches the backend");
});

test("a script is stopped once it outruns its wall-clock budget", async () => {
	let now = 0;
	const { runtime } = runtimeFor({
		budget: { ...DEFAULT_BUDGET, maxDurationMs: 5_000 },
		now: () => now,
	});
	await runtime.cua.observe();
	now = 4_000;
	await runtime.cua.observe();
	now = 5_001;
	await assert.rejects(() => runtime.cua.observe(), (error) => {
		assert.ok(error instanceof ScriptHaltedError);
		assert.match(error.message, /ran longer than 5s/);
		assert.match(error.message, /hold the pointer and keyboard/);
		return true;
	});
});

test("cancelling stops the script at the next backend call", async () => {
	const controller = new AbortController();
	const { runtime, calls } = runtimeFor({ signal: controller.signal });
	await runtime.cua.observe();
	controller.abort();
	await assert.rejects(() => runtime.cua.observe(), (error) => {
		assert.ok(error instanceof ScriptHaltedError);
		assert.match(error.message, /cancelled/);
		return true;
	});
	assert.equal(calls.filter((call) => call.name === "observe").length, 1, "no further work is sent to the backend");
});

test("the default budget bounds duration as well as calls and actions", () => {
	assert.ok(DEFAULT_BUDGET.maxDurationMs > 0, "a script cannot run unbounded by default");
});
