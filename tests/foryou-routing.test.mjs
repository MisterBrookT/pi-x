// For you redesign: memory cards, work context + "to" routing, job cards (nothing runs without brook's tap),
// the daily pile check, and the judgment log.
import assert from "node:assert/strict";
import test from "node:test";
import { forYouHub, forYouRelayAllowed } from "../plugins/foryou/hub.ts";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgePrompt, parseInbox, parsePile, parseVerdict, pilePrompt, publicItem } from "../plugins/foryou/proactive.ts";
import { applyCardEdits, cardName, listCards, memoryForPrompt, migrateMemory, readIndex, relevantCards } from "../plugins/foryou/proactive-memory.ts";
import { answerCard, cardChoices, currentCard, sendTargets, suggestItem } from "../plugins/foryou/proactive-store.ts";
import register, { CARD_ALL, CARD_ELSE, CARD_NO, choiceLabel } from "../plugins/foryou/index.ts";

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
	const handlers = {}, sent = [], deliveries = [];
	const commands = {}, renderers = {}, custom = [];
	return { handlers, sent, deliveries, commands, renderers, custom, registerTool() {}, registerShortcut: (k, c) => { commands[k] = c; }, registerCommand: (k, c) => { commands['/' + k] = c; }, registerMessageRenderer: (t, r) => { renderers[t] = r; }, registerMarkdownTransformer: f => { renderers.md = f; }, sendMessage: (m, o) => custom.push([m, o]), getActiveTools: () => [], setActiveTools() {}, on: (e, h) => { (handlers[e] ??= []).push(h); }, sendUserMessage: (m, options) => { sent.push(m); deliveries.push(options); } };
}
const macCtx = (id, picks, notes = [], widgets = []) => ({ mode: "tui", hasUI: true, cwd: "/nd", isIdle: () => true, sessionManager: { getSessionId: () => id },
	ui: { select: async (title, options) => (notes.push({ title, options }), (p => typeof p === "function" ? p(options) : p)(picks.shift())), input: async () => picks.shift(), notify: m => notes.push(m), setWidget: (k, v) => widgets.push([k, v]) } });
/** brook answers the card on the Mac: /card opens the picker (it never pops up by itself). */
const cardCmd = (pi, ctx) => pi.commands["super+shift+y"].handler(ctx);



test("judgment log: weekly prune keeps the last 30 days and unreadable lines", async () => {
	const { pruneLog } = await import("../plugins/foryou/proactive.ts");
	const now = Date.parse("2026-10-12T00:00:00Z");
	const text = [{ at: "2026-08-01T00:00:00Z", kind: "judge" }, { at: "2026-10-01T00:00:00Z", kind: "error" }].map(x => JSON.stringify(x)).join("\n") + "\nnot json\n";
	assert.equal(pruneLog(text, now), JSON.stringify({ at: "2026-10-01T00:00:00Z", kind: "error" }) + "\nnot json\n");
});

test("regression: a loop Pi finished does not sit silently in 'Pi is on it'", async () => {
	const { staleOnit } = await import("../plugins/foryou/proactive.ts");
	const { finishedItem } = await import("../plugins/foryou/proactive-store.ts");
	const now = Date.parse("2026-10-12T20:00:00Z");
	const old = loop("o", { status: "onit", session: "s", at_status: "2026-10-10T00:00:00Z" });
	const fresh = loop("f", { status: "onit", session: "s", at_status: "2026-10-12T19:00:00Z" });
	assert.deepEqual(staleOnit([old, fresh, loop("p")], now).map(i => i.id), ["o"], "untouched for 6 h comes back");
	// A session that finishes says so: the loop closes quietly with the result in its brief (no new card).
	const d = tmp(old);
	assert.equal(finishedItem("o", "  ", d), false);
	assert.ok(finishedItem("o", "Form filled, screenshot confirmed", d));
	const [it] = parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"));
	assert.equal(it.status, "done", "finished work never re-notifies brook");
	assert.match(it.note, /Finished: Form filled/);
	assert.equal(currentCard(d), undefined, "no card for it");
});

test("regression: the pile check sees each loop's latest progress, so it can close finished ones", () => {
	const p = pilePrompt({ me: "b", memory: "", open: [loop("a", { note: "- 2026-10-10: old\n- 2026-10-11: Submitted and verified" })], now: "n" });
	assert.match(p, /latest progress: - 2026-10-11: Submitted and verified/);
	assert.match(p, /says the work is finished[\s\S]*close it/);
});

test("regression: ✓ Done and Now work from the phone through the relay", async () => {
	const { relayAllowed } = await import("../plugins/remote/remote-relay-agent.ts");
	for (const verb of ["act", "dismiss", "later", "done", "now", "card"]) assert.ok(forYouRelayAllowed(`/api/foryou/abc123/${verb}`, "POST"), verb);
	assert.ok(!forYouRelayAllowed("/api/foryou/abc123/rm", "POST"));
	assert.ok(forYouRelayAllowed("/api/foryou/line/bench/hide", "POST"), "swipe a line away from the phone");
	assert.ok(!forYouRelayAllowed("/api/foryou/line/bench/hide", "GET"));
});

test("health: a source failing 3 checks in a row shows in For you; one success clears it", async () => {
	const { trackHealth, healthSummary, problemText } = await import("../plugins/foryou/proactive.ts");
	const { forYouView } = await import("../plugins/foryou/proactive-store.ts");
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
	const shown = [], widgets = [];
	await pi.handlers.agent_end[0]({}, macCtx("s1", ["x"], shown, widgets));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown.length + widgets.length, 0, "work sessions are never interrupted");
	const fix = choiceLabel({ label: "Fix in backtest", run: "s1", name: "backtest" });
	const fy = macCtx("pix-foryou", [fix], shown, widgets);
	pi.handlers.agent_end[0]({}, fy);
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown.length, 0, "the card never pops up by itself: For you keeps working");
	const list = widgets.filter(w => w[0] === "foryou-live").at(-1)[1];
	assert.equal(list[0], "For you 1");
	assert.match(list[1], /^1 .*Loop a/, "one quiet row; details are behind the shortcut");
	await cardCmd(pi, fy);
	assert.deepEqual(shown[0].options, ["Fix in backtest (backtest) ›", "Discuss", CARD_ELSE, "Later", CARD_NO, CARD_ALL]);
	assert.deepEqual(answers, [["a", { answer: "choice", choice: 0, text: undefined }]]);
});

