// For you redesign: memory cards, work context + "to" routing, job cards (nothing runs without brook's tap),
// the daily pile check, and the judgment log.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgePrompt, parseInbox, parsePile, parseVerdict, pilePrompt, publicItem } from "../src/proactive.ts";
import { applyCardEdits, cardName, listCards, memoryForPrompt, migrateMemory, readIndex, relevantCards } from "../src/proactive-memory.ts";
import { answerCard, cardChoices, currentCard, sendTargets, suggestItem } from "../src/proactive-store.ts";
import register, { CARD_ELSE, CARD_NO, CARD_SEND, choiceLabel } from "../extensions/foryou.ts";

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



test("pile check: closes and merges only open loops it names", () => {
	const open = new Set(["a", "b", "c"]);
	const p = pilePrompt({ me: "brook", memory: "", open: [loop("a"), loop("b")], now: "n" });
	assert.match(p, /id=a: Loop a[\s\S]*created 2026-10-09/);
	const v = parsePile('ok {"close":[{"id":"a","why":"old"},{"id":"zz"}],"merge":[{"keep":"b","drop":"c","why":"same"},{"keep":"b","drop":"b"}]}', open);
	assert.deepEqual(v, { close: [{ id: "a", why: "old" }], merge: [{ keep: "b", drop: "c", why: "same" }], route: [], choices: [] });
	assert.deepEqual(parsePile("nonsense", open), { close: [], merge: [], route: [], choices: [] });
	// Existing loops can be routed to a live session (card), but never a closed one or an unknown session.
	const r = parsePile('{"close":[{"id":"a"}],"route":[{"id":"b","to":"s1"},{"id":"a","to":"s1"},{"id":"c","to":"zz"}]}', open, new Set(["s1"]));
	assert.deepEqual(r.route, [{ id: "b", to: "s1", why: "" }]);
	assert.match(pilePrompt({ me: "b", memory: "", open: [loop("a")], now: "n", work: [{ id: "s1", name: "minara", cwd: "/m" }] }), /id=s1 "minara" in \/m[\s\S]*"route"/);
});

function fakePi() {
	const handlers = {}, sent = [];
	return { handlers, sent, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, on: (e, h) => { (handlers[e] ??= []).push(h); }, sendUserMessage: m => sent.push(m) };
}
const macCtx = (id, picks, notes = []) => ({ hasUI: true, cwd: "/nd", isIdle: () => true, sessionManager: { getSessionId: () => id },
	ui: { select: async (title, options) => (notes.push({ title, options }), (p => typeof p === "function" ? p(options) : p)(picks.shift())), input: async () => picks.shift(), notify: m => notes.push(m) } });



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

test("regression: ✓ Done and Now work from the phone through the relay", async () => {
	const { relayAllowed } = await import("../src/remote-relay-agent.ts");
	for (const verb of ["act", "dismiss", "later", "done", "now", "card"]) assert.ok(relayAllowed(`/api/foryou/abc123/${verb}`, "POST"), verb);
	assert.ok(!relayAllowed("/api/foryou/abc123/rm", "POST"));
});

test("health: a source failing 3 checks in a row shows in For you; one success clears it", async () => {
	const { trackHealth, healthSummary, problemText } = await import("../src/proactive.ts");
	const { forYouView } = await import("../src/proactive-store.ts");
	assert.equal(problemText('error: {"type":"authentication","subtype":"token_invalid"}'), "login expired");
	let st = {};
	for (let i = 0; i < 2; i++) st = trackHealth(st, [{ source: "黄恩浩", error: "token_invalid" }, { source: "Knight", error: "token_invalid" }], [], `t${i}`);
	assert.deepEqual(healthSummary(st), [], "a blip is not shown");
	st = trackHealth(st, [{ source: "黄恩浩", error: "token_invalid" }, { source: "Knight", error: "token_invalid" }], [], "t2");
	assert.deepEqual(healthSummary(st), [{ text: "Feishu: login expired (2 chats)", since: "t0" }]);
	st = trackHealth(st, [], ["黄恩浩", "Knight"], "t3");
	assert.deepEqual(healthSummary(st), []);
	const d = tmp();
	writeFileSync(join(d, "health.json"), JSON.stringify({ problems: [{ text: "Feishu: login expired (2 chats)", since: "t0" }] }));
	assert.deepEqual(forYouView(d).problems, [{ text: "Feishu: login expired (2 chats)", since: "t0" }]);
});


const inbox = d => parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"));
const live = [{ id: "pix-foryou", name: "For you", cwd: "/h" }, { id: "s1", name: "backtest", cwd: "/w/nd" }, { id: "s2", name: "minara", cwd: "/w/other" }, { id: "s3", name: "pix", cwd: "/w/pix" }];

