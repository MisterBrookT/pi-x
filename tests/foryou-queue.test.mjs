import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACTIVE_MS, brookActiveAt, clearQueue, heldPrompt, holdBatch, isBrookText, markBrookActive, queuedCount, readQueue, threadActive, urgentLine } from "../plugins/core/foryou-queue.ts";
import { parseFilter } from "../plugins/foryou/forward.ts";

const now = Date.parse("2026-10-19T12:00:00Z");

test("a thread is active for 10 min after brook writes, longer only while For you is busy or waiting for him", () => {
	assert.equal(threadActive({ userAt: 0, busy: true, now }), false, "never talked: nothing to protect");
	assert.equal(threadActive({ userAt: now - 5 * 60_000, now }), true);
	assert.equal(threadActive({ userAt: now - ACTIVE_MS - 1, now }), false, "quiet after 10 min");
	assert.equal(threadActive({ userAt: now - 30 * 60_000, busy: true, now }), true, "still doing his task");
	assert.equal(threadActive({ userAt: now - 30 * 60_000, openWaits: 1, now }), true, "a handoff it started is still open");
	assert.equal(threadActive({ userAt: now - 2 * 3600_000, busy: true, now }), false, "busy hours later is not his thread");
});

test("daemon turns and session chat do not count as brook talking", () => {
	assert.equal(isBrookText("what is reimbursement going on?"), true);
	assert.equal(isBrookText("[For you: new messages, 2026-10-19 10:24] ▸ …"), false);
	assert.equal(isBrookText("[For you: hourly review, …]"), false);
	assert.equal(isBrookText("[chat handoff from session \"pix\"] …"), false);
});

test("held batches queue up, show as a count, and go over as one message", () => {
	const dir = mkdtempSync(join(tmpdir(), "fyq-"));
	markBrookActive(dir, now);
	assert.equal(brookActiveAt(dir), now);
	assert.equal(queuedCount(dir), 0);
	holdBatch("[For you: new messages, A] batch A", dir, new Date(now));
	holdBatch("[For you: new messages, B] batch B", dir, new Date(now + 60_000));
	assert.equal(queuedCount(dir), 2);
	const p = heldPrompt(readQueue(dir));
	assert.match(p, /^\[For you: held while you were in a thread with brook — 2 batches since 2026-10-19 12:00\]/);
	assert.match(p, /batch A[\s\S]*batch B/);
	clearQueue(dir);
	assert.equal(queuedCount(dir), 0);
});

test("only urgent passes interrupt, as one line; the filter must say so explicitly", () => {
	assert.equal(parseFilter('{"pass":true,"why":"due today","ids":[],"urgent":true}').urgent, true);
	assert.equal(parseFilter('{"pass":true,"why":"fyi","ids":[]}').urgent, undefined);
	assert.equal(parseFilter('{"pass":false,"why":"x","ids":[],"urgent":true}').urgent, undefined, "a drop is never urgent");
	const line = urgentLine("WeChat 浙大 李老师", "李老师 needs the receipt\nbefore 5pm today");
	assert.equal(line.split("\n").length, 1);
	assert.match(line, /^\[For you: urgent, WeChat 浙大 李老师\] 李老师 needs the receipt before 5pm today/);
});