test("Mac: without the hub the card answers directly; dismissing the picker changes nothing", async () => {
	const d = tmp(loop("a"));
	const pi = fakePi();
	register(pi, { dir: d, sessions: async () => [], answer: async () => "nohub", cardPollMs: 60_000 });
	await cardCmd(pi, macCtx("pix-foryou", [undefined]));
	assert.equal(pi.sent.length, 0); assert.equal(inbox(d)[0].status, "pending");
	await cardCmd(pi, macCtx("pix-foryou", [CARD_ELSE, "only draft it"]));
	assert.match(pi.sent[0], /only draft it/);
});

test("chat: the For you session knows which card brook is looking at, so he can talk about 'this one'", async () => {
	const { coordinatorContext } = await import("../plugins/foryou/proactive-store.ts");
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

test("Mac: one flat list. Open sessions are options in it (no second picker); the task shows once at the top", async () => {
	const d = tmp(loop("a", { project: "/w/nd" }));
	const pi = fakePi(), answers = [], shown = [];
	register(pi, { dir: d, sessions: async () => live, answer: async (id, body) => (answers.push([id, body]), "ok"), cardPollMs: 60_000 });
	await cardCmd(pi, macCtx("pix-foryou", ["Do it in backtest ›"], shown));
	assert.equal(shown.length, 1, "a single picker");
	assert.match(shown[0].title, /Plan: Switch loader/);
	assert.deepEqual(shown[0].options, ["Do it here", "Discuss", "Later", "Do it in backtest ›", CARD_ELSE, CARD_NO, CARD_ALL], "only the session that fits the loop, not every open one");
	assert.deepEqual(answers, [["a", { answer: "send", choice: undefined, to: "s1", text: undefined }]]);
});

test("pile check writes specific buttons for old loops that have none, and the prompt shows what each loop is about", async () => {
	const { pilePrompt, parsePile } = await import("../plugins/foryou/proactive.ts");
	const p = pilePrompt({ me: "b", memory: "", now: "n", open: [loop("a", { why: "fake coins", action: "ask 王", choices: [{ label: "X", run: "here" }] }), loop("b")] });
	assert.match(p, /why: fake coins\n  next: ask 王\n  choices: X \(here\)/);
	assert.match(p, /never a generic set/);
	const v = parsePile(JSON.stringify({ choices: [{ id: "b", choices: [{ label: "Ask 王", run: "here" }, { label: "bad", run: "../" }] }, { id: "zz", choices: [{ label: "x", run: "here" }] }] }), new Set(["a", "b"]));
	assert.deepEqual(v.choices, [{ id: "b", choices: [{ label: "Ask 王", run: "here" }] }]);
});

test("loops tool choices: the coordinator publishes semantic buttons without blocking; they persist and come back as a card", async () => {
	const tools = new Map();
	const pi = { ...fakePi(), registerTool: t => tools.set(t.name, t) };
	const d = tmp(loop("a", { status: "onit", session: "s1" }));
	register(pi, { dir: d, sessions: async () => live, cardPollMs: 60_000 });
	const run = p => tools.get("loops").execute("t", p).then(r => r.content[0].text);
	assert.match(await run({ action: "choices", id: "a", question: "Merge these two?", choices: [{ label: "Merge them", run: "here" }, { label: "Keep both", run: "s1" }] }), /End your turn/);
	const it = inbox(d).find(i => i.id === "a");
	assert.equal(it.status, "pending"); assert.equal(it.action, "Merge these two?");
	const c = currentCard(d, live);
	assert.deepEqual(c.choices.map(x => [x.label, x.run]), [["Merge them", "here"], ["Keep both", "s1"]]);
	assert.match(await run({ action: "choices", id: "a", choices: [{ label: "bad", run: "../x" }] }), /no valid choices/);
	assert.match(await run({ action: "choices", id: "zz", choices: [{ label: "x", run: "here" }] }), /No open loop/);
});

test("a comment always goes to the For you chat, never opens or resumes the owner's tab; decisions send a quiet note", () => {
	const d = tmp(loop("a", { status: "pending", session: "s1" }), loop("b"), loop("c"), loop("e"));
	const r = answerCard("a", "else", { text: "use the other chart", dir: d, live });
	assert.equal(r.into, undefined, "no tab is opened for a comment");
	assert.match(r.here, /s1 owns[\s\S]*use the other chart[\s\S]*forward it to that session over chat/);
	assert.match(inbox(d).find(i => i.id === "a").note, /brook said: use the other chart/, "his comment shows on the post");
	assert.match(answerCard("b", "else", { text: "draft only", dir: d }).here, /own instruction[\s\S]*draft only/, "no owner: For you does it");
	assert.match(answerCard("c", "later", { dir: d }).note, /^\[decision\] brook chose Later/);
	assert.match(answerCard("e", "no", { dir: d }).note, /removed it/);
});

test("coordinator prompt: prefer relevant sessions, publish choices instead of blocking, no unapproved risky work", async () => {
	const { coordinatorContext } = await import("../plugins/foryou/proactive-store.ts");
	const ctx = coordinatorContext(tmp(), live);
	assert.match(ctx, /Never push work into an unrelated session/);
	assert.match(ctx, /do not ask with a blocking question\. Use the loops tool action "choices"/);
	assert.match(ctx, /type his\nown answer or pick Later/);
	assert.match(ctx, /Do not start expensive or risky work/);
});

test("regression: typing 'latter' (or later/no/done) on a card acts on the loop instead of becoming a task", () => {
	const d = tmp(loop("a"), loop("b"), loop("c"), loop("e"));
	assert.equal(answerCard("a", "else", { text: "latter", dir: d, now: new Date("2026-10-13T05:00:00") }).here, undefined);
	assert.equal(inbox(d).find(i => i.id === "a").status, "later");
	assert.equal(answerCard("b", "else", { text: "算了", dir: d }).here, undefined);
	assert.equal(inbox(d).find(i => i.id === "b").status, "dismissed");
	answerCard("c", "else", { text: "Done.", dir: d });
	assert.equal(inbox(d).find(i => i.id === "c").status, "done");
	assert.match(answerCard("e", "else", { text: "later reply to Knight with the doc", dir: d }).here, /own instruction/, "a real instruction still goes to For you");
});

test("Mac transcript: Pix's loop prompt is stored as a folded pix-loop message; the model still gets the full text", async () => {
	const { actPrompt } = await import("../plugins/foryou/proactive.ts");
	const pi = fakePi();
	register(pi, { dir: tmp(), sessions: async () => [], cardPollMs: 60_000 });
	const text = `brook tapped "Draft reply" on loop a. Do it here.\n\n${actPrompt(loop("a", { title: "确认是否加入这两个" }), "/tmp/p")}`;
	const r = await pi.handlers.input[0]({ type: "input", text, source: "extension" });
	assert.equal(r.action, "handled");
	const [m, o] = pi.custom[0];
	assert.equal(m.customType, "pix-loop"); assert.equal(m.content, text); assert.deepEqual(m.details, { title: "确认是否加入这两个", you: "Draft reply" });
	assert.equal(o.triggerTurn, true);
	assert.equal((await pi.handlers.input[0]({ type: "input", text: "hello", source: "extension" })).action, "continue");
	assert.equal((await pi.handlers.input[0]({ type: "input", text, source: "interactive" })).action, "continue", "brook's own typing is never touched");
	const theme = { fg: (_c, t) => t, bold: t => t, bg: (_c, t) => t };
	const lines = pi.renderers["pix-loop"](m, { expanded: false, outputPad: 0 }, theme).render(80).join("\n");
	assert.match(lines, /↳ loop 确认是否加入这两个, you: Draft reply/); assert.doesNotMatch(lines, /proactive-daemon/);
});

test("Mac: in For you, a short reply (a button number, later/no/done) answers the waiting card; other text is chat", async () => {
	const d = tmp(loop("a", { choices: [{ label: "Fix it", run: "s1" }, { label: "Talk", run: "discuss" }] }));
	const pi = fakePi(), answers = [], notes = [];
	register(pi, { dir: d, sessions: async () => live, answer: async (id, body) => (answers.push([id, body]), "ok"), cardPollMs: 60_000 });
	const ctx = macCtx("pix-foryou", [], notes);
	const send = text => pi.handlers.input[0]({ type: "input", text, source: "interactive" }, ctx);
	assert.equal((await send("why this one?")).action, "continue");
	assert.equal((await send("2")).action, "handled");
	assert.equal((await send("latter")).action, "handled");
	assert.equal((await send("9")).action, "continue", "no such button: plain chat");
	assert.deepEqual(answers, [["a", { answer: "choice", choice: 1 }], ["a", { answer: "else", text: "latter" }]]);
	assert.equal((await pi.handlers.input[0]({ type: "input", text: "2", source: "interactive" }, macCtx("s1", []))).action, "continue", "other sessions untouched");
});

test("Mac: old loop prompts stored as plain user messages are folded when drawn", async () => {
	const { actPrompt } = await import("../plugins/foryou/proactive.ts");
	const pi = fakePi();
	register(pi, { dir: tmp(), sessions: async () => [], cardPollMs: 60_000 });
	const md = `brook answered loop a with his own instruction. Do this instead of the suggested step:\nlatter\n\n(The loop, for context:)\n${actPrompt(loop("a", { title: "确认是否加入这两个" }), "/tmp/p")}`;
	assert.equal(pi.renderers.md(md, { messageType: "user" }), "↳ loop **确认是否加入这两个**, you: latter");
	assert.equal(pi.renderers.md("hello", { messageType: "user" }), "hello");
	assert.equal(pi.renderers.md(md, { messageType: "assistant" }), md);
});

test("Otty sidebar: the For you tab shows the hand icon while a card waits, and clears when none", async () => {
	const d = tmp(loop("a"));
	const pi = fakePi(), badges = [];
	register(pi, { dir: d, sessions: async () => [], answer: async () => "ok", cardPollMs: 60_000, badge: w => badges.push(w) });
	const ctx = macCtx("pix-foryou", []);
	await pi.handlers.agent_end[0]({}, ctx); await new Promise(r => setTimeout(r, 20));
	await pi.handlers.agent_end[0]({}, ctx); await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(badges, [true], "set once, not on every check");
	writeFileSync(join(d, "inbox.jsonl"), "");
	await pi.handlers.agent_end[0]({}, ctx); await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(badges, [true, false]);
	const { ottyBadge } = await import("../plugins/foryou/index.ts");
	const calls = []; ottyBadge(true, (c, a) => calls.push([c, ...a]), "1a2b"); ottyBadge(false, (c, a) => calls.push([c, ...a]), "p_1a2b");
	assert.deepEqual(calls, [["otty", "pane", "badge", "p_1a2b", "--kind", "awaiting-input"], ["otty", "pane", "badge", "p_1a2b", "--clear"]]);
});

test("transparent decision: every card button says what it would do, in plain words", () => {
	const d = tmp(loop("a", { choices: [{ label: "Fix in backtest", run: "s1", prompt: "Patch the loader and rerun" }, { label: "Talk", run: "discuss" }, { label: "Not now", run: "later" }, { label: "Skip", run: "no" }] }));
	const c = currentCard(d, live);
	assert.deepEqual(c.choices.map(x => x.task), ["Patch the loader and rerun", "For you talks it through with you first; changes nothing", "Hide it; back in 2 days", "Close the loop; nothing is done"]);
	assert.equal(c.task, "Switch loader");
});

test("Mac: with several cards waiting, ← / → flip between them in the picker", async () => {
	const d = tmp(loop("a"), { ...loop("b"), at: "2026-10-09T09:00:00Z" });
	const pi = fakePi(), shown = [];
	register(pi, { dir: d, sessions: async () => [], answer: async () => "ok", cardPollMs: 60_000 });
	let keys;
	const ctx = macCtx("pix-foryou", [], shown);
	const keyQueue = ["\x1b[C", "\x1b[C", "\x1b[D", null];
	ctx.ui.onTerminalInput = h => { keys = h; return () => { keys = undefined; }; };
	ctx.ui.select = async (title, options, o) => {
		shown.push({ title, options });
		const k = keyQueue.shift();
		if (!k) return undefined;
		assert.deepEqual(keys(k), { consume: true });
		assert.equal(o.signal.aborted, true);
		return undefined;
	};
	await cardCmd(pi, ctx);
	assert.deepEqual(shown.map(x => x.title.split("\n")[0]), ["Loop a", "Loop b", "Loop a", "Loop b"], "→ wraps around, ← goes back");
	assert.match(shown[0].title, /1 of 2 {3}← → more cards/);
	assert.equal(keys, undefined, "key listener removed when the picker closes");
});

for (const n of [2, 3]) test(`Mac regression: one ← / → press flips one card, even when the terminal also sends the key release (${n} cards)`, async () => {
	const cards = ["a", "b", "c"].slice(0, n).map((id, k) => ({ ...loop(id), at: `2026-10-09T0${9 - k}:00:00Z` }));
	const d = tmp(...cards);
	const pi = fakePi(), shown = [];
	register(pi, { dir: d, sessions: async () => [], answer: async () => "ok", cardPollMs: 60_000, badge: () => {} });
	const ctx = macCtx("pix-foryou", [], shown);
	let keys;
	ctx.ui.onTerminalInput = h => { keys = h; return () => { if (keys === h) keys = undefined; }; };
	// Each press sends press + release (kitty): the release reaches whatever picker is open next.
	const presses = [["\x1b[1;1:1C", "\x1b[1;1:3C"], ["\x1b[1;1:1C", "\x1b[1;1:3C"], ["\x1b[1;1:1D", "\x1b[1;1:3D"]];
	let pendingRelease;
	ctx.ui.select = async (title) => {
		shown.push(title.split("\n")[0]);
		if (pendingRelease) { assert.deepEqual(keys(pendingRelease), { consume: true }); pendingRelease = undefined; }
		const p = presses.shift();
		if (!p) return undefined;
		keys(p[0]); keys(p[0]); // a stray duplicate in the same picker is ignored too
		pendingRelease = p[1];
		return undefined;
	};
	await cardCmd(pi, ctx);
	const want = n === 2 ? ["Loop b", "Loop a", "Loop b", "Loop a"] : ["Loop c", "Loop b", "Loop a", "Loop b"]; // oldest first
	assert.deepEqual(shown, want);
});

test("Mac regression: the 4s card refresh does not close a picker showing card 2; it closes only when that card is answered elsewhere; every step is logged", async () => {
	const d = tmp(loop("a"), { ...loop("b"), at: "2026-10-09T09:00:00Z" });
	const pi = fakePi(), shown = [];
	register(pi, { dir: d, sessions: async () => [], answer: async () => "ok", cardPollMs: 60_000, badge: () => {} });
	const ctx = macCtx("pix-foryou", [], shown);
	let keys, aborted = [];
	ctx.ui.onTerminalInput = h => { keys = h; return () => {}; };
	let release;
	ctx.ui.select = (title, options, o) => new Promise(res => {
		shown.push(title.split("\n")[0]);
		o.signal.addEventListener("abort", () => { aborted.push(title.split("\n")[0]); res(undefined); });
		if (shown.length === 1) keys("\x1b[C"); else release = res;
	});
	const run = cardCmd(pi, ctx);
	await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(shown, ["Loop a", "Loop b"]);
	await pi.handlers.agent_end[0]({}, ctx); await new Promise(r => setTimeout(r, 20)); // the periodic refresh
	assert.deepEqual(aborted, ["Loop a"], "card 2 stays open through a refresh");
	writeFileSync(join(d, "inbox.jsonl"), JSON.stringify(loop("a")) + "\n"); // b answered on the phone
	await pi.handlers.agent_end[0]({}, ctx); await new Promise(r => setTimeout(r, 20));
	assert.deepEqual(aborted, ["Loop a", "Loop b"], "closes once its card is gone");
	await run;
	const log = readFileSync(join(d, "card-ui.log"), "utf8").trim().split("\n").map(l => JSON.parse(l).event);
	for (const e of ["picker open", "key →", "picker closed: card answered or gone"]) assert.ok(log.includes(e), `${e} logged: ${log}`);
});

test("nested pick: an action can run here, in a new session, or in any session brook picks, not only the judge's", () => {
	const d = tmp(loop("a", { project: "/w/nd", choices: [{ label: "Fix", run: "s1", prompt: "Patch it" }, { label: "Talk", run: "discuss" }] }));
	const r = answerCard("a", "choice", { choice: 0, to: "here", dir: d, live });
	assert.ok(r.here && !r.into, "runs in For you");
	assert.match(r.here, /Patch it/);
	const d2 = tmp(loop("a", { project: "/w/nd", choices: [{ label: "Fix", run: "s1", prompt: "Patch it" }] }));
	assert.equal(answerCard("a", "choice", { choice: 0, to: "new", dir: d2, live }).into, "new");
	const d3 = tmp(loop("a", { choices: [{ label: "Talk", run: "discuss" }] }));
	assert.ok(answerCard("a", "choice", { choice: 0, to: "s2", dir: d3, live }).here, "discuss ignores a where");
});

test("regression: the judge is told to close a loop brook already answered himself, and not to re-alert a repeat ask", async () => {
	const { judgePrompt } = await import("../plugins/foryou/proactive.ts");
	const p = judgePrompt({ me: "唐英豪", memory: "", source: { kind: "feishu", id: "x", name: "G" }, context: [], fresh: [{ id: "1", time: "t", sender: "欧阳宗谦", text: "再问一次：44个类别？" }], pending: [], feedback: [loop("d", { status: "done", title: "整理44个事件类别", note: "- 2026-10-15: Finished: replied with the list" })], now: "n" });
	assert.match(p, /\(me\) that answers or delivers what a loop asks[\s\S]*close it/);
	assert.match(p, /same ask again[\s\S]*recently done\/resolved/);
	assert.match(p, /acted on: 整理44个事件类别 \(2026-10-15: Finished: replied with the list\)/, "the judge sees what was done, so it recognises the repeat");
});

test("lines of work: the judge reads the map, files loops under lines, and moves a line's state without a card", async () => {
	const { judgePrompt, parseVerdict } = await import("../plugins/foryou/proactive.ts");
	const { applyLineEdits, linesForPrompt } = await import("../plugins/foryou/proactive-lines.ts");
	const lines = [{ id: "train", name: "Jev training", state: "Round 1 done", updated: "x" }];
	const map = linesForPrompt(lines, [loop("a", { line: "train" })]);
	assert.match(map, /line=train "Jev training" kind=research: Round 1 done; open loops: a/);
	const p = judgePrompt({ lines: map, me: "b", memory: "", source: { kind: "feishu", id: "x", name: "G" }, context: [], fresh: [{ id: "1", time: "t", sender: "k", text: "hi" }], pending: [], now: "n" });
	assert.match(p, /lines of work \(the map: read this first\)\n- line=train/);
	const v = parseVerdict(JSON.stringify({ alerts: [{ title: "Run bench", why: "w", action: "a", line: "bench", for: "me", evidence: "e" }], update: [{ id: "a", line: "train" }], close: [], lines: [{ id: "train", state: "Backtest +3%" }, { id: "Bench", name: "Benchmark", state: "started" }, { id: "nameless", state: "x" }] }));
	assert.equal(v.alerts[0].line, "bench"); assert.equal(v.update[0].line, "train");
	const r = applyLineEdits(lines, v.lines, "now");
	assert.deepEqual(r.lines.map(l => [l.id, l.state]), [["train", "Backtest +3%"], ["bench", "started"]], "progress moves the line; a new line needs a name");
	assert.equal(applyLineEdits(r.lines, [{ id: "bench", retire: true }]).lines[1].hidden, true);
});

test("proactive: a new loop is prepared under the hood (read-only) and the result shows on its card", async () => {
	const { preparePrompt } = await import("../plugins/foryou/proactive.ts");
	const { preparedItem } = await import("../plugins/foryou/proactive-store.ts");
	const p = preparePrompt(loop("n", { title: "Send 44 categories", howToRead: "lark-cli x" }));
	assert.match(p, /read-only[\s\S]*Do not send, submit/);
	assert.match(p, /action "prepared", id n/);
	const d = tmp(loop("n"));
	assert.equal(preparedItem("n", "  ", d), false);
	assert.ok(preparedItem("n", "Draft: 44 categories, top 10 below…", d));
	assert.equal(currentCard(d).prepared, "Draft: 44 categories, top 10 below…");
});

test("regression: WeChat reads even while the Mac is locked, and a failed read restarts the stuck wx daemon", async () => {
	const src = await import("../plugins/foryou/proactive-sources.ts");
	assert.equal(src.Paused, undefined, "no lock pause: with Full Disk Access a locked Mac reads fine");
	const calls = [];
	const sleep = async () => {};
	await assert.rejects(src.wechatRead(["msg", "x"], { sleep, exec: async (c, a) => { calls.push([c, ...a]); if (c === "wechat-cli") throw Object.assign(new Error("Command failed: wechat-cli msg x"), { stderr: "Traceback...\nKeyError: 'data'\n" }); return { stdout: "" }; } }), /Command failed: wechat-cli msg x: KeyError: 'data'/, "the real cause is kept");
	assert.deepEqual(calls.map(c => c.slice(0, 3).join(" ")), ["wechat-cli msg x", "wechat-cli msg x", "wechat-cli msg x", "wx daemon stop", "wechat-cli msg x"], "retry twice, then restart the daemon and try once more");
	let n = 0;
	assert.deepEqual(await src.wechatRead(["a"], { sleep, exec: async () => { if (n++ === 0) throw new Error("flake"); return { stdout: '{"ok":1}' }; } }), { ok: 1 }, "a one-off flake is retried away");
	assert.deepEqual(await src.wechatRead(["a"], { exec: async () => ({ stdout: '{"code":0}' }) }), { code: 0 });
});

test("For you knows the whole picture: open jobs with due/back dates and prep, and it recommends what's next", async () => {
	const { coordinatorContext } = await import("../plugins/foryou/proactive-store.ts");
	const d = tmp(loop("a", { title: "Submit interview times", due: "2026-10-16", prepared: "Form link: x" }), loop("b", { title: "Benchmark run", status: "later", wakeAt: "2099-01-02T00:00:00Z" }));
	const c = coordinatorContext(d, []);
	assert.match(c, /id=a \[needs brook, due 2026-10-16\] Submit interview times[\s\S]*prepared: Form link: x/);
	assert.match(c, /id=b \[later, back 2099-01-02\] Benchmark run/);
	assert.match(c, /"what's next"[\s\S]*Recommend the ONE thing to do now and why/);
	assert.match(c, /Next: <the next job> — do it\?/);
});

test("Mac: ⌘⇧Y with no card waiting lists everything unfinished; picking one talks it through in For you", async () => {
	const d = tmp(loop("p", { status: "onit", session: "s1" }), loop("q", { status: "later", wakeAt: "2099-01-01T09:00:00Z" }));
	const pi = fakePi(), shown = [];
	register(pi, { dir: d, sessions: async () => live, cardPollMs: 60_000 });
	await cardCmd(pi, macCtx("pix-foryou", [opts => opts[1]], shown));
	assert.equal(shown[0].title, "Unfinished, 2");
	assert.match(shown[0].options[0], /^on it +Loop p$/);
	assert.match(shown[0].options[1], /^later +Loop q, back /);
	assert.match(pi.sent[0], /^Let's look at loop q: Loop q, back .*\. Where does it stand\?$/);
	// Nothing open: a short note, no list.
	const pi2 = fakePi(), notes = [];
	register(pi2, { dir: tmp(), sessions: async () => live, cardPollMs: 60_000 });
	await cardCmd(pi2, macCtx("pix-foryou", [], notes));
	assert.deepEqual(notes, ["Nothing unfinished."]);
});

test("session names on cards: three sessions in one folder show their unique board names plus a short 'doing' hint; a card that names a session gets no generic 'Do it in' rows", async () => {
	const { sessionLabeler } = await import("../plugins/core/session-label.ts");
	const { sendLabel } = await import("../plugins/foryou/index.ts");
	const board = [["m1", "minara"], ["m2", "minara-2"], ["m3", "minara-3"]].map(([session, name]) => ({ name, session, cwd: "/w/minara", pid: 1, at: 0 }));
	const label = sessionLabeler(board, { m2: { line: "Three y2 GPU jobs are running; Kairos waits on Enhao" } });
	const ses = ["m1", "m2", "m3"].map(id => ({ id, name: "minara", cwd: "/w/minara" }));
	const it = { ...loop("a"), project: "/w/minara" };
	const t = sendTargets(it, ses, "/h", label);
	assert.deepEqual(t.filter(s => s.id !== "new").map(sendLabel), ["Do it in minara ›", "Do it in minara-2, Three y2 GPU jobs are running… ›", "Do it in minara-3 ›"]);
	assert.equal(new Set(t.map(sendLabel)).size, t.length, "no two rows read the same");
	assert.equal(cardChoices({ ...it, choices: [{ label: "Fix", run: "m3" }] }, ses, label)[0].name, "minara-3");
	// Mac picker: the card's own choice already names a session, so no generic rows are added.
	const d = tmp({ ...loop("a"), project: "/w/minara", choices: [{ label: "Fix", run: "m3", prompt: "Fix it" }, { label: "Talk", run: "discuss" }] });
	const pi = fakePi(), shown = [];
	register(pi, { dir: d, sessions: async () => ses, answer: async () => "ok", cardPollMs: 60_000, badge: () => {} });
	await cardCmd(pi, macCtx("pix-foryou", [], shown));
	assert.equal(shown[0].options.filter(o => /^Do it in/.test(o)).length, 0, shown[0].options.join(" | "));
});

test("a line with nothing concrete is not a post: forYouView gives each line its open loops", async () => {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { forYouView } = await import("../plugins/foryou/proactive-store.ts");
	const dir = mkdtempSync(join(tmpdir(), "fy-lines-"));
	writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "phd", name: "PhD / ZJU", state: "Ongoing", updated: "x" }, { id: "b", name: "Bench", project: "~/w/nd", state: "s", updated: "x" }]));
	writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ id: "q1", at: new Date().toISOString(), title: "Check the result", why: "w", line: "phd", source: "DingTalk", status: "pending" }) + "\n");
	const v = forYouView(dir);
	const phd = v.lines.find(l => l.id === "phd"), b = v.lines.find(l => l.id === "b");
	assert.deepEqual(phd.loops.map(l => [l.title, l.you]), [["Check the result", true]], "the line knows what it waits on");
	assert.equal(b.project, "~/w/nd", "project kept so the phone can jump to its session");
	assert.deepEqual(b.loops, []);
});