test("card: For you shows the oldest loop that needs brook, one at a time", () => {
	const d = tmp(loop("new", { at: "2026-10-10T00:00:00Z" }), loop("old", { at: "2026-10-09T00:00:00Z" }), loop("parked", { at: "2026-10-01T00:00:00Z", status: "later", wakeAt: "2099-01-01" }));
	const c = currentCard(d, live, Date.parse("2026-10-12T00:00:00Z"));
	assert.equal(c.id, "old"); assert.equal(c.left, 1, "one more waits behind it");
	assert.equal(currentCard(tmp(), live), undefined);
});

test("card buttons: the judge writes them; a closed session becomes a new one; no buttons falls back to Do it here", () => {
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "Fix wallet", for: "me", evidence: "x", choices: [{ label: "Fix in minara", run: "s2" }, { label: "Ask Lowes", run: "here", prompt: "Ask Lowes for steps" }, { label: "Bad", run: "../x" }, { label: "Discuss", run: "discuss" }, { label: "Not now", run: "later" }, { label: "Too many", run: "here" }] }] }));
	assert.deepEqual(v.alerts[0].choices, [{ label: "Fix in minara", run: "s2" }, { label: "Ask Lowes", run: "here", prompt: "Ask Lowes for steps" }, { label: "Discuss", run: "discuss" }], "valid ones only, at most 3");
	assert.match(judgePrompt({ me: "b", memory: "", source: { kind: "feishu", id: "c", name: "G" }, context: [], fresh: [], pending: [], now: "n" }), /"choices" are the buttons on his card: the 1-3 moves/);
	const it = loop("a", { project: "/w", choices: [...v.alerts[0].choices, { label: "Not now", run: "later" }] });
	assert.deepEqual(cardChoices(it, live).map(c => [c.label, c.run, c.name]), [["Fix in minara", "s2", "minara"], ["Ask Lowes", "here", undefined], ["Discuss", "discuss", undefined], ["Not now", "later", undefined]]);
	assert.deepEqual(cardChoices(it, []).map(c => c.run), ["new", "here", "discuss", "later"], "session gone: a new session in the project");
	assert.deepEqual(cardChoices(loop("b"), live).map(c => c.label), ["Do it here", "Discuss", "Later"]);
});

