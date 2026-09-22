import assert from "node:assert/strict";
import test from "node:test";
import { fetchContentTool, getSearchContentTool, registerWebTools, webSearchTool } from "../src/web/tools.ts";
import { clearRecords, store } from "../src/web/storage.ts";

const config = () => ({});
const noCredentials = { modelRegistry: { getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false }) } };
const run = (tool, args, ctx = noCredentials) => tool.execute("id", args, new AbortController().signal, undefined, ctx);
const textOf = (result) => result.content.map((item) => item.text).join("");

test("the three web tools are registered with usable schemas", () => {
	const registered = [];
	registerWebTools({ registerTool: (tool) => registered.push(tool) }, config);
	assert.deepEqual(registered.map((t) => t.name), ["web_search", "fetch_content", "get_search_content"]);
	for (const tool of registered) {
		assert.equal(tool.parameters.type, "object");
		assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
		assert.ok(tool.promptSnippet.length > 0, `${tool.name} needs a prompt snippet`);
		assert.equal(typeof tool.execute, "function");
		// A closed schema is what stops a model inventing arguments.
		assert.equal(tool.parameters.additionalProperties, false, `${tool.name} must reject unknown arguments`);
	}
	assert.deepEqual(registered[2].parameters.required, ["responseId"]);
});

test("web_search requires a query", async () => {
	const result = await run(webSearchTool(config), {});
	assert.match(textOf(result), /requires query or queries/);
	assert.ok(result.details.error);
});

test("web_search explains how to sign in when no credential resolves", async () => {
	const result = await run(webSearchTool(config), { query: "anything" });
	assert.match(textOf(result), /\/login openai-codex/);
});

test("fetch_content validates its arguments", async () => {
	const tool = fetchContentTool(config);
	assert.match(textOf(await run(tool, {})), /requires url or urls/);
	assert.match(textOf(await run(tool, { urls: Array(11).fill("https://a.test") })), /at most 10 URLs/);
});

test("fetch_content reports a blocked address rather than fetching it", async () => {
	const result = await run(fetchContentTool(config), { url: "http://169.254.169.254/latest/meta-data/" });
	assert.match(textOf(result), /Blocked internal address/);
	assert.equal(result.details.successful, 0);
});

test("stored fetch content is read back in slices and by search", async () => {
	clearRecords();
	const content = "Sentence about storage and retrieval of fetched content. ".repeat(40);
	const responseId = store({ type: "fetch", urls: [{ url: "https://a.test/doc", title: "Long Doc", content }] });
	const get = getSearchContentTool(config);

	const slice = await run(get, { responseId, offset: 0, limit: 100 });
	assert.equal(slice.details.returnedChars, 100);
	assert.equal(slice.details.offset, 0);
	assert.ok(slice.details.nextOffset > 0);
	assert.match(textOf(slice), /More available from offset/);

	const tail = await run(get, { responseId, offset: slice.details.nextOffset, limit: 100_000 });
	assert.equal(tail.details.nextOffset, undefined, "the final slice has no continuation");

	const found = await run(get, { responseId, findText: "storage and retrieval" });
	assert.ok(found.details.matchCount > 0);
	assert.match(textOf(found), /storage and retrieval/);

	const missed = await run(get, { responseId, findText: "nowhere in this document" });
	assert.equal(missed.details.matchCount, 0);
});

test("stored search answers are addressable by query", async () => {
	clearRecords();
	const responseId = store({
		type: "search",
		queries: [{ query: "first question", answer: "First answer.", sources: [{ url: "https://a.test", title: "A" }] }],
	});
	const get = getSearchContentTool(config);
	const byQuery = await run(get, { responseId, query: "first question" });
	assert.match(textOf(byQuery), /First answer\./);
	assert.match(textOf(byQuery), /\[A\]\(https:\/\/a\.test\)/, "sources stay linked");
	assert.match(textOf(await run(get, { responseId, queryIndex: 0 })), /First answer\./);
});

test("get_search_content reports an unknown or expired id", async () => {
	const result = await run(getSearchContentTool(config), { responseId: "does-not-exist" });
	assert.equal(result.details.error, "Not found");
	assert.equal(result.details.responseId, "does-not-exist");
});

test("get_search_content rejects findMode without findText", async () => {
	clearRecords();
	const responseId = store({ type: "fetch", urls: [{ url: "https://a.test", content: "body" }] });
	const result = await run(getSearchContentTool(config), { responseId, findMode: "fuzzy" });
	assert.match(textOf(result), /findMode requires findText/);
});

test("an out-of-range offset is refused with a usable message", async () => {
	clearRecords();
	const responseId = store({ type: "fetch", urls: [{ url: "https://a.test", content: "short" }] });
	const result = await run(getSearchContentTool(config), { responseId, offset: 9999 });
	assert.match(textOf(result), /exceeds content length/);
});

test("a stored fetch error is reported instead of empty content", async () => {
	clearRecords();
	const responseId = store({ type: "fetch", urls: [{ url: "https://a.test", content: "", error: "HTTP 404" }] });
	const result = await run(getSearchContentTool(config), { responseId });
	assert.match(textOf(result), /HTTP 404/);
});

test("a malformed allowRanges setting fails the call with a clear message", async () => {
	const tool = fetchContentTool(() => ({ ssrf: { allowRanges: ["not-a-cidr"] } }));
	const result = await run(tool, { url: "https://example.com" });
	assert.match(textOf(result), /ssrf\.allowRanges/);
});