test("silence watch: a source kind with no good read for 6+ h shows as a problem", async () => {
	const { silentSources, sourceKind } = await import("../plugins/foryou/proactive.ts");
	assert.deepEqual(["WeChat: 盟军四人帮", "Feishu", "Feishu meetings", "Gmail", "DingTalk: x", "model"].map(sourceKind), ["WeChat", "Feishu", "Feishu meetings", "Gmail", "DingTalk", ""]);
	const now = Date.parse("2026-10-22T12:00:00Z");
	const p = silentSources({ WeChat: "2026-10-22T11:50:00Z", Gmail: "2026-10-22T02:00:00Z" }, ["WeChat", "Gmail", "Feishu"], now);
	assert.deepEqual(p, [{ text: "Gmail: no good read for 10 h", since: "2026-10-22T02:00:00Z" }]);
});

test("regression: Gmail IMAP retries through the proxy, then direct; mail that names no one but is a reviewer/advisor/school duty always passes", async () => {
	const { gmailImapRetry } = await import("../plugins/foryou/proactive-sources.ts");
	const { mustPass } = await import("../plugins/foryou/forward.ts");
	const seen = [];
	assert.equal(await gmailImapRetry(async o => { seen.push(o.proxy ?? "direct"); if (seen.length < 3) throw new Error("Client network socket disconnected"); return "ok"; }, "http://p:1", async () => {}), "ok");
	assert.deepEqual(seen, ["http://p:1", "http://p:1", "direct"]);
	await assert.rejects(gmailImapRetry(async () => { throw new Error("imap timeout"); }, "http://p:1", async () => {}), /imap timeout/);
	const m = (sender, subject) => ({ id: "1", time: "", sender, text: `Subject: ${subject}\nbody` });
	assert.ok(mustPass(m("PacificVis 2027 Papers (Journal Track)", "[submission 3549] new discussion comment")));
	assert.ok(mustPass(m("chenvis", "Fw: 转发: 【重要】2027年度省自然科学基金“新苗项目”附件-10.23前反馈")));
	assert.ok(mustPass(m("Microsoft CMT", "WISE26 : Invitation to chair sessions")));
	assert.ok(mustPass(m("徐洁婷", "@10 没打勾的是还没交学年小结的 ddl为周三晚上八点前。")), "a class deadline ask passes");
	assert.ok(!mustPass(m("NLP Newsletter", "Top AI Papers of the Week")));
	assert.ok(!mustPass(m("X", "Your receipt from X")));
	assert.ok(mustPass(m("Someone", "hello"), ["^Someone$"]), "config passList adds patterns");
});

