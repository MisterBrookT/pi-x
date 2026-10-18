/**
 * Who this session waits on: asks and handoffs it sent that have no reply yet.
 * Shown as one quiet footer status ("Waiting for pix"); it does not mean anything is running.
 * Kept in ~/.pi/agent/chat/<me>/waiting.json so it survives /reload.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WAIT_MS = 2 * 60 * 60_000;   // after this, say "No reply from X"
export const NOTICE_MS = 10 * 60_000;      // how long "X left" / "No reply from X" stays

export type Wait = { thread: string; to: string; kind: string; at: number; live: boolean };
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
export function sentNote(w: Waiting, n: { thread: string; to: string; kind: string; at?: number }, live: boolean): Waiting {
	if (n.kind !== "ask" && n.kind !== "handoff") return w;
	return { waits: [...w.waits.filter(x => x.thread !== n.thread), { thread: n.thread, to: n.to, kind: n.kind, at: n.at ?? Date.now(), live }], notices: w.notices.filter(x => x.thread !== n.thread) };
}

/** Any message back on the thread ends the wait. */
export function receivedNote(w: Waiting, n: { thread: string }): Waiting {
	return { waits: w.waits.filter(x => x.thread !== n.thread), notices: w.notices.filter(x => x.thread !== n.thread) };
}

/**
 * Periodic check: a peer that was running and is gone -> "X left"; too long -> "No reply from X".
 * A peer that was not running at send time is not "left"; its message waits for it (until the timeout).
 */
export function tick(w: Waiting, live: Set<string>, now = Date.now()): Waiting {
	const waits: Wait[] = [], notices = w.notices.filter(x => now - x.at < NOTICE_MS);
	for (const x of w.waits) {
		if (x.live && !live.has(x.to)) notices.push({ thread: x.thread, text: `${x.to} left`, at: now });
		else if (now - x.at >= WAIT_MS) notices.push({ thread: x.thread, text: `No reply from ${x.to}`, at: now });
		else waits.push({ ...x, live: x.live || live.has(x.to) });
	}
	return { waits, notices };
}

/** The footer text, or undefined when there is nothing to say. */
export function waitingText(w: Waiting): string | undefined {
	const names = [...new Set(w.waits.map(x => x.to))];
	const parts = [names.length ? `Waiting for ${names.join(", ")}` : "", ...new Set(w.notices.map(x => x.text))].filter(Boolean);
	return parts.length ? parts.join(" · ") : undefined;
}

export const sameWaiting = (a: Waiting, b: Waiting) => JSON.stringify(a) === JSON.stringify(b);
