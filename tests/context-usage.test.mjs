import assert from "node:assert/strict";
import test from "node:test";
import { bar, buildReport, estimateTokens, renderReport, sizeOf } from "../src/context-usage.ts";

const msg = (role, content, toolName) => ({ type: "message", message: { role, content, toolName } });
const text = (n) => [{ type: "text", text: "x".repeat(n) }];

test("tool results are attributed to the tool that produced them", () => {
	// A flat 'messages' total cannot answer which tool filled the window.
	const { slices } = buildReport({
		entries: [
			msg("toolResult", text(40_000), "read"),
			msg("toolResult", text(1_000), "bash"),
			msg("assistant", text(500)),
		],
	});
	assert.deepEqual(slices.map((slice) => slice.label), ["read (tool results)", "bash (tool results)", "assistant messages"]);
	assert.ok(slices[0].percent > 90, "the dominant tool is unmistakable");
});

test("percentages are shares of the counted context and sum to 100", () => {
	const { slices } = buildReport({ entries: [msg("user", text(1000)), msg("assistant", text(3000))] });
	const total = slices.reduce((sum, slice) => sum + slice.percent, 0);
	assert.ok(Math.abs(total - 100) < 0.01);
	assert.ok(Math.abs(slices[0].percent - 75) < 1);
});

test("the fixed prefix is counted, since it is resent every request", () => {
	const { slices } = buildReport({
		entries: [msg("user", text(100))],
		systemPrompt: "s".repeat(3700),
		toolSchemaChars: 7400,
		toolCount: 5,
	});
	const byLabel = Object.fromEntries(slices.map((slice) => [slice.label, slice]));
	assert.equal(byLabel["system prompt"].tokens, 1000);
	assert.equal(byLabel["tool schemas"].tokens, 2000);
	assert.equal(byLabel["tool schemas"].count, 5, "the tool count is carried for display");
});

test("window usage is reported when the model's window is known", () => {
	// Content is JSON-wrapped, so sizes are close to but not exactly the text length.
	const report = buildReport({ entries: [msg("user", text(37_000))], windowTokens: 200_000 });
	assert.ok(Math.abs(report.usedTokens - 10_000) < 50);
	assert.ok(Math.abs(report.percentUsed - 5) < 0.1);
	assert.equal(buildReport({ entries: [] }).percentUsed, undefined, "no window means no false precision");
});

test("compaction and branch summaries are counted, not skipped", () => {
	// After compaction the summary is what is actually sent; ignoring it would
	// under-report a long session.
	const { slices } = buildReport({
		entries: [
			{ type: "compaction", compactionSummary: "c".repeat(3700) },
			{ type: "branch_summary", branchSummary: "b".repeat(370) },
			{ type: "custom", customType: "pix-todo", data: { huge: "x".repeat(100_000) } },
		],
	});
	const labels = slices.map((slice) => slice.label);
	assert.ok(labels.includes("compaction summary"));
	assert.ok(labels.includes("branch summary"));
	assert.ok(!labels.some((label) => /custom/.test(label)), "custom entries never reach the model");
});

test("messages are counted but non-message entries are not", () => {
	const report = buildReport({
		entries: [msg("user", text(10)), msg("assistant", text(10)), { type: "compaction", compactionSummary: "x" }],
	});
	assert.equal(report.messageCount, 2);
});

test("sizing survives unserializable content instead of aborting the report", () => {
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(sizeOf(cyclic), 0);
	assert.equal(sizeOf(undefined), 0);
	assert.equal(sizeOf("abcd"), 4);
	assert.doesNotThrow(() => buildReport({ entries: [msg("user", cyclic)] }));
});

test("an empty session reports zero without dividing by zero", () => {
	const report = buildReport({ entries: [] });
	assert.equal(report.usedTokens, 0);
	assert.deepEqual(report.slices, []);
	assert.match(renderReport(report), /0 tokens in context/);
});

test("the bar is proportional and clamped", () => {
	assert.equal(bar(0, 10), "·".repeat(10));
	assert.equal(bar(100, 10), "█".repeat(10));
	assert.equal(bar(50, 10), `${"█".repeat(5)}${"·".repeat(5)}`);
	assert.equal(bar(999, 10).length, 10, "an out-of-range value cannot overflow the row");
});

test("the rendered report leads with window usage and orders by size", () => {
	const output = renderReport(
		buildReport({
			entries: [msg("toolResult", text(74_000), "read"), msg("user", text(3700))],
			windowTokens: 200_000,
		}),
	);
	const lines = output.split("\n");
	assert.match(lines[0], /of 200k tokens · \d+\.\d% of the window/);
	assert.match(lines[1], /2 messages/);
	assert.ok(lines[3].startsWith("read (tool results)"), "the largest contributor is first");
});

test("rows too small to matter are summarized instead of listed", () => {
	const entries = [msg("toolResult", text(400_000), "read")];
	for (let i = 0; i < 4; i += 1) entries.push(msg("toolResult", text(20), `tiny${i}`));
	const output = renderReport(buildReport({ entries }));
	assert.match(output, /4 smaller entries below 0\.1%/);
	assert.ok(!output.includes("tiny0"));
});

test("token estimates are proportional", () => {
	assert.equal(estimateTokens(3700), 1000);
});

test("a nearly full window is called out with the largest contributor", () => {
	const output = renderReport(
		buildReport({ entries: [msg("toolResult", text(650_000), "read")], windowTokens: 200_000 }),
	);
	assert.match(output, /Nearly full\. read \(tool results\) is \d+% of what is in context\./);
});

test("an over-full window says what to do about it", () => {
	const output = renderReport(
		buildReport({ entries: [msg("toolResult", text(2_000_000), "read")], windowTokens: 200_000 }),
	);
	assert.match(output, /Over the window\. Compact the session; read \(tool results\) is the largest contributor\./);
});

test("a comfortable window gets no advice line", () => {
	const output = renderReport(buildReport({ entries: [msg("user", text(1000))], windowTokens: 200_000 }));
	assert.doesNotMatch(output, /Nearly full|Over the window/);
});

test("no advice is invented when the window is unknown", () => {
	const output = renderReport(buildReport({ entries: [msg("toolResult", text(9_000_000), "read")] }));
	assert.doesNotMatch(output, /Nearly full|Over the window/);
});