test("regression: DingTalk is started when closed (its local DB only updates while it runs), and the snapshot's newest time is kept", async () => {
	const src = await import("../plugins/foryou/proactive-sources.ts");
	const calls = [];
	assert.equal(await src.ensureDingTalk(async (c, a) => { calls.push([c, ...a].join(" ")); if (c === "pgrep") throw new Error("no"); return { stdout: "" }; }), true);
	assert.deepEqual(calls, ["pgrep -x DingTalk", "open -ga DingTalk"]);
	assert.equal(await src.ensureDingTalk(async () => ({ stdout: "123" })), false, "running: left alone");
	assert.equal(src.newestTime([{ messages: [{ time: "2026-10-19T02:00:00Z" }] }, { messages: [{ time: "2026-10-21T02:00:00Z" }, { time: "x" }] }]), "2026-10-21T02:00:00Z");
	const { all } = src.dingAdapters(() => [{ id: "c", name: "博2班", me: "m", messages: [{ id: "1", time: "2026-10-19T02:00:00Z", sender: "a", text: "x" }] }], async () => false);
	await all.expand({ kind: "dingtalk-all", id: "", name: "DingTalk" });
	assert.equal(src.dingNewest.at, "2026-10-19T02:00:00Z");
});

test("Mac: live asks show as a quiet widget in the For you session; /live <n> reply|later acts like the phone", async () => {
	const { addLive, readLive } = await import("../plugins/foryou/live-strip.ts");
	const d = tmp();
	addLive(d, { source: "WeChat: Knight", sourceKey: "wechat:k", why: "Knight asks for the CSV" });
	addLive(d, { source: "Feishu: G", sourceKey: "feishu:g", why: "@brook review" });
	const pi = fakePi(), widgets = [], notes = [];
	register(pi, { dir: d, sessions: async () => [], cardPollMs: 60_000 });
	const fy = macCtx("pix-foryou", [], notes, widgets);
	pi.handlers.agent_end[0]({}, fy);
	await new Promise(r => setTimeout(r, 20));
	const w = widgets.find(x => x[0] === "foryou-live");
	assert.deepEqual(w[1], ["For you 2", "1 G             @brook review   Feishu", "2 Knight        Knight asks for the CSV   WeChat"], "newest first, no blank lines");
	await pi.commands["/live"].handler("2 reply", fy);
	assert.match(pi.sent.at(-1), /Reply now\].*Knight asks for the CSV/);
	await pi.commands["/live"].handler("1 later", fy);
	assert.equal(pi.sent.length, 1, "later does not wake For you");
	assert.deepEqual(readLive(d), []);
	assert.equal(widgets.at(-1)[0], "foryou-live"); assert.equal(widgets.at(-1)[1], undefined, "strip gone");
});

