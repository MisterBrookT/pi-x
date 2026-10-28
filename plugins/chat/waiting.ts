/**
 * Who this session waits on: asks and handoffs it sent that have no reply yet.
 * Shown as one quiet footer status ("Waiting for pix"); it does not mean anything is running.
 * Kept in ~/.pi/agent/chat/<me>/waiting.json so it survives /reload.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WAIT_MS = 2 * 60 * 60_000;   // after this, say "No reply from X"
export const NOTICE_MS = 10 * 60_000;      // how long "X left" / "No reply from X" stays

import { advance, CHECK_DEFAULT_MIN, CHECK_MAX_MS, checkDelay, clock, makeCheck, type Check } from "../core/check-schedule.ts";
export { CHECK_DEFAULT_MIN, CHECK_MAX_MS, checkDelay, type Check };
export type Wait = { thread: string; to: string; kind: string; at: number; live: boolean; what?: string; check?: Check;
	/** The receiver was seen busy after the send, and since when it is idle again (no reply yet). */
	busySeen?: boolean; idleSince?: number };
export const CHECK_GIVE_UP_MS = 6 * 60 * 60_000;
export const IDLE_GRACE_MS = 60_000;       // idle this long after working, with no reply -> wake now
/** The default schedule: handoffs exponential from 15 min, everything else off. */
export function checkFor(kind: string, mode?: string, minutes?: number, at = Date.now()): Check | undefined {
	const m = mode ?? (kind === "handoff" ? "exponential" : "off");
	return (kind === "ask" || kind === "handoff") ? makeCheck(m, minutes, at) : undefined;
}
export type Notice = { thread: string; text: string; at: number };
export type Waiting = { waits: Wait[]; notices: Notice[] };

export const waitingPath = (root: string, me: string) => join(root, me, "waiting.json");

export function loadWaiting(path: string): Waiting {
	try { const w = JSON.parse(readFileSync(path, "utf8")); return { waits: w.waits ?? [], notices: w.notices ?? [] }; } catch { return { waits: [], notices: [] }; }
}

export function saveWaiting(path: string, w: Waiting): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(w));
	renameSync(tmp, path);
}

/** A sent ask or handoff starts a wait (notes and replies expect nothing back). */
export function sentNote(w: Waiting, n: { thread: string; to: string; kind: string; at?: number; message?: string; label?: string; check?: Check }, live: boolean): Waiting {
	if (n.kind !== "ask" && n.kind !== "handoff") return w;
	return { waits: [...w.waits.filter(x => x.thread !== n.thread), { thread: n.thread, to: n.to, kind: n.kind, at: n.at ?? Date.now(), live, ...((n.message || n.label) ? { what: gist(n.message ?? "", n.label) } : {}), ...(n.check ? { check: n.check } : {}) }], notices: w.notices.filter(x => x.thread !== n.thread) };
}

export const SETTLE_MS = 30 * 60_000;  // a reply from X on any thread also closes my waits on X older than this
/** A message back on the thread ends the wait. A reply from the same peer on another thread also ends
 * that peer's waits older than 30 min: it answered, just not on the formal thread. */
export function receivedNote(w: Waiting, n: { thread: string; from?: string; kind?: string; at?: number }, now = n.at ?? Date.now()): Waiting {
	const settled = (x: Wait) => x.thread === n.thread || (!!n.from && n.kind === "reply" && x.to === n.from && now - x.at >= SETTLE_MS);
	const gone = new Set(w.waits.filter(settled).map(x => x.thread));
	return { waits: w.waits.filter(x => !gone.has(x.thread)), notices: w.notices.filter(x => !gone.has(x.thread) && x.thread !== n.thread) };
}

/** Close waits by hand: one thread, or every wait on a session (name), or "all". */
export function closeWaits(w: Waiting, which: string): { w: Waiting; closed: Wait[] } {
	const hit = (x: Wait) => which === "all" || x.thread === which || x.to === which;
	return { w: { waits: w.waits.filter(x => !hit(x)), notices: w.notices.filter(x => !w.waits.some(y => hit(y) && y.thread === x.thread)) }, closed: w.waits.filter(hit) };
}

/**
 * Periodic check: a peer that was running and is gone -> "X left"; too long -> "No reply from X".
 * A peer that was not running at send time is not "left"; its message waits for it (until the timeout).
 * Waits with a check schedule also return wake-ups for the sender: a due check, the receiver gone, or the
 * receiver back to idle after working without replying. `peers` maps live session name -> status (busy/idle).
 */
