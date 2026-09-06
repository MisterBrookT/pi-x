import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, groupByOrigin, inventory, originOf, renderTable, summarize, toolChars, totals } from "../src/tool-inventory.ts";

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

test("the table groups tools by origin, built-ins first", () => {
	// A flat list of thirty tools hides which package is responsible for the weight.
	const rows = inventory(
		[
			{ ...tool("read"), sourceInfo: { source: "builtin" } },
			{ ...tool("computer", { description: "x".repeat(3000) }), sourceInfo: { source: "ext", path: "/n/node_modules/pi-computer/e.ts" } },
			{ ...tool("web_search"), sourceInfo: { source: "ext", path: "/n/node_modules/pi-web-access/i.ts" } },
		],
		["read", "computer"],
	);
	const groups = groupByOrigin(rows);
	assert.equal(groups[0].origin, "builtin", "built-ins lead as the stable baseline");
	assert.deepEqual(groups.slice(1).map((g) => g.origin), ["pi-computer", "pi-web-access"], "heavier packages first");
	assert.equal(groups[1].tokens, rows.find((r) => r.name === "computer").tokens);

	const table = renderTable(rows);
	assert.match(table, /^builtin {2}\(1\/1 active · ~\d+ tok\)$/m);
	assert.match(table, /^pi-computer {2}\(1\/1 active · ~\d+ tok\)$/m);
	assert.match(table, /^pi-web-access {2}\(0\/1 active · ~\d+ tok\)$/m);
	assert.match(table, /^ {2}on {2}computer/m);
	assert.match(table, /^ {2}off web_search/m);
});

test("grouping keeps every tool exactly once", () => {
	const rows = inventory([tool("a"), tool("b"), tool("c")], ["a"]);
	const grouped = groupByOrigin(rows).flatMap((g) => g.rows.map((r) => r.name));
	assert.deepEqual(grouped.sort(), ["a", "b", "c"]);
});

test("an empty inventory does not divide by zero or crash", () => {
	assert.deepEqual(inventory([], []), []);
	assert.match(summarize([]), /0 of 0 tools active/);
	assert.equal(typeof renderTable([]), "string");
});