async function liveKeyboard(t, dir, draft = "") {
 const pi = fakePi(), widgets = [], notes = [];
 register(pi, { dir, sessions: async () => [], cardPollMs: 60_000 });
 const ctx = macCtx("pix-foryou", [], notes, widgets); ctx.mode = "tui";
 let input, removed = 0;
 ctx.ui.getEditorText = () => draft;
 ctx.ui.onTerminalInput = fn => { input = fn; return () => { removed++; input = undefined; }; };
 for (const start of pi.handlers.session_start) await start({}, ctx);
 await new Promise(resolve => setTimeout(resolve, 10));
 t.after(() => pi.handlers.session_shutdown.forEach(fn => fn({}, ctx)));
 return { pi, ctx, widgets, notes, key: data => input?.(data), installed: () => typeof input === "function", removed: () => removed };
}

test("Mac ↓ on an empty input focuses the list without a dialog; arrows/Enter match phone Reply now", async t => {
 const { addLive, readLive } = await import("../plugins/foryou/live-strip.ts");
 const d = tmp();addLive(d,{source:"WeChat: A",sourceKey:"wechat:a",why:"First ask"});addLive(d,{source:"WeChat: B",sourceKey:"wechat:b",why:"Second ask"});
 const f=await liveKeyboard(t,d);
 assert.equal(f.installed(),true);
 assert.deepEqual(f.key("\x1b[B"),{consume:true});f.key("\x1b[B");f.key("\r");
 assert.match(f.pi.sent[0],/Reply now\].*First ask/, "newest first, ↓ moves to the older one");
 assert.equal(readLive(d).length,1);assert.equal(f.notes.length,0,"no modal or redesign");
 assert.equal(f.key("s"),undefined,"typing resumes outside focus");
});