export function tick(w: Waiting, live: Set<string> | Map<string, string>, now = Date.now()): Waiting & { wakes: string[] } {
	const status = live instanceof Map ? live : new Map([...live].map(n => [n, ""]));
	const waits: Wait[] = [], notices = w.notices.filter(x => now - x.at < NOTICE_MS), wakes: string[] = [];
	for (const x of w.waits) {
		const on = status.has(x.to), st = status.get(x.to), mins = Math.round((now - x.at) / 60_000);
		const head = `Check on ${x.what || x.kind} (thread ${x.thread}, to ${x.to})`;
		if (x.live && !on) {
			notices.push({ thread: x.thread, text: `${x.to} left`, at: now });
			if (x.check) wakes.push(`${head}: ${x.to} left without replying (${mins} min after the ${x.kind}). Decide: resend, take it over, or tell brook.`);
			continue;
		}
		if (now - x.at >= (x.check ? CHECK_GIVE_UP_MS : WAIT_MS)) { notices.push({ thread: x.thread, text: `No reply from ${x.to}`, at: now }); continue; }
		const y: Wait = { ...x, live: x.live || on };
		if (x.check) {
			if (st === "busy") { y.busySeen = true; delete y.idleSince; }
			else if (st === "idle" && y.busySeen) {
				y.idleSince ??= now;
				if (now - y.idleSince >= IDLE_GRACE_MS) {
					wakes.push(`${head}: ${x.to} stopped working without replying (${mins} min after the ${x.kind}). Look at its status and last output on the board, then decide.`);
					y.busySeen = false; delete y.idleSince;
				}
			}
			if (now >= x.check.next) {
				const state = !on ? "not running" : st || "running";
				wakes.push(`${head}: no reply for ${mins} min. It is ${state}. Look at its status and what it is doing on the board, then decide: wait, nudge it, or take over.`);
				y.check = advance(x.check, now);
			}
		}
		waits.push(y);
	}
	return { waits, notices, wakes };
}

/**
 * A short task summary (≤40 chars): the sender's label if given, else the first real sentence with
 * boilerplate removed ("[chat handoff …]", "brook's request (…):", "Feedback from brook on …:", thread ids, "Please").
 */
export function gist(message: string, label?: string): string {
	const cut = (t: string) => t.length > 40 ? t.slice(0, 39).trimEnd() + "…" : t;
	if (label?.trim()) return cut(label.trim().replace(/\s+/g, " "));
	const boiler = /^(?:(?:brook'?s?|second|third|new|another|follow-?up|context|fyi|feedback|request)\b[^:]{0,80}?:|this task is now yours\.?)\s*/i;
	for (let line of message.split("\n")) {
		line = line.replace(/\[[^\]]*\]/g, " ").replace(/\([^()]*\b(?:thread|commit|[0-9a-f]{7,})\b[^()]*\)/gi, " ").replace(/\s+/g, " ").trim();
		for (let i = 0; i < 3 && boiler.test(line); i++) line = line.replace(boiler, "");
		// "Feedback from brook on the artifacts. He clicked …": the lead-in sentence about brook is boilerplate too.
		line = line.replace(/^(?:feedback|request|note)\b[^.]{0,80}\.\s+/i, "").replace(/^(?:\d+[.)]|[-•*])\s+/, "").replace(/^(please|pls|can you|could you)\s+/i, "");
		const sentence = line.split(/(?<=[.!?。！？])\s/)[0].replace(/[.:;,。]+$/, "").trim();
		if (sentence) return cut(sentence);
	}
	return "";
}

const ago = (ms: number) => ms < 60_000 ? "now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000) ? Math.floor(ms % 3_600_000 / 60_000) + "m" : ""}`;
/** The footer's own line: one entry per pending ask/handoff, "minara-3: restyle leaderboard · 12m". */
export function waitingLines(w: Waiting, now = Date.now()): string | undefined {
	const parts = w.waits.map(x => `${x.to}${x.what ? `: ${x.what}` : ""}, ${x.check ? `check ${clock(x.check.next)}` : ago(now - x.at)}`);
	return parts.length ? parts.join("   ") : undefined;
}

/** The short status beside remote/memory: only notices ("pix left", "No reply from pix"); waits have their own line. */
export function noticeText(w: Waiting): string | undefined {
	// "No reply from X" is redundant while the waits line still lists X.
	const parts = [...new Set(w.notices.filter(x => !w.waits.some(y => x.text.endsWith(` ${y.to}`) && x.text.startsWith("No reply"))).map(x => x.text))];
	return parts.length ? parts.join(", ") : undefined;
}

/** The footer text, or undefined when there is nothing to say. */
export function waitingText(w: Waiting): string | undefined {
	const names = [...new Set(w.waits.map(x => x.to))];
	const parts = [names.length ? `Waiting for ${names.join(", ")}` : "", ...new Set(w.notices.map(x => x.text))].filter(Boolean);
	return parts.length ? parts.join(", ") : undefined;
}

export const sameWaiting = (a: Waiting, b: Waiting) => JSON.stringify(a) === JSON.stringify(b);
