// For you redesign: memory cards, work context + "to" routing, job cards (nothing runs without brook's tap),
// the daily pile check, and the judgment log.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgePrompt, parseInbox, parsePile, parseVerdict, pilePrompt, publicItem } from "../src/proactive.ts";
import { applyCardEdits, cardName, listCards, memoryForPrompt, migrateMemory, readIndex, relevantCards } from "../src/proactive-memory.ts";
import { answerSuggestion, cardTask, openSuggestions, suggestItem } from "../src/proactive-store.ts";
import register, { CARD_DO, CARD_ELSE, CARD_NOT_NOW } from "../extensions/foryou.ts";

const loop = (id, extra = {}) => ({ id, at: "2026-10-09T08:34:00Z", title: `Loop ${id}`, why: "W", action: "Switch loader", refs: [], source: "Knight", sourceKey: "feishu:a", howToRead: "", status: "pending", ...extra });
const tmp = (...items) => { const d = mkdtempSync(join(tmpdir(), "pix-fy-")); writeFileSync(join(d, "inbox.jsonl"), items.map(i => JSON.stringify(i)).join("\n") + (items.length ? "\n" : "")); return d; };

test("memory: old memory.md moves into person/project cards; index keeps the rest and lists cards", () => {
	const d = tmp();
	writeFileSync(join(d, "memory.md"), "# Proactive memory\n\n## About me\n- I am brook.\n\n## People\n- Knight: teammate on newsdecision.\n- 杨奕辉: most active member.\n\n## Projects\n- newsdecision (~/workspace/minara/newsdecision): a decision model.\n  Order: data, then backtest.\n\n## Learned\n- something learned\n");
	assert.equal(migrateMemory(d), true);
	assert.equal(migrateMemory(d), false, "only once");
	assert.deepEqual(listCards(d).map(c => c.name), ["people/Knight", "people/杨奕辉", "projects/newsdecision"]);
	assert.match(listCards(d)[2].text, /^# newsdecision \(~\/workspace\/minara\/newsdecision\)\n- a decision model.\n- Order: data, then backtest.\n$/);
	const index = readIndex(d);
	assert.match(index, /- I am brook\./);
	assert.match(index, /- something learned/);
	assert.doesNotMatch(index, /## People/, "people moved out to cards");
	assert.match(index, /## Cards[\s\S]*- people\/Knight: teammate on newsdecision\./);
});

test("memory: the judge gets the index plus only the cards the messages touch", () => {
	const d = tmp();
	applyCardEdits(d, [{ card: "people/Knight", add: ["data sources"], remove: [] }, { card: "people/Amber", add: ["design lead"], remove: [] }]);
	const msgs = [{ id: "1", time: "", sender: "Knight", text: "doc is ready" }];
	assert.deepEqual(relevantCards(listCards(d), { msgs }).map(c => c.name), ["people/Knight"]);
	const m = memoryForPrompt(d, { msgs });
	assert.match(m, /### Card people\/Knight/);
	assert.doesNotMatch(m, /### Card people\/Amber/);
	assert.match(m, /people\/Amber: .*design lead/, "the index still lists every card");
});

test("memory: card edits are dated and sourced, dedupe, remove by text, and reject unsafe names", () => {
	const d = tmp();
	const now = new Date("2026-10-12T10:00:00Z");
	let ch = applyCardEdits(d, [{ card: "projects/newsdecision", add: ["Live Arena demo is the goal", "Live Arena demo is the goal"], remove: [] }], { source: "新闻群", now });
	assert.deepEqual(ch[0].added, ["- 2026-10-12: Live Arena demo is the goal (from 新闻群)"]);
	ch = applyCardEdits(d, [{ card: "projects/newsdecision", add: ["Live Arena demo is the goal"], remove: [] }]);
	assert.equal(ch.length, 0, "same fact again is not added");
	ch = applyCardEdits(d, [{ card: "projects/newsdecision", add: [], remove: ["Live Arena demo is the goal"] }]);
	assert.equal(ch[0].removed.length, 1);
	assert.equal(cardName("../etc/passwd"), undefined);
	assert.equal(cardName("people/../../x"), "people/x");
	assert.equal(cardName("notes/x"), undefined);
});

test("judge: sees what brook is working on, may route a loop to a session, and edits cards", () => {
	const p = judgePrompt({ me: "brook", memory: "", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: [], pending: [], now: "n", cards: true,
		work: [{ id: "s1", name: "backtest", cwd: "/nd", busy: true, todo: "Switch loader to fmp", preview: "running" }] });
	assert.match(p, /id=s1 "backtest" in \/nd \(busy\); doing: Switch loader to fmp; last: running/);
	assert.match(p, /"to": "session id or omit"/);
	assert.match(p, /"cards": \[\{"card": "people\/Knight"/);
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "Use fmp doc", for: "project", evidence: "Knight delivered", to: "s1" }, { title: "Bad", for: "me", evidence: "x", to: "../x" }], cards: [{ card: "people/Knight", add: ["fmp doc done"] }, { card: "x", add: [] }] }));
	assert.equal(v.alerts[0].to, "s1");
	assert.equal(v.alerts[1].to, undefined, "unsafe session id dropped");
	assert.deepEqual(v.cards, [{ card: "people/Knight", add: ["fmp doc done"], remove: [] }]);
});

test("job card: nothing runs until brook answers; first answer wins; every answer is logged", () => {
	const d = tmp(loop("a"));
	assert.equal(suggestItem("a", { id: "s1", name: "backtest" }, d), true);
	assert.deepEqual(openSuggestions(d).map(i => i.id), ["a"]);
	assert.equal(cardTask("a", "s1", "/nd", d), undefined, "no task before an answer");
	assert.deepEqual(publicItem(parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"))[0]).suggest, { session: "s1", name: "backtest" });
	assert.ok(answerSuggestion("a", "do", { by: "phone", dir: d }));
	assert.equal(answerSuggestion("a", "notnow", { by: "mac", dir: d }), undefined, "second answer loses");
	const task = cardTask("a", "s1", "/nd", d);
	assert.match(task, /tapped "Do it"[\s\S]*Switch loader/);
	assert.equal(cardTask("a", "s1", "/nd", d), undefined, "runs once");
	assert.equal(cardTask("a", "other", "/nd", d), undefined, "only in the asked session");
	const [it] = parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"));
	assert.equal(it.status, "onit"); assert.equal(it.session, "s1");
	const log = readFileSync(join(d, "judgments.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.deepEqual(log.map(l => [l.kind, l.answer, l.by]), [["card", "do", "phone"]]);
});

test("job card: Not now keeps the loop in For you; Something else needs text and runs brook's words", () => {
	const d = tmp(loop("a"), loop("b"));
	suggestItem("a", { id: "s1" }, d); suggestItem("b", { id: "s2" }, d);
	assert.ok(answerSuggestion("a", "notnow", { dir: d }));
	assert.equal(cardTask("a", "s1", "/x", d), undefined);
	assert.equal(parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8")).find(i => i.id === "a").status, "pending");
	assert.equal(answerSuggestion("b", "else", { text: "  ", dir: d }), undefined);
	assert.ok(answerSuggestion("b", "else", { text: "Just reply thanks to Knight", dir: d }));
	assert.match(cardTask("b", "s2", "/x", d), /^brook answered a For you card with his own instruction[\s\S]*Just reply thanks to Knight/);
	assert.deepEqual(openSuggestions(d), []);
});

test("pile check: closes and merges only open loops it names", () => {
	const open = new Set(["a", "b", "c"]);
	const p = pilePrompt({ me: "brook", memory: "", open: [loop("a"), loop("b")], now: "n" });
	assert.match(p, /id=a: Loop a[\s\S]*created 2026-10-09/);
	const v = parsePile('ok {"close":[{"id":"a","why":"old"},{"id":"zz"}],"merge":[{"keep":"b","drop":"c","why":"same"},{"keep":"b","drop":"b"}]}', open);
	assert.deepEqual(v, { close: [{ id: "a", why: "old" }], merge: [{ keep: "b", drop: "c", why: "same" }] });
	assert.deepEqual(parsePile("nonsense", open), { close: [], merge: [] });
});

function fakePi() {
	const handlers = {}, sent = [];
	return { handlers, sent, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, on: (e, h) => { (handlers[e] ??= []).push(h); }, sendUserMessage: m => sent.push(m) };
}
const macCtx = (id, picks, notes = []) => ({ hasUI: true, cwd: "/nd", isIdle: () => true, sessionManager: { getSessionId: () => id },
	ui: { select: async (title, options) => (notes.push({ title, options }), picks.shift()), input: async () => picks.shift(), notify: m => notes.push(m) } });

test("Mac: the card shows Do it / Not now / Something else in its session and Do it sends the work", async () => {
	const d = tmp(loop("a"));
	suggestItem("a", { id: "s1" }, d);
	const pi = fakePi(); register(pi, { dir: d, sessions: async () => [], cardPollMs: 60_000 });
	const shown = [];
	await pi.handlers.agent_end[0]({}, macCtx("other", [CARD_DO], shown));
	assert.equal(shown.length, 0, "other sessions see nothing");
	await new Promise(r => setTimeout(r, 0));
	pi.handlers.agent_end[0]({}, macCtx("s1", [CARD_DO], shown));
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(shown[0].options, [CARD_DO, CARD_NOT_NOW, CARD_ELSE]);
	assert.match(shown[0].title, /For you · Knight\nLoop a/);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0], /tapped "Do it"/);
	assert.equal(JSON.parse(readFileSync(join(d, "judgments.jsonl"), "utf8")).by, "mac");
});

test("Mac: Something else asks for text; dismissing the picker changes nothing", async () => {
	const d = tmp(loop("a"));
	suggestItem("a", { id: "s1" }, d);
	const pi = fakePi(); register(pi, { dir: d, sessions: async () => [], cardPollMs: 60_000 });
	pi.handlers.agent_end[0]({}, macCtx("s1", [undefined]));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(pi.sent.length, 0); assert.equal(openSuggestions(d).length, 1);
	pi.handlers.agent_end[0]({}, macCtx("s1", [CARD_ELSE, "only draft it"]));
	await new Promise(r => setTimeout(r, 20));
	assert.match(pi.sent[0], /only draft it/);
	assert.ok(!existsSync(join(d, "nothing")));
});

test("judgment log: weekly prune keeps the last 30 days and unreadable lines", async () => {
	const { pruneLog } = await import("../src/proactive.ts");
	const now = Date.parse("2026-10-12T00:00:00Z");
	const text = [{ at: "2026-08-01T00:00:00Z", kind: "judge" }, { at: "2026-10-01T00:00:00Z", kind: "error" }].map(x => JSON.stringify(x)).join("\n") + "\nnot json\n";
	assert.equal(pruneLog(text, now), JSON.stringify({ at: "2026-10-01T00:00:00Z", kind: "error" }) + "\nnot json\n");
});

test("regression: a loop Pi finished does not sit silently in 'Pi is on it'", async () => {
	const { staleOnit } = await import("../src/proactive.ts");
	const { finishedItem } = await import("../src/proactive-store.ts");
	const now = Date.parse("2026-10-12T20:00:00Z");
	const old = loop("o", { status: "onit", session: "s", at_status: "2026-10-10T00:00:00Z" });
	const fresh = loop("f", { status: "onit", session: "s", at_status: "2026-10-12T19:00:00Z" });
	assert.deepEqual(staleOnit([old, fresh, loop("p")], now).map(i => i.id), ["o"], "untouched for 6 h comes back");
	// A session that finishes says so: the loop returns to brook with a Check button.
	const d = tmp(old);
	assert.equal(finishedItem("o", "  ", d), false);
	assert.ok(finishedItem("o", "Form filled, screenshot confirmed", d));
	const [it] = parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"));
	assert.equal(it.status, "pending"); assert.equal(it.button, "Check result");
	assert.match(it.note, /Finished: Form filled/);
});

test("regression: the pile check sees each loop's latest progress, so it can close finished ones", () => {
	const p = pilePrompt({ me: "b", memory: "", open: [loop("a", { note: "- 2026-10-10: old\n- 2026-10-11: Submitted and verified" })], now: "n" });
	assert.match(p, /latest progress: - 2026-10-11: Submitted and verified/);
	assert.match(p, /says the work is finished[\s\S]*close it/);
});