test("Mac list focus never changes height: same line count, every line fits 72 columns, no blank lines, full text in place on the selected row", async t => {
 const { addLive } = await import("../plugins/foryou/live-strip.ts");
 const { visibleWidth } = await import("@earendil-works/pi-tui");
 const d=tmp(loop("c"));addLive(d,{source:"WeChat: A",sourceKey:"wechat:a",why:"First ask with a much longer full sentence that only shows when selected, never in the row"});addLive(d,{source:"WeChat: B",sourceKey:"wechat:b",why:"Do the thing",verb:"do"});
 const f=await liveKeyboard(t,d);
 const live=()=>f.widgets.filter(([k])=>k==="foryou-live").at(-1)[1];
 const before=live();f.key("\x1b[B");const focused=live();f.key("\x1b[B");const moved=live();f.key("\x1b");const after=live();
 assert.equal(before[0],"For you 3");assert.equal(before.length,4);
 for (const v of [before,focused,moved,after]) { assert.equal(v.length,before.length); for (const l of v) { assert.ok(visibleWidth(l)<=72,l); assert.ok(l.trim(),"no blank lines"); } }
 assert.match(focused[0],/^For you 3   ↑↓/);assert.match(focused[1],/^1›/);assert.match(moved[2],/^2›First ask with a much longer/);
 assert.doesNotMatch(before.join("\n"),/only shows/,"full text only when selected");
 assert.deepEqual(after,before);assert.doesNotMatch(before.join("\n"),/·|Tab/);
});

