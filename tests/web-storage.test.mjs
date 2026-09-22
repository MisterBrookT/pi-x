import assert from "node:assert/strict";
import test from "node:test";
import { clearRecords, findContent, getRecord, sliceContent, store } from "../src/web/storage.ts";

test("a stored record is retrieved by its id", () => {
	clearRecords();
	const id = store({ type: "fetch", urls: [{ url: "https://a.test", content: "body" }] });
	assert.equal(getRecord(id)?.urls?.[0]?.content, "body");
	assert.equal(getRecord("missing"), undefined);
});

test("ids are unique across rapid stores", () => {
	clearRecords();
	const ids = new Set(Array.from({ length: 200 }, () => store({ type: "fetch", urls: [] })));
	assert.equal(ids.size, 200);
});

test("storage is bounded so a long session cannot grow without limit", () => {
	clearRecords();
	const first = store({ type: "fetch", urls: [{ url: "https://old.test", content: "oldest" }] });
	for (let i = 0; i < 200; i++) store({ type: "fetch", urls: [] });
	assert.equal(getRecord(first), undefined, "the oldest record is evicted first");
});

test("slices are bounded and report where to continue", () => {
	const content = "abcdefghij";
	const first = sliceContent(content, 0, 4);
	assert.equal(first.text, "abcd");
	assert.equal(first.nextOffset, 4);
	assert.equal(first.contentLength, 10);

	const last = sliceContent(content, 8, 4);
	assert.equal(last.text, "ij");
	assert.equal(last.nextOffset, undefined, "the end of content has no continuation");
});

test("an out-of-range slice is rejected rather than silently empty", () => {
	assert.throws(() => sliceContent("abc", -1, 10), /non-negative/);
	assert.throws(() => sliceContent("abc", 0, 0), /positive/);
	assert.throws(() => sliceContent("abc", 99, 10), /exceeds content length/);
	assert.equal(sliceContent("abc", 3, 10).text, "", "the boundary offset is valid and empty");
});

test("findText locates a passage with surrounding context", () => {
	const content = `${"filler ".repeat(100)}the needle appears here${" tail".repeat(100)}`;
	const [match] = findContent(content, ["needle"]);
	assert.ok(match, "expected a match");
	assert.match(match.text, /the needle appears here/);
	assert.ok(match.text.length < content.length, "context is bounded, not the whole document");
});

test("find modes differ as documented", () => {
	const content = "The Needle Is Here";
	assert.equal(findContent(content, ["needle"], "exact").length, 0);
	assert.equal(findContent(content, ["Needle"], "exact").length, 1);
	assert.equal(findContent(content, ["needle"], "case-insensitive").length, 1);
	// Fuzzy ignores how the source happened to wrap.
	assert.equal(findContent("wrapped\n   across   lines", ["wrapped across lines"], "fuzzy").length, 1);
	assert.equal(findContent("wrapped\n   across   lines", ["wrapped across lines"], "case-insensitive").length, 0);
});

test("several terms are searched and matches stay bounded", () => {
	const content = "alpha beta ".repeat(200);
	assert.ok(findContent(content, ["alpha", "beta"]).length <= 20, "a flood of matches is capped");
	assert.equal(findContent("nothing here", ["absent"]).length, 0);
});
