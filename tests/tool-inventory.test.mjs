import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, inventory, originOf, renderTable, summarize, toolChars, totals } from "../src/tool-inventory.ts";

const tool = (name, extra = {}) => ({
	name,
	description: extra.description ?? "d",
	parameters: extra.parameters ?? { type: "object" },
	sourceInfo: extra.sourceInfo,
});

test("a tool's cost reflects its description and schema, not just its name", () => {
	const small = toolChars(tool("a", { description: "x" }));
	const large = toolChars(tool("a", { description: "x".repeat(500) }));
	assert.ok(large > small + 400, "a long description dominates the cost");
	const wide = toolChars(tool("a", { parameters: { type: "object", properties: { q: { type: "string", description: "y".repeat(300) } } } }));
	assert.ok(wide > small + 250, "schema size counts too");
});

test("token estimates are proportional and stable", () => {
	assert.equal(estimateTokens(370), 100);
	assert.equal(estimateTokens(0), 0);
});

test("rows are ordered by cost so the expensive tools are visible first", () => {
	const rows = inventory(
		[tool("cheap", { description: "x" }), tool("pricey", { description: "x".repeat(2000) }), tool("mid", { description: "x".repeat(200) })],
		["cheap"],
	);
	assert.deepEqual(rows.map((row) => row.name), ["pricey", "mid", "cheap"]);
	assert.deepEqual(rows.map((row) => row.active), [false, false, true]);
});

test("origin prefers a package name over a long path", () => {
	assert.equal(originOf(tool("a", { sourceInfo: { source: "builtin" } })), "builtin");
	assert.equal(originOf(tool("a", { sourceInfo: { source: "ext", path: "/x/node_modules/@injaneity/pi-computer-use/e.ts" } })), "@injaneity/pi-computer-use");
	assert.equal(originOf(tool("a", { sourceInfo: { source: "ext", path: "/x/node_modules/pi-web-access/i.ts" } })), "pi-web-access");
	assert.equal(originOf(tool("a", { sourceInfo: { source: "ext", path: "/w/pix/extensions/computer.ts" } })), "computer");
	assert.equal(originOf(tool("a", {})), "extension");
});

test("totals count only what is actually sent", () => {
	const rows = inventory([tool("on1"), tool("on2"), tool("off1")], ["on1", "on2"]);
	const sums = totals(rows);
	assert.equal(sums.activeCount, 2);
	assert.equal(sums.totalCount, 3);
	assert.equal(sums.activeTokens, rows.filter((r) => r.active).reduce((s, r) => s + r.tokens, 0));
	assert.ok(sums.activeTokens < sums.totalTokens, "a disabled tool costs nothing per request");
});

test("the summary states the active count and the per-request cost", () => {
	const text = summarize(inventory([tool("a"), tool("b")], ["a"]));
	assert.match(text, /1 of 2 tools active/);
	assert.match(text, /tokens per request/);
});

test("the plain table aligns and marks state, for use without a TUI", () => {
	const table = renderTable(inventory([tool("short"), tool("a_much_longer_name")], ["short"]));
	const lines = table.split("\n").slice(2);
	assert.match(lines[0], /^(on |off) /);
	assert.equal(new Set(lines.map((line) => line.indexOf(" tok"))).size, 1, "columns line up");
	assert.ok(lines.some((line) => line.startsWith("on  short")));
});

test("an empty inventory does not divide by zero or crash", () => {
	assert.deepEqual(inventory([], []), []);
	assert.match(summarize([]), /0 of 0 tools active/);
	assert.equal(typeof renderTable([]), "string");
});