test("Mac shortcut focuses live asks with a draft; s/l preserve the draft and phone semantics", async t => {
 const { addLive, readLive } = await import("../plugins/foryou/live-strip.ts");
 const d=tmp();addLive(d,{source:"A",sourceKey:"wechat:a",why:"Later this"});addLive(d,{source:"B",sourceKey:"wechat:b",why:"Show this"});
 const f=await liveKeyboard(t,d,"unfinished draft");
 assert.equal(f.key("\x1b[B"),undefined,"normal draft completion remains available");
 await cardCmd(f.pi,f.ctx);f.key("s");assert.match(f.pi.sent[0],/tapped Show\].*Show this/);
 await cardCmd(f.pi,f.ctx);f.key("l");assert.equal(f.pi.sent.length,1);assert.deepEqual(readLive(d),[]);
 assert.equal(f.ctx.ui.getEditorText(),"unfinished draft");
});

test("Mac stale strip selection never replies to another row; shutdown releases the terminal hook", async t => {
 const { addLive, takeLive } = await import("../plugins/foryou/live-strip.ts");
 const d=tmp();addLive(d,{source:"B",sourceKey:"wechat:b",why:"Still waiting"});const first=addLive(d,{source:"A",sourceKey:"wechat:a",why:"Already handled"});
 const f=await liveKeyboard(t,d);f.key("\x1b[B");takeLive(first.id,d);f.key("\r");
 assert.deepEqual(f.pi.sent,[]);
 f.pi.handlers.session_shutdown.forEach(fn=>fn({},f.ctx));assert.equal(f.removed(),1);
});

