import assert from "node:assert/strict";
import test from "node:test";
import { callTitle, resultLines, scriptSummary } from "../src/computer-render.ts";
import { describeOcclusion } from "../src/computer-script.ts";

test("the call title names the operations the script performs", () => {
	assert.equal(
		callTitle(`const s = await cua.observe({root:"@r1"}); await s.search({text:"x"}); await s.act({action:"press"});`),
		"computer observe → search → act",
	);
	assert.equal(callTitle("return 1;"), "computer");
});

test("the script preview drops comments and blank lines", () => {
	const lines = scriptSummary(`
		// pick the window
		const s = await cua.observe();

		return s.id;
	`);
	assert.deepEqual(lines, ["const s = await cua.observe();", "return s.id;"]);
});

test("a long script is truncated with a visible remainder count", () => {
	const script = Array.from({ length: 10 }, (_, i) => `line${i}();`).join("\n");
	const lines = scriptSummary(script, 4);
	assert.equal(lines.length, 4);
	assert.equal(lines.at(-1), "… 7 more lines");
});

test("a successful result leads with its scale and keeps the log and value", () => {
	const { title, body } = resultLines(
		"Log:\n  looking\nTrace (3 calls, 1 actions):\n  observe_ui @r1\n  act_ui press @e9\nResult: 7",
		{ actions: 1, events: [{ kind: "call" }, { kind: "call" }, { kind: "call" }] },
		false,
	);
	assert.equal(title, "computer ok — 3 calls, 1 action");
	assert.ok(body.some((line) => /Result: 7/.test(line)));
	assert.ok(!body.some((line) => /Trace \(/.test(line)), "the trace stays out of the collapsed view");
	assert.ok(!body.some((line) => /observe_ui/.test(line)));
});

test("a failed result leads with the reason, not the trace", () => {
	const { title, body } = resultLines(
		"Trace (2 calls, 1 actions):\n  observe_ui\n  act_ui press @e9\nError: User declined: press @e9",
		{ actions: 1, events: [{ kind: "call" }, { kind: "call" }], error: "User declined: press @e9" },
		true,
	);
	assert.equal(title, "computer failed — 2 calls, 1 action");
	assert.deepEqual(body, ["User declined: press @e9"]);
});

test("singular and plural counts read correctly", () => {
	const { title } = resultLines("Result: 1", { actions: 1, events: [{ kind: "call" }] }, false);
	assert.equal(title, "computer ok — 1 call, 1 action");
});

test("occlusion errors name the blocking element in plain language", () => {
	// Payload shape taken from a real failure: a macOS permission dialog on top.
	const raw =
		'Target is occluded by ["role": "AXStaticText", "ref": "e20662", ' +
		'"value": "“Otty” wants access to control “Google Chrome”.", "canPress": false]';
	const text = describeOcclusion(raw);
	assert.match(text, /covered on screen by "“Otty” wants access to control “Google Chrome”\."/);
	assert.match(text, /Dismiss or handle what is on top/);
	assert.doesNotMatch(text, /canPress/, "the raw property dump is not shown");
});

test("occlusion falls back to the role when the blocker has no text", () => {
	assert.match(describeOcclusion('Target is occluded by ["role": "AXCell", "value": ""]'), /covered on screen by a AXCell/);
	assert.match(describeOcclusion('Target is occluded by ["canPress": false]'), /by another element/);
});

test("a very long blocker label is truncated", () => {
	const text = describeOcclusion(`Target is occluded by ["value": "${"x".repeat(400)}"]`);
	assert.ok(text.includes("..."), "long blocker text is elided");
	assert.ok(text.split("\n")[0].length < 220);
});

test("unrelated errors are left untouched", () => {
	assert.equal(describeOcclusion("Outline ref '@e9' is stale"), undefined);
	assert.equal(describeOcclusion("keypress requires either ref or both x and y."), undefined);
});
