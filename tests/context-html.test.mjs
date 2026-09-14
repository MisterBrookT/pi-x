import assert from "node:assert/strict";
import test from "node:test";
import { entryText, escapeHtml, renderContextHtml } from "../src/context-html.ts";

const baseReport = {
	slices: [{ label: "system prompt", tokens: 100, percent: 100, count: 1 }],
	usedTokens: 100,
	windowTokens: 200_000,
	percentUsed: 0.05,
	messageCount: 1,
};

const render = (overrides = {}) =>
	renderContextHtml({
		report: baseReport,
		systemPrompt: "hello",
		tools: [],
		entries: [],
		generatedAt: new Date("2024-01-01T00:00:00Z"),
		...overrides,
	});

test("escaping covers every character that could break out of markup", () => {
	assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("session content cannot inject script into the page", () => {
	const html = render({ entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "<script>alert(1)</script>" }] } }] });
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;alert\(1\)/);
});

test("text parts are read as text and other parts are kept as JSON", () => {
	assert.equal(entryText({ type: "message", message: { content: [{ type: "text", text: "a" }, { type: "image", data: "b" }] } }).split("\n")[0], "a");
	assert.match(entryText({ type: "message", message: { content: [{ type: "image", data: "b" }] } }), /"type": "image"/);
	assert.equal(entryText({ type: "compaction", compactionSummary: "summary" }), "summary");
});

test("the page is deterministic and self-contained", () => {
	assert.equal(render(), render());
	const html = render();
	assert.doesNotMatch(html, /src=|href=|https?:\/\//);
});

test("an inactive tool is marked as not sent rather than counted as context", () => {
	const html = render({
		tools: [
			{ name: "read", description: "Read", parameters: {}, origin: "builtin", active: true },
			{ name: "computer", description: "Drive a GUI", parameters: {}, origin: "pi-x", active: false },
		],
	});
	assert.match(html, /1 tools<\/span>/, "only active schemas are part of the system turn");
	assert.match(html, /class="part off"[\s\S]*computer/);
	assert.match(html, /pi-x · \d+ tok · inactive/);
});

test("the page is one timeline: system turn first, then entries in wire order", () => {
	const html = render({
		entries: [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
		],
	});
	const labels = [...html.matchAll(/class="label">([^<]+)</g)].map((match) => match[1]);
	assert.deepEqual(labels, ["system", "user", "assistant"]);
	assert.ok(html.indexOf("first question") < html.indexOf("second answer"));
});

test("a missing system prompt is stated rather than rendered as empty", () => {
	assert.match(render({ systemPrompt: undefined }), /\(unavailable\)/);
});

test("a model without a window still produces a headline", () => {
	const html = render({ report: { ...baseReport, windowTokens: undefined, percentUsed: undefined } });
	assert.match(html, /<h1>100 tokens<\/h1>/);
});

test("everything is visible at once, with nothing collapsed", () => {
	// The page exists to read the exact context; a schema or message behind a
	// disclosure click would defeat its purpose.
	const html = render({
		tools: [{ name: "read", description: "Read", parameters: { type: "object" }, origin: "builtin", active: true }],
		entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "visible body" }] } }],
	});
	assert.doesNotMatch(html, /<details|<summary/);
	assert.match(html, /visible body/);
	assert.match(html, /&quot;type&quot;: &quot;object&quot;/);
});