test("Mac cards and live asks are one list: Enter on a card row opens its picker, l puts it off through the hub", async t => {
 const {addLive}=await import("../plugins/foryou/live-strip.ts");
 const d=tmp(loop("a"));addLive(d,{source:"A",sourceKey:"wechat:a",why:"Waiting too"});
 const f=await liveKeyboard(t,d);
 assert.equal(f.widgets.find(([key])=>key==="foryou-card")?.[1],undefined,"no second card widget");
 const list=f.widgets.filter(([k])=>k==="foryou-live").at(-1)[1];assert.equal(list.length,3);assert.ok(list.some(l=>/Loop a/.test(l)));
 const row=list.findIndex(l=>/Loop a/.test(l));
 f.key("\x1b[B");f.key(String(row));f.key("\r");await new Promise(r=>setTimeout(r,10));
 assert.match(f.notes.find(n=>n.title)?.title,/Loop a/);
 assert.equal(f.key("\x1b[121;10u"),undefined,"⌘⇧Y still reaches Pi's dispatcher");
 assert.deepEqual(f.pi.sent,[]);
});

test("Mac live reply while busy queues a follow-up, never steering or sending externally", async t => {
 const {addLive}=await import("../plugins/foryou/live-strip.ts");const d=tmp();addLive(d,{source:"A",sourceKey:"wechat:a",why:"Waiting"});
 const f=await liveKeyboard(t,d);f.ctx.isIdle=()=>false;f.key("\x1b[B");f.key("\r");
 assert.deepEqual(f.pi.deliveries,[{deliverAs:"followUp"}]);
});

test("switching to RPC or another session removes terminal input ownership", async t => {
 const d=tmp(),f=await liveKeyboard(t,d);
 for(const start of f.pi.handlers.session_start) await start({}, {...f.ctx,mode:"rpc"});
 assert.equal(f.installed(),false);assert.equal(f.removed(),1);
 for(const start of f.pi.handlers.session_start) await start({}, {...f.ctx,sessionManager:{getSessionId:()=>"other"}});
 assert.equal(f.installed(),false);
});

test("Mac For you list shows at most 3 rows, the last ending in ' ...' (no extra line); focus keeps the height; ctrl+\\ folds to the header and the fold survives a reload", async t => {
 const { addLive } = await import("../plugins/foryou/live-strip.ts");
 const { visibleWidth } = await import("@earendil-works/pi-tui");
 const d=tmp(loop("c"));for (const k of "abcdef") addLive(d,{source:`WeChat: ${k}`,sourceKey:`wechat:${k}`,why:`Ask ${k}`});
 const f=await liveKeyboard(t,d);
 const live=()=>f.widgets.filter(([k])=>k==="foryou-live").at(-1)[1];
 const v=live();assert.equal(v.length,4);assert.equal(v[0],"For you 7");assert.match(v[3],/ \.\.\.$/);assert.doesNotMatch(v.join("\n"),/more|truncated/);
 for (const l of v) assert.ok(visibleWidth(l)<=72);
 for (let i=0;i<5;i++) f.key("\x1b[B");const deep=live();assert.equal(deep.length,4);assert.match(deep.slice(1).join("\n"),/^5›/m,"window follows the selection");f.key("\x1b");
 assert.deepEqual(f.key("\x1c"),{consume:true});assert.deepEqual(live(),["For you 7"]);
 const g=await liveKeyboard(t,d);assert.deepEqual(g.widgets.filter(([k])=>k==="foryou-live").at(-1)[1],["For you 7"],"fold remembered");
 g.key("\x1c");assert.equal(g.widgets.filter(([k])=>k==="foryou-live").at(-1)[1].length,4);
});

test("For you list with 1 row is just header and row, no blank lines", async () => {
 const { forYouLines } = await import("../plugins/foryou/for-you-list.ts");
 const v=forYouLines([{id:"x",kind:"ask",who:"A",gist:"g",full:"g",source:"WeChat",at:0,urgent:false}]);
 assert.equal(v.length,2);assert.ok(v.every(l=>l.trim()));
});
