import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceSpinnerFrames,
	animateSubagentWidget,
	hasSpinnerFrame,
	SUBAGENT_SPINNER_FRAMES,
	SUBAGENT_SPINNER_INTERVAL_MS,
	spinnerFrameStep,
	withAnimatedSubagentWidgets,
} from "../src/subagent-spinner.ts";

const fakeTimers = () => {
	const state = { now: 0, callbacks: new Map(), nextId: 1, cleared: [] };
	return {
		state,
		timers: {
			setInterval: (fn, ms) => {
				const id = { id: state.nextId++, ms, unref: () => {} };
				state.callbacks.set(id, fn);
				return id;
			},
			clearInterval: (id) => {
				state.callbacks.delete(id);
				state.cleared.push(id);
			},
			now: () => state.now,
		},
	};
};

test("pix animates subagent spinners at pi's native indicator cadence", () => {
	assert.equal(SUBAGENT_SPINNER_INTERVAL_MS, 80);
});

test("rendered spinner frame changes at the animation cadence", () => {
	const { state, timers } = fakeTimers();
	let renders = 0;
	const tui = { requestRender: () => {} };
	const factory = animateSubagentWidget(() => ({
		render: () => {
			renders++;
			return [`⠋ subagents (1/1 running)`];
		},
		invalidate() {},
	}), { timers });
	const component = factory(tui, {});

	const first = component.render(40);
	state.now += SUBAGENT_SPINNER_INTERVAL_MS;
	const second = component.render(40);
	state.now += SUBAGENT_SPINNER_INTERVAL_MS;
	const third = component.render(40);

	assert.notEqual(first[0], second[0]);
	assert.notEqual(second[0], third[0]);
	assert.equal(renders, 3, "animation must not skip the underlying render");
	for (const line of [first[0], second[0], third[0]]) assert.ok(hasSpinnerFrame([line]));
});

test("spinner repaint timer runs only while a spinner is visible and stops on dispose", () => {
	const { state, timers } = fakeTimers();
	let running = true;
	let repaints = 0;
	const tui = { requestRender: () => repaints++ };
	const component = animateSubagentWidget(() => ({
		render: () => [running ? "⠙ working" : "● done"],
		invalidate() {},
	}), { timers })(tui, {});

	component.render(40);
	assert.equal(state.callbacks.size, 1, "running spinner schedules repaints");
	for (const fn of state.callbacks.values()) fn();
	assert.equal(repaints, 1);

	running = false;
	component.render(40);
	assert.equal(state.callbacks.size, 0, "idle widget stops repainting");

	running = true;
	component.render(40);
	assert.equal(state.callbacks.size, 1);
	component.dispose();
	assert.equal(state.callbacks.size, 0, "dispose clears the repaint timer");
});

test("frame rotation only touches spinner glyphs", () => {
	const rotated = advanceSpinnerFrames("⠋ subagents (1/1 running)", 3);
	assert.equal(rotated, `${SUBAGENT_SPINNER_FRAMES[3]} subagents (1/1 running)`);
	assert.equal(advanceSpinnerFrames("● done", 5), "● done");
	assert.equal(spinnerFrameStep(240, 80), 3);
});

test("only pi-subagents widgets are wrapped, and context identity is stable", () => {
	const widgets = new Map();
	const ui = {
		theme: {},
		setWidget: (key, content) => widgets.set(key, content),
	};
	const ctx = { hasUI: true, mode: "tui", ui, cwd: "/tmp" };
	const animated = withAnimatedSubagentWidgets(ctx);

	assert.equal(withAnimatedSubagentWidgets(ctx), animated, "context wrapper is cached for upstream identity checks");
	assert.equal(animated.ui, animated.ui, "ui wrapper is cached for upstream identity checks");
	assert.equal(animated.cwd, "/tmp");

	const factory = () => ({ render: () => ["⠋ x"], invalidate() {} });
	animated.ui.setWidget("subagent-fleet-status", factory);
	animated.ui.setWidget("pix-todo", factory);
	animated.ui.setWidget("subagent-async", undefined);

	assert.notEqual(widgets.get("subagent-fleet-status"), factory);
	assert.equal(widgets.get("pix-todo"), factory, "non-subagent widgets pass through untouched");
	assert.equal(widgets.get("subagent-async"), undefined);
});

test("contexts without UI are returned unchanged", () => {
	const ctx = { hasUI: false };
	assert.equal(withAnimatedSubagentWidgets(ctx), ctx);
});

test("upstream frame changes cannot make the fast spinner skip a frame", () => {
	const { state, timers } = fakeTimers();
	const component = animateSubagentWidget(() => ({
		render: () => [`${state.now < 1000 ? "⠋" : "⠙"} subagents`],
		invalidate() {},
	}), { timers })({ requestRender() {} }, {});
	state.now = 960;
	assert.equal(component.render(80)[0], "⠹ subagents");
	state.now = 1040;
	assert.equal(component.render(80)[0], "⠸ subagents");
	component.dispose();
});

test("wrapped widgets retain class-based input and disposal methods", () => {
	let inputs = 0;
	let disposed = 0;
	class Widget {
		handleInput() { inputs++; }
		render() { return ["done"]; }
		invalidate() {}
		dispose() { disposed++; }
	}
	const component = animateSubagentWidget(() => new Widget())({}, {});
	component.handleInput("down");
	component.dispose();
	assert.equal(inputs, 1);
	assert.equal(disposed, 1);
	const rpc = { mode: "rpc", hasUI: true };
	assert.equal(withAnimatedSubagentWidgets(rpc), rpc);
});

test("the real upstream async widget animates at deterministic 80ms ticks", async () => {
	const { createJiti } = await import("jiti");
	const { renderWidget } = await createJiti(import.meta.url).import("../node_modules/pi-subagents/src/tui/render.ts");
	const widgets = new Map();
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const ui = { theme, setWidget: (key, content) => widgets.set(key, content), getToolsExpanded: () => false };
	const ctx = { hasUI: true, mode: "tui", ui };

	renderWidget(ctx, [{
		asyncId: "a1",
		status: "running",
		startedAt: Date.now() - 3000,
		updatedAt: Date.now(),
		description: "demo",
		agents: ["worker"],
		totalTokens: { total: 100 },
	}]);

	const factory = widgets.get("subagent-async");
	assert.equal(typeof factory, "function");
	let repaints = 0;
	const { state, timers } = fakeTimers();
	const component = animateSubagentWidget(factory, { timers })({ requestRender: () => repaints++ }, theme);
	const frames = new Set();
	for (let step = 0; step < 3; step++) {
		const lines = component.render(80);
		assert.ok(hasSpinnerFrame(lines), "upstream renders a spinner glyph while running");
		for (const line of lines) for (const character of line) if (SUBAGENT_SPINNER_FRAMES.includes(character)) frames.add(character);
		state.now += SUBAGENT_SPINNER_INTERVAL_MS;
		for (const callback of state.callbacks.values()) callback();
	}
	assert.ok(frames.size > 1, `spinner frame must change over time, saw ${[...frames].join("")}`);
	assert.ok(repaints > 0, "wrapper requests repaints at the spinner cadence");
	component.dispose();
});
