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
import register, { CARD_ELSE, CARD_NO, choiceLabel } from "../extensions/foryou.ts";

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
	const commands = {}, renderers = {}, custom = [];
	return { handlers, sent, commands, renderers, custom, registerTool() {}, registerShortcut: (k, c) => { commands[k] = c; }, registerMessageRenderer: (t, r) => { renderers[t] = r; }, registerMarkdownTransformer: f => { renderers.md = f; }, sendMessage: (m, o) => custom.push([m, o]), getActiveTools: () => [], setActiveTools() {}, on: (e, h) => { (handlers[e] ??= []).push(h); }, sendUserMessage: m => sent.push(m) };
}
const macCtx = (id, picks, notes = [], widgets = []) => ({ hasUI: true, cwd: "/nd", isIdle: () => true, sessionManager: { getSessionId: () => id },
	ui: { select: async (title, options) => (notes.push({ title, options }), (p => typeof p === "function" ? p(options) : p)(picks.shift())), input: async () => picks.shift(), notify: m => notes.push(m), setWidget: (k, v) => widgets.push([k, v]) } });
/** brook answers the card on the Mac: /card opens the picker (it never pops up by itself). */
const cardCmd = (pi, ctx) => pi.commands["super+shift+y"].handler(ctx);



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
	const shown = [], widgets = [];
	await pi.handlers.agent_end[0]({}, macCtx("s1", ["x"], shown, widgets));
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown.length + widgets.length, 0, "work sessions are never interrupted");
	const fix = choiceLabel({ label: "Fix in backtest", run: "s1", name: "backtest" });
	const fy = macCtx("pix-foryou", [fix], shown, widgets);
	pi.handlers.agent_end[0]({}, fy);
	await new Promise(r => setTimeout(r, 20));
	assert.equal(shown.length, 0, "the card never pops up by itself: For you keeps working");
	assert.equal(widgets[0][0], "foryou-card");
	assert.deepEqual(widgets[0][1], ["● Loop a   ⌘⇧Y"], "one quiet line; details are behind the shortcut");
	await cardCmd(pi, fy);
	assert.deepEqual(shown[0].options, ["Fix in backtest (backtest) ›", "Discuss", CARD_ELSE, "Later", CARD_NO]);
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

test("Mac: one flat list. Open sessions are options in it (no second picker); the task shows once at the top", async () => {
	const d = tmp(loop("a", { project: "/w/nd" }));
	const pi = fakePi(), answers = [], shown = [];
	register(pi, { dir: d, sessions: async () => live, answer: async (id, body) => (answers.push([id, body]), "ok"), cardPollMs: 60_000 });
	await cardCmd(pi, macCtx("pix-foryou", ["Do it in backtest ›"], shown));
	assert.equal(shown.length, 1, "a single picker");
	assert.match(shown[0].title, /Plan: Switch loader/);
	assert.deepEqual(shown[0].options, ["Do it here", "Discuss", "Later", "Do it in backtest ›", CARD_ELSE, CARD_NO], "only the session that fits the loop, not every open one");
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

test("card free text on a loop a work session owns goes back to that session with the loop's context", () => {
	const d = tmp(loop("a", { status: "pending", session: "s1" }), loop("b"));
	const r = answerCard("a", "else", { text: "the latter", dir: d, live });
	assert.equal(r.into, "s1"); assert.equal(r.here, undefined);
	assert.equal(inbox(d).find(i => i.id === "a").action, "the latter", "his words become the next step the session is told");
	assert.match(answerCard("b", "else", { text: "draft only", dir: d }).here, /own instruction[\s\S]*draft only/, "no owner: For you does it");
});

test("coordinator prompt: prefer relevant sessions, publish choices instead of blocking, no unapproved risky work", async () => {
	const { coordinatorContext } = await import("../src/proactive-store.ts");
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
	const { actPrompt } = await import("../src/proactive.ts");
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
	assert.match(lines, /↳ loop 确认是否加入这两个  · you: Draft reply/); assert.doesNotMatch(lines, /proactive-daemon/);
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
	const { actPrompt } = await import("../src/proactive.ts");
	const pi = fakePi();
	register(pi, { dir: tmp(), sessions: async () => [], cardPollMs: 60_000 });
	const md = `brook answered loop a with his own instruction. Do this instead of the suggested step:\nlatter\n\n(The loop, for context:)\n${actPrompt(loop("a", { title: "确认是否加入这两个" }), "/tmp/p")}`;
	assert.equal(pi.renderers.md(md, { messageType: "user" }), "↳ loop **确认是否加入这两个** · you: latter");
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
	const { ottyBadge } = await import("../extensions/foryou.ts");
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
