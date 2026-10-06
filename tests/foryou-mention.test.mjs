import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { expandForYou, forYouSuggestions, withForYou } from "../src/foryou-mention.ts";
import { readPending } from "../src/proactive-store.ts";
import { parseInbox } from "../src/proactive.ts";

const item = { id: "251a4abe", at: "2026-10-06T08:21:22Z", title: "Knight 提醒核对回测设置", why: "W", action: "A", refs: [], source: "Decision Model", sourceKey: "feishu:c", howToRead: "HOW", status: "pending" };
const inboxDir = () => { const d = mkdtempSync(join(tmpdir(), "pix-foryou-")); writeFileSync(join(d, "inbox.jsonl"), JSON.stringify(item) + "\n"); return d; };

test("@ suggests pending items by id, title, or 'foryou'", () => {
	for (const p of ["@", "@for", "@foryou:", "@251", "@knight"]) assert.equal(forYouSuggestions(p, [item])[0]?.value, "@foryou:251a4abe", p);
	assert.deepEqual(forYouSuggestions("@src/", [item]), []);
	assert.deepEqual(forYouSuggestions("hello", [item]), []);
});

test("real pi-tui provider: items appear above files and complete into a mention", async () => {
	const provider = withForYou(new CombinedAutocompleteProvider([], process.cwd(), null), () => [item]);
	const lines = ["look at @kni"];
	const s = await provider.getSuggestions(lines, 0, lines[0].length, { signal: new AbortController().signal });
	assert.equal(s.items[0].value, "@foryou:251a4abe");
	const done = provider.applyCompletion(lines, 0, lines[0].length, s.items[0], s.prefix);
	assert.equal(done.lines[0], "look at @foryou:251a4abe ");
});

test("submitting a mention expands the task and closes the item everywhere", () => {
	const dir = inboxDir();
	const out = expandForYou("please @foryou:251a4abe now", "sess-1", dir);
	assert.match(out, /Knight 提醒核对回测设置/); assert.match(out, /HOW/); assert.match(out, /do not send without my confirmation/);
	assert.deepEqual(readPending(dir), []);
	const [it] = parseInbox(readFileSync(join(dir, "inbox.jsonl"), "utf8"));
	assert.equal(it.status, "done"); assert.equal(it.session, "sess-1");
	assert.equal(expandForYou("again @foryou:251a4abe", "s", dir), "again @foryou:251a4abe", "handled ids stay as typed");
});
