import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configureWeb,
	normalizeProxyUrl,
	readWebSettings,
	setAllowRanges,
	setMaxInlineChars,
	updateWebSettings,
} from "../src/web-settings.ts";

function fixture(t, initial = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pix-web-settings-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "web-search.json");
	writeFileSync(path, JSON.stringify(initial));
	return path;
}

test("an edit preserves unrelated keys and keeps the file private", (t) => {
	const path = fixture(t, { openaiApiKey: "$OPENAI_KEY", other: { keep: true } });
	updateWebSettings((c) => setMaxInlineChars(c, "40000"), path);
	assert.deepEqual(readWebSettings(path), { openaiApiKey: "$OPENAI_KEY", other: { keep: true }, maxInlineContentChars: 40000 });
	assert.equal(statSync(path).mode & 0o777, 0o600, "credentials must not be world-readable");
});

test("a missing settings file reads as empty rather than failing", (t) => {
	const path = join(fixture(t), "..", "absent.json");
	assert.deepEqual(readWebSettings(path), {});
});

test("malformed settings are reported and never overwritten", (t) => {
	const path = fixture(t);
	writeFileSync(path, "{broken");
	assert.throws(() => updateWebSettings((c) => setMaxInlineChars(c, "30000"), path));
	assert.equal(readFileSync(path, "utf8"), "{broken");
	writeFileSync(path, '["not an object"]');
	assert.throws(() => readWebSettings(path), /must be a JSON object/);
});

test("an implausible page size is rejected", (t) => {
	const path = fixture(t);
	for (const value of ["", "abc", "0", "-5", "999"]) {
		assert.throws(() => updateWebSettings((c) => setMaxInlineChars(c, value), path), /at least 1000/);
	}
	updateWebSettings((c) => setMaxInlineChars(c, "12000.7"), path);
	assert.equal(readWebSettings(path).maxInlineContentChars, 12000);
});

test("allowed ranges are stored as a list and cleared when emptied", (t) => {
	const path = fixture(t, { openaiApiKey: "keep" });
	updateWebSettings((c) => setAllowRanges(c, "198.18.0.0/15, 10.0.0.0/8"), path);
	assert.deepEqual(readWebSettings(path).ssrf.allowRanges, ["198.18.0.0/15", "10.0.0.0/8"]);
	updateWebSettings((c) => setAllowRanges(c, "  "), path);
	assert.equal(readWebSettings(path).ssrf, undefined);
	assert.equal(readWebSettings(path).openaiApiKey, "keep", "clearing a range must not touch credentials");
});

test("a proxy URL is validated and stripped of query and fragment", () => {
	assert.equal(normalizeProxyUrl("http://127.0.0.1:7890/?a=1#b"), "http://127.0.0.1:7890/");
	assert.equal(normalizeProxyUrl(""), null);
	assert.equal(normalizeProxyUrl(undefined), null);
	for (const value of ["not a url", "ftp://host", "http://"]) {
		assert.throws(() => normalizeProxyUrl(value, "proxy"), /Invalid proxy URL/);
	}
});

function context(answers, notices = []) {
	return {
		hasUI: true,
		ui: {
			select: async (_title, options) => {
				const answer = answers.shift();
				if (answer === undefined) return undefined;
				const match = options.find((o) => o.startsWith(answer));
				assert.ok(match, `${answer} not in ${options}`);
				return match;
			},
			input: async () => answers.shift(),
			notify: (text, level) => notices.push({ text, level }),
		},
	};
}

test("the panel saves a page size limit chosen interactively", async (t) => {
	const path = fixture(t);
	await configureWeb(context(["Page size limit", "50000", undefined]), async () => "", path);
	assert.equal(readWebSettings(path).maxInlineContentChars, 50000);
});

test("widening the network guard warns before it is saved", async (t) => {
	const path = fixture(t);
	const notices = [];
	await configureWeb(context(["Allowed private ranges", "198.18.0.0/15", undefined], notices), async () => "", path);
	assert.deepEqual(readWebSettings(path).ssrf.allowRanges, ["198.18.0.0/15"]);
	assert.ok(notices.some((n) => n.level === "warning"), "a security exemption must be flagged");
});

test("search and fetch diagnostics invoke distinct probes and report failures", async (t) => {
	const path = fixture(t);
	const seen = [];
	const notices = [];
	await configureWeb(context(["Test connection", "Search:", "Test connection", "Fetch:"], notices), async (kind) => {
		seen.push(kind);
		if (kind === "fetch") throw new Error("Blocked internal address");
		return "search succeeded";
	}, path);
	assert.deepEqual(seen, ["search", "fetch"]);
	assert.ok(notices.some((n) => n.level === "error" && /Blocked internal address/.test(n.text)));
});

test("setup help explains that search uses the Pi login", async (t) => {
	const path = fixture(t);
	const notices = [];
	await configureWeb(context(["Setup help", undefined], notices), async () => "", path);
	assert.match(notices[0].text, /Codex login|OpenAI or Codex/);
});

test("cancel leaves settings untouched and noninteractive mode does not prompt", async (t) => {
	const path = fixture(t, { maxInlineContentChars: 25000 });
	const before = readFileSync(path, "utf8");
	await configureWeb(context(["Page size limit", undefined, undefined]), async () => { throw new Error("unexpected"); }, path);
	assert.equal(readFileSync(path, "utf8"), before);
	const notices = [];
	await configureWeb({ hasUI: false, ui: { notify: (text) => notices.push(text) } }, async () => "", path);
	assert.match(notices[0], /interactive UI/);
});

test("a direct proxy choice persists without weakening the network guard", async (t) => {
	const path = fixture(t, { ssrf: { allowRanges: [] }, other: 42 });
	await configureWeb(context(["Proxy", "Direct", undefined]), async () => "", path);
	assert.deepEqual(readWebSettings(path), { ssrf: { allowRanges: [] }, other: 42, proxy: "" });
});
