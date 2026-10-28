import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCloseHours, keepOpen, linesHeldBy, openLoopsHeldBy, recentAutoClosed, recordAutoClose } from "../plugins/core/auto-close.ts";

const H = 3_600_000, now = Date.parse("2026-10-28T12:00:00Z");
const idle = (o = {}) => ({ id: "s1", idleSince: now - 25 * H, now, hours: 24, busy: false, hubHost: false, draft: false, question: false, background: 0, helpers: 0, openLoops: 0, lines: 0, ...o });

test("a session idle past the limit with nothing in flight may close", () => assert.equal(keepOpen(idle()), undefined));

test("every guard keeps a session open", () => {
	for (const [o, why] of [[{ id: "pix-foryou" }, "For you"], [{ hubHost: true }, "hosts the hub"], [{ busy: true }, "working"], [{ draft: true }, "unsent draft"],
		[{ question: true }, "question open"], [{ background: 1 }, "background job running"], [{ helpers: 2 }, "helpers running"], [{ openLoops: 1 }, "holds an open loop"],
		[{ lines: 1 }, "on a line"], [{ idleSince: now - 23 * H }, "not idle long enough"], [{ hours: 0 }, "auto-close is off"]])
		assert.equal(keepOpen(idle(o)), why, JSON.stringify(o));
});

test("hours are configurable with PIX_AUTOCLOSE_HOURS; 0 turns it off, junk falls back to 24", () => {
	assert.equal(autoCloseHours({}), 24);
	assert.equal(autoCloseHours({ PIX_AUTOCLOSE_HOURS: "6" }), 6);
	assert.equal(autoCloseHours({ PIX_AUTOCLOSE_HOURS: "0" }), 0);
	assert.equal(autoCloseHours({ PIX_AUTOCLOSE_HOURS: "x" }), 24);
	assert.equal(keepOpen(idle({ hours: 6, idleSince: now - 7 * H })), undefined);
});

test("closes are logged with a one-line summary and For you sees the last day's", () => {
	const f = join(mkdtempSync(join(tmpdir(), "ac-")), "autoclosed.jsonl");
	recordAutoClose({ id: "old", name: "old", cwd: "/x", summary: "x", at: new Date(now - 30 * H).toISOString() }, f);
	recordAutoClose({ id: "s1", name: "docs", cwd: "/x", summary: "Done.\n\nAll   good", at: new Date(now - H).toISOString() }, f);
	const r = recentAutoClosed(f, now);
	assert.deepEqual(r.map(e => [e.name, e.summary]), [["docs", "Done. All good"]]);
});

test("For you's view and coordinator context carry the auto-closed note", async () => {
	const dir = mkdtempSync(join(tmpdir(), "acfy-"));
	process.env.PIX_PROACTIVE_DIR = dir;
	const { forYouView, coordinatorContext } = await import("../plugins/foryou/proactive-store.ts");
	writeFileSync(join(dir, "autoclosed.jsonl"), JSON.stringify({ id: "s9", name: "documents", cwd: "/d", summary: "Saved the PDF.", at: new Date().toISOString() }) + "\n");
	assert.deepEqual(forYouView(dir).autoClosed.map(e => e.name), ["documents"]);
	assert.match(coordinatorContext(dir), /closed 1 idle session"[\s\S]*documents \(s9\): Saved the PDF\./);
});

test("open loops and lines a session holds are read from For you's files (last inbox line per id wins)", () => {
	const dir = mkdtempSync(join(tmpdir(), "acl-"));
	writeFileSync(join(dir, "inbox.jsonl"), [{ id: "a", status: "pending", session: "s1" }, { id: "b", status: "pending", session: "s1" }, { id: "b", status: "done" }, { id: "c", status: "onit", session: "s2" }].map(e => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(join(dir, "lines.json"), JSON.stringify([{ id: "k", owner: { id: "s3" } }, { id: "p", members: ["s1"] }, { id: "old", hidden: true, members: ["s4"] }]));
	assert.deepEqual(["s1", "s2", "s3", "s4", "zz"].map(s => [openLoopsHeldBy(s, dir), linesHeldBy(s, dir)]), [[1, 1], [1, 0], [0, 1], [0, 0], [0, 0]]);
});
