// One line, several loops, each worked by its own session (e.g. Kairos launch: minara-1 owns the line,
// minara-2 independently works the docs loop). Routing, status and ownership must stay per loop.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInbox } from "../plugins/foryou/proactive.ts";
import { readLines } from "../plugins/foryou/proactive-lines.ts";
import { actItem, answerCard, forYouView, sessionLine, trackTurn, workOwner } from "../plugins/foryou/proactive-store.ts";

const loop = (id, extra = {}) => ({ id, at: "2026-10-27T08:00:00Z", title: `Loop ${id}`, why: "W", action: "A", refs: [], source: "s", sourceKey: "x:" + id, howToRead: "", status: "onit", line: "kairos", ...extra });
const setup = (...items) => {
	const d = mkdtempSync(join(tmpdir(), "pix-ll-"));
	writeFileSync(join(d, "inbox.jsonl"), items.map(i => JSON.stringify(i)).join("\n") + "\n");
	writeFileSync(join(d, "lines.json"), JSON.stringify([{ id: "kairos", name: "Kairos launch", state: "s", updated: "2026-10-27T08:00:00Z", owner: { id: "m1", name: "minara-1", status: "launch prep", at: "2026-10-27T08:00:00Z" } }]));
	return d;
};
const live = [{ id: "m1", name: "minara-1", cwd: "/w/minara" }, { id: "m2", name: "minara-2", cwd: "/w/minara" }];
const inbox = d => parseInbox(readFileSync(join(d, "inbox.jsonl"), "utf8"));

test("routing: the loop's own session first, the line owner as fallback, none when neither is live", () => {
	const d = setup();
	assert.deepEqual(workOwner(loop("docs", { session: "m2" }), live, d), { id: "m2", name: "minara-2", role: "loop" });
	assert.deepEqual(workOwner(loop("x", { session: undefined }), live, d), { id: "m1", name: "minara-1", role: "line" });
	assert.deepEqual(workOwner(loop("y", { session: "gone" }), live, d), { id: "m1", name: "minara-1", role: "line" }, "loop owner offline: line owner");
	assert.equal(workOwner(loop("z", { session: "gone" }), [], d), undefined, "nobody live: For you coordinates");
	assert.equal(workOwner(loop("w", { line: undefined, session: undefined }), live, d), undefined);
});

test("Do it on a loop goes to that loop's session, not the line owner", async () => {
	const d = setup(loop("docs", { status: "pending", session: "m2" }), loop("other", { status: "pending", session: undefined }));
	assert.equal(answerCard("docs", "do", { dir: d, live }).into, "m2");
	assert.equal(answerCard("other", "do", { dir: d, live }).into, "m1");
	const sent = [];
	await actItem("docs", { dir: d, live, send: (s, t) => (sent.push(s), true), chat: () => {}, boardName: () => undefined });
	assert.deepEqual(sent, ["m2"]);
	assert.equal(inbox(d).find(i => i.id === "docs").session, "m2");
});

test("a second session's turn updates only its loop; the line keeps its owner and the other loop is untouched", () => {
	const d = setup(loop("launch", { session: "m1" }), loop("docs", { session: "m2" }));
	assert.deepEqual(trackTurn({ id: "m2", name: "minara-2" }, "Docs pushed."), [], "no dir: nothing");
	assert.deepEqual(trackTurn({ id: "m2", name: "minara-2" }, "Docs pushed.", d), ["docs"]);
	const items = inbox(d);
	assert.match(items.find(i => i.id === "docs").note, /minara-2: Docs pushed\./);
	assert.equal(items.find(i => i.id === "launch").note ?? "", "");
	assert.equal(items.find(i => i.id === "launch").session, "m1");
	assert.equal(readLines(d)[0].owner.id, "m1", "line owner kept");
	trackTurn({ id: "m1", name: "minara-1" }, "Launch checklist done.", d);
	assert.equal(readLines(d)[0].owner.status, "Launch checklist done.");
	assert.equal(sessionLine("m2", d)?.id, "kairos", "a loop session still belongs to its line");
});

test("the line owner left (no open loop): the working session takes the line", () => {
	const d = setup(loop("docs", { session: "m2" }));
	trackTurn({ id: "m2", name: "minara-2" }, "Docs pushed.", d);
	assert.equal(readLines(d)[0].owner.id, "m2");
});

