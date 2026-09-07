/**
 * The benchmark summary is a delivery check reachable through `npm run bench`,
 * so its arithmetic and health verdict are tested directly rather than through
 * a slash command.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderBenchmarkHtml, summarize, summaryLines } from "../src/benchmark.ts";

const input = {
	requiredTools: ["todo", "web_search"],
	activeTools: ["todo", "web_search", "read"],
	naiveStartupMs: [100, 110, 120],
	pixStartupMs: [140, 150, 160],
	naivePrompt: "shared\nonly naive",
	pixPrompt: "shared\nonly pix",
};

test("startup timings are averaged and the delta is signed", () => {
	const result = summarize(input);
	assert.equal(result.naiveStartupMs, 110);
	assert.equal(result.pixStartupMs, 150);
	assert.equal(result.startupDeltaMs, 40);
	assert.match(summaryLines(result), /Startup: Pi 110ms → Pix 150ms \(\+40ms\)/);
});

test("a faster Pix startup reports a negative delta once, not a double sign", () => {
	const result = summarize({ ...input, pixStartupMs: [90] });
	assert.equal(result.startupDeltaMs, -20);
	assert.match(summaryLines(result), /\(-20ms\)/);
});

test("an expected tool that is not active is reported as missing", () => {
	const result = summarize({ ...input, activeTools: ["todo"] });
	assert.deepEqual(result.missingTools, ["web_search"]);
	assert.match(summaryLines(result), /Missing tools: web_search/);
	assert.match(renderBenchmarkHtml(result), /MISSING · web_search/);
});

test("a full tool set reports healthy", () => {
	const result = summarize(input);
	assert.deepEqual(result.missingTools, []);
	assert.match(summaryLines(result), /All Pix tools loaded/);
	assert.match(renderBenchmarkHtml(result), /PIX HEALTHY/);
});

test("the report marks only the lines that differ between the prompts", () => {
	const html = renderBenchmarkHtml(summarize(input));
	assert.match(html, /<mark class="removed">only naive<\/mark>/);
	assert.match(html, /<mark class="added">only pix<\/mark>/);
	assert.doesNotMatch(html, /<mark class="[a-z]+">shared<\/mark>/);
});

test("prompt content is escaped so it cannot inject markup into the report", () => {
	const html = renderBenchmarkHtml(summarize({ ...input, pixPrompt: "<script>alert(1)</script>" }));
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("missing timings do not produce NaN", () => {
	const result = summarize({ ...input, naiveStartupMs: [], pixStartupMs: [] });
	assert.equal(result.naiveStartupMs, 0);
	assert.equal(result.startupDeltaMs, 0);
});
