import assert from "node:assert/strict";
import test from "node:test";
import { extractAnswer, extractResults, parseResponseText, resolveAuth, search } from "../src/web/search.ts";

const citation = (url, title, start, end) => ({ type: "url_citation", url, title, start_index: start, end_index: end });

const messageItem = (text, annotations) => ({ type: "message", content: [{ text, annotations }] });

function registry(models, resolved = { ok: true, apiKey: "sk-test", headers: {} }) {
	return { modelRegistry: { getAll: () => models, getApiKeyAndHeaders: async () => resolved } };
}

test("a plain JSON response is parsed", () => {
	const body = JSON.stringify({ output: [{ type: "web_search_call" }, messageItem("Answer.", [])] });
	const { output, sawWebSearch } = parseResponseText(body);
	assert.equal(output.length, 2);
	assert.equal(sawWebSearch, true);
});

test("an SSE stream is reassembled from its events", () => {
	const body = [
		'data: {"type":"response.web_search_call.in_progress"}',
		`data: ${JSON.stringify({ type: "response.output_item.done", item: messageItem("Streamed answer.", [citation("https://a.test", "A", 0, 8)]) })}`,
		"data: [DONE]",
		"",
	].join("\n");
	const { output, sawWebSearch } = parseResponseText(body);
	assert.equal(sawWebSearch, true);
	assert.equal(extractAnswer(output), "Streamed answer.");
	assert.equal(extractResults(output)[0].url, "https://a.test/");
});

test("a completed event wins over incremental items", () => {
	const body = [
		`data: ${JSON.stringify({ type: "response.output_item.done", item: messageItem("partial", []) })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { output: [messageItem("final", [])] } })}`,
		"",
	].join("\n");
	assert.equal(extractAnswer(parseResponseText(body).output), "final");
});

test("malformed payloads fail loudly", () => {
	assert.throws(() => parseResponseText("{not json"), /invalid JSON/);
	assert.throws(() => parseResponseText("no events here"), /no parseable response output/);
});

test("a malformed SSE line is skipped without losing the rest", () => {
	const body = [
		"data: {broken",
		`data: ${JSON.stringify({ type: "response.output_item.done", item: messageItem("survived", []) })}`,
		"",
	].join("\n");
	assert.equal(extractAnswer(parseResponseText(body).output), "survived");
});

test("citations become results with surrounding snippets", () => {
	const text = `${"x".repeat(150)}The claim is supported here.${"y".repeat(150)}`;
	const results = extractResults([messageItem(text, [citation("https://source.test/a", "Source A", 150, 178)])]);
	assert.equal(results.length, 1);
	assert.equal(results[0].title, "Source A");
	assert.match(results[0].snippet, /The claim is supported here/);
	assert.ok(results[0].snippet.length <= 300);
});

test("web_search_call sources are picked up when citations are absent", () => {
	const results = extractResults([
		{ type: "web_search_call", action: { sources: [{ url: "https://a.test", title: "A" }] }, results: [{ source_website_url: "https://b.test", caption: "B" }] },
	]);
	assert.deepEqual(results.map((r) => r.title), ["A", "B"]);
});

test("duplicate sources collapse and the OpenAI tracking parameter is dropped", () => {
	const results = extractResults([
		messageItem("t", [citation("https://a.test/p?utm_source=openai", "A", 0, 1), citation("https://a.test/p", "A again", 0, 1)]),
	]);
	assert.equal(results.length, 1);
	assert.equal(results[0].url, "https://a.test/p");
});

test("a result without a title falls back to its URL", () => {
	assert.equal(extractResults([messageItem("t", [citation("https://a.test/", "", 0, 1)])])[0].title, "https://a.test/");
});

test("numResults truncates and is capped at twenty", () => {
	const many = Array.from({ length: 30 }, (_, i) => citation(`https://s${i}.test`, `S${i}`, 0, 1));
	assert.equal(extractResults([messageItem("t", many)], 3).length, 3);
	assert.equal(extractResults([messageItem("t", many)], 100).length, 20);
});

test("Codex credentials are preferred and produce a Codex request", async () => {
	const auth = await resolveAuth(registry([
		{ id: "gpt-5", provider: "openai" },
		{ id: "gpt-5.6-terra", provider: "openai-codex" },
		{ id: "gpt-6-sol", provider: "openai-codex" },
	]));
	assert.equal(auth.codex, true);
	assert.equal(auth.model, "gpt-6-sol", "the sol tier is preferred for search");
	assert.match(auth.responsesUrl, /chatgpt\.com\/backend-api\/codex/);
});

test("pro and ultra tiers are not spent on search", async () => {
	const auth = await resolveAuth(registry([
		{ id: "gpt-6-astra", provider: "openai" },
		{ id: "gpt-5-pro", provider: "openai" },
		{ id: "gpt-5", provider: "openai" },
	]));
	assert.equal(auth.model, "gpt-5");
});

test("an API key is used when no Pi login resolves", async () => {
	const none = { modelRegistry: { getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false }) } };
	assert.equal(await resolveAuth(none, {}), undefined);
	const auth = await resolveAuth(none, { openaiApiKey: "sk-config" });
	assert.equal(auth.apiKey, "sk-config");
	assert.equal(auth.codex, false);
	assert.match(auth.responsesUrl, /api\.openai\.com/);
});

test("a search issues a web_search tool call and returns sources", async () => {
	let sent;
	const fetchImpl = async (_url, init) => {
		sent = JSON.parse(init.body);
		return new Response(JSON.stringify({ output: [{ type: "web_search_call" }, messageItem("The answer.", [citation("https://a.test", "A", 0, 4)])] }));
	};
	const auth = { apiKey: "sk-x", model: "gpt-5", headers: {}, responsesUrl: "https://api.openai.com/v1/responses", codex: false };
	const response = await search("a question", auth, { numResults: 5, fetch: fetchImpl });
	assert.equal(sent.tools[0].type, "web_search");
	assert.equal(sent.tool_choice, "required");
	assert.equal(sent.store, false, "search queries must not be retained upstream");
	assert.equal(response.answer, "The answer.");
	assert.equal(response.results[0].url, "https://a.test/");
});

test("domain filters are passed through in both directions", async () => {
	let sent;
	const fetchImpl = async (_url, init) => {
		sent = JSON.parse(init.body);
		return new Response(JSON.stringify({ output: [{ type: "web_search_call" }, messageItem("a", [])] }));
	};
	const auth = { apiKey: "k", model: "m", headers: {}, responsesUrl: "https://api.openai.com/v1/responses", codex: false };
	await search("q", auth, { domainFilter: ["arxiv.org", "-spam.test"], recencyFilter: "week", fetch: fetchImpl });
	assert.deepEqual(sent.tools[0].filters.allowed_domains, ["arxiv.org"]);
	assert.deepEqual(sent.tools[0].filters.blocked_domains, ["spam.test"]);
	assert.match(sent.instructions, /past week/);
});

test("an API error never leaks the credential", async () => {
	const auth = { apiKey: "sk-super-secret", model: "m", headers: {}, responsesUrl: "https://api.openai.com/v1/responses", codex: false };
	const fetchImpl = async () => new Response("bad key sk-super-secret used", { status: 401 });
	await assert.rejects(() => search("q", auth, { fetch: fetchImpl }), (error) => {
		assert.doesNotMatch(error.message, /sk-super-secret/);
		assert.match(error.message, /OpenAI API error 401/);
		return true;
	});
});