test("card answers: a here button runs in For you with its prompt; a session button hands off; first answer wins; all logged", () => {
	const ch = [{ label: "Fix in minara", run: "s2", prompt: "Fix the wallet picker" }, { label: "Ask Lowes", run: "here", prompt: "Ask Lowes for steps" }, { label: "Talk", run: "discuss" }];
	const d = tmp(loop("a", { choices: ch }), loop("b", { choices: ch }), loop("c", { choices: ch }), loop("e"));
	const a = answerCard("a", "choice", { choice: 1, by: "phone", dir: d, live });
	assert.match(a.here, /tapped "Ask Lowes" on loop a[\s\S]*Ask Lowes for steps/);
	assert.equal(answerCard("a", "later", { dir: d }), undefined, "second answer loses");
	assert.equal(inbox(d).find(i => i.id === "a").session, "pix-foryou");
	assert.match(answerCard("b", "choice", { choice: 2, dir: d, live }).here, /Change nothing and send nothing yet/);
	assert.equal(answerCard("c", "choice", { choice: 7, dir: d, live }), undefined, "no such button");
	assert.equal(answerCard("c", "choice", { choice: 0, dir: d, live }).into, "s2");
	assert.equal(inbox(d).find(i => i.id === "c").action, "Fix the wallet picker", "the session gets the button's task");
	assert.equal(answerCard("e", "else", { text: " ", dir: d }), undefined);
	assert.match(answerCard("e", "else", { text: "Just thank Knight", dir: d }).here, /own instruction[\s\S]*Just thank Knight/);
	const log = readFileSync(join(d, "judgments.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.deepEqual(log.map(l => [l.id, l.answer, l.label]), [["a", "choice", "Ask Lowes"], ["b", "choice", "Talk"], ["c", "choice", "Fix in minara"], ["e", "else", undefined]]);
});

test("card: a Later button comes back in 2 days in the morning; a No button closes the loop", () => {
	const ch = [{ label: "Not now", run: "later" }, { label: "Skip", run: "no" }];
	const d = tmp(loop("a", { choices: ch }), loop("b", { choices: ch }));
	assert.ok(answerCard("a", "choice", { choice: 0, dir: d, now: new Date("2026-10-13T05:00:00") }));
	assert.equal(inbox(d).find(i => i.id === "a").wakeAt, new Date("2026-10-15T09:00:00").toISOString());
	assert.ok(answerCard("b", "choice", { choice: 1, dir: d }));
	assert.equal(inbox(d).find(i => i.id === "b").status, "dismissed");
});

test("Mac: the card shows only in the For you session, with the judge's buttons, and answers through the hub", async () => {
	const d = tmp(loop("a", { choices: [{ label: "Fix in backtest", run: "s1" }, { label: "Discuss", run: "discuss" }] }));
	const pi = fakePi(), answers = [];
	register(pi, { dir: d, sessions: async () => live, answer: async (id, body) => (answers.push([id, body]), "ok"), cardPollMs: 60_000 });
	const shown = [];
	await pi.handlers.agent_end[0]({}, macCtx("s1", ["x"], shown));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown.length, 0, "work sessions are never interrupted");
	const fix = choiceLabel({ label: "Fix in backtest", run: "s1", name: "backtest" });
	pi.handlers.agent_end[0]({}, macCtx("pix-foryou", [fix], shown));
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(shown[0].options, ["Fix in backtest (backtest) ›", "Discuss", CARD_NO, CARD_SEND, CARD_ELSE]);
	assert.deepEqual(answers, [["a", { answer: "choice", choice: 0, text: undefined }]]);
});

test("Mac: without the hub the card answers directly; dismissing the picker changes nothing", async () => {
	const d = tmp(loop("a"));
	const pi = fakePi();
	register(pi, { dir: d, sessions: async () => [], answer: async () => "nohub", cardPollMs: 60_000 });
	pi.handlers.agent_end[0]({}, macCtx("pix-foryou", [undefined]));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(pi.sent.length, 0); assert.equal(inbox(d)[0].status, "pending");
	pi.handlers.agent_end[0]({}, macCtx("pix-foryou", [CARD_ELSE, "only draft it"]));
	await new Promise(r => setTimeout(r, 20));
	assert.match(pi.sent[0], /only draft it/);
});

test("chat: the For you session knows which card brook is looking at, so he can talk about 'this one'", async () => {
	const { coordinatorContext } = await import("../src/proactive-store.ts");
	const d = tmp(loop("a", { choices: [{ label: "Fix it", run: "s1" }] }));
	const ctx = coordinatorContext(d, live);
	assert.match(ctx, /The card on brook's screen now\nid=a "Loop a" \(0 more after it\)/);
	assert.match(ctx, /"Fix it" -> s1/);
	assert.match(ctx, /chat with you about a card/);
});

test("every card can be dropped as not important, or sent to any open session (likeliest first, or a new one)", async () => {
	const it = loop("a", { project: "/w/minara", suggest: { session: "s1", at: "" } });
	const ses = [{ id: "s9", name: "other", cwd: "/x" }, { id: "s2", name: "minara", cwd: "/w/minara" }, ...live.filter(s => s.id === "s1"), { id: "pix-foryou", name: "For you", cwd: "/f" }];
	assert.deepEqual(sendTargets(it, ses, "/h").map(s => s.id), ["s1", "s2", "s9", "new"], "judge's pick, then same project, then the rest; never For you");
	const d = tmp(loop("a", { project: "/w" }), loop("b"), loop("c"));
	assert.equal(answerCard("a", "send", { to: "s9", dir: d }).into, "s9");
	assert.equal(answerCard("b", "send", { to: "new", dir: d }), undefined, "no project: no new session");
	assert.equal(answerCard("b", "send", { to: "../x", dir: d }), undefined);
	assert.ok(answerCard("c", "no", { dir: d }));
	assert.equal(inbox(d).find(i => i.id === "c").status, "dismissed");
	const log = readFileSync(join(d, "judgments.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
	assert.deepEqual(log.map(l => [l.id, l.answer, l.to]), [["a", "send", "s9"], ["c", "no", undefined]]);
});

test("Mac: Send to a session… asks which one, then hands it there", async () => {
	const d = tmp(loop("a"));
	const pi = fakePi(), answers = [], shown = [];
	register(pi, { dir: d, sessions: async () => live, answer: async (id, body) => (answers.push([id, body]), "ok"), cardPollMs: 60_000 });
	pi.handlers.agent_end[0]({}, macCtx("pix-foryou", [CARD_SEND, (o) => o.find(x => x.startsWith("backtest"))], shown));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown[1].title, "Send to which session?");
	assert.deepEqual(answers, [["a", { answer: "send", choice: undefined, to: "s1", text: undefined }]]);
});

test("pile check writes specific buttons for old loops that have none, and the prompt shows what each loop is about", async () => {
	const { pilePrompt, parsePile } = await import("../src/proactive.ts");
	const p = pilePrompt({ me: "b", memory: "", now: "n", open: [loop("a", { why: "fake coins", action: "ask 王", choices: [{ label: "X", run: "here" }] }), loop("b")] });
	assert.match(p, /why: fake coins\n  next: ask 王\n  choices: X \(here\)/);
	assert.match(p, /never a generic set/);
	const v = parsePile(JSON.stringify({ choices: [{ id: "b", choices: [{ label: "Ask 王", run: "here" }, { label: "bad", run: "../" }] }, { id: "zz", choices: [{ label: "x", run: "here" }] }] }), new Set(["a", "b"]));
	assert.deepEqual(v.choices, [{ id: "b", choices: [{ label: "Ask 王", run: "here" }] }]);
});