test("one grouped line card lists each loop with its own session and latest status", () => {
	const d = setup(loop("launch", { session: "m1" }), loop("docs", { session: "m2" }));
	trackTurn({ id: "m2", name: "minara-2" }, "Docs pushed.", d);
	const lines = forYouView(d).lines;
	assert.equal(lines.length, 1);
	const byId = Object.fromEntries(lines[0].loops.map(l => [l.id, l]));
	assert.equal(byId.docs.session, "m2"); assert.equal(byId.docs.last, "minara-2: Docs pushed."); assert.equal(byId.docs.status, "onit");
	assert.equal(byId.launch.session, "m1"); assert.equal(byId.launch.last, undefined);
	assert.deepEqual(lines[0].sessions, ["m1", "m2"], "every session on the line, owner first");
});

test("live ids like loop-546a09e3 route to that session even when its loop waits on brook", () => {
	const ids = [{ id: "loop-546a09e3", name: "minara-2", cwd: "/w/minara" }, { id: "loop-24187005", name: "minara-1", cwd: "/w/minara" }];
	const d = setup(loop("546a09e3", { status: "pending", session: "loop-546a09e3" }));
	assert.deepEqual(workOwner(inbox(d)[0], ids, d), { id: "loop-546a09e3", name: "minara-2", role: "loop" });
	assert.equal(answerCard("546a09e3", "do", { dir: d, live: ids }).into, "loop-546a09e3");
	assert.equal(sessionLine("loop-546a09e3", setup(loop("q", { status: "pending", session: "loop-546a09e3" })))?.id, "kairos");
});

test("For you's lines list shows a loop run by another session with that session, not the line owner", async t => {
	const { chromium } = await import("playwright");
	const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
	const tk = "l".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 });
	const browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await page.goto(`http://127.0.0.1:${hub.port}/#token=${tk}`);
	await page.waitForFunction(() => typeof linesParts === "function");
	const html = await page.evaluate(() => {
		sessions = [{ id: "m1", name: "minara-1" }, { id: "m2", name: "minara-2" }];
		forYou = { lines: [{ id: "kairos", name: "Kairos launch", open: 2, mode: "working", owner: { id: "m1", name: "minara-1", status: "launch prep", at: new Date().toISOString() },
			loops: [{ id: "launch", title: "Launch checklist", session: "m1", status: "onit" }, { id: "docs", title: "Polish docs", session: "m2", status: "onit", last: "minara-2: Docs pushed." }] }] };
		return linesParts(true).body;
	});
	assert.match(html, /data-loop-session="m2"><b>minara-2<\/b> · Polish docs<small>Docs pushed\.<\/small>/);
	assert.doesNotMatch(html, /data-loop-session="m1"/, "the owner's own loop is not repeated");
	assert.match(html, /minara-1/);
});

test("explicit members: a session on a line with no open loop and not the owner still belongs to it; owner and loops untouched", async () => {
	const { applyLineEdits, parseLineEdits, writeLines } = await import("../plugins/foryou/proactive-lines.ts");
	const d = setup(loop("done1", { status: "done", session: "run" }), loop("docs", { session: "m2" }));
	assert.equal(sessionLine("run", d), undefined, "before: no owner, no open loop → no line");
	const r = applyLineEdits(readLines(d), parseLineEdits([{ id: "kairos", join: ["run", "../bad"] }]));
	writeLines(r.lines, d);
	assert.deepEqual(readLines(d)[0].members, ["run"]);
	assert.equal(sessionLine("run", d)?.id, "kairos");
	assert.equal(readLines(d)[0].owner.id, "m1", "owner kept");
	assert.equal(inbox(d).find(i => i.id === "docs").session, "m2", "loops untouched");
	assert.deepEqual(forYouView(d).lines[0].sessions, ["m1", "run", "m2"]);
	writeLines(applyLineEdits(readLines(d), parseLineEdits([{ id: "kairos", leave: ["run"] }])).lines, d);
	assert.equal(readLines(d)[0].members, undefined);
	assert.equal(sessionLine("run", d), undefined);
});
