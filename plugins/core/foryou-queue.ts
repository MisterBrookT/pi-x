// For you's "do not interrupt" queue, shared by the daemon (writes), the For you session (marks brook's
// activity) and the footer ("N queued"). While brook and For you are mid-thread, new-message batches wait
// here and are delivered as one batch once the thread goes quiet.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proactiveDir } from "./memory-badge.ts";

/** brook spoke within this window: the thread is active. */
export const ACTIVE_MS = 10 * 60_000;
/** For you is still busy or waiting on a handoff it started for brook within this window: still active. */
export const TASK_MS = 60 * 60_000;

const activityPath = (dir: string) => join(dir, "activity.json");
const queuePath = (dir: string) => join(dir, "queue.jsonl");

/** Daemon-made turns ("[For you: …]") and session-chat deliveries are not brook talking. */
export const isBrookText = (text: string) => !/^\s*\[(For you:|chat )/i.test(text);

export function markBrookActive(dir: string | undefined, now = Date.now()) {
	dir ??= proactiveDir();
	try { writeFileSync(activityPath(dir), JSON.stringify({ userAt: now })); } catch { /* */ }
}
export function brookActiveAt(dir = proactiveDir()): number {
	try { return Number(JSON.parse(readFileSync(activityPath(dir), "utf8")).userAt) || 0; } catch { return 0; }
}

/**
 * Is brook in a live thread with For you? He wrote within 10 min, or For you is still working on (busy) or
 * waiting for (open handoff) something it started for him in the last hour.
 */
export function threadActive(o: { userAt: number; busy?: boolean; openWaits?: number; now?: number }): boolean {
	const since = (o.now ?? Date.now()) - o.userAt;
	if (!o.userAt) return false;
	if (since < ACTIVE_MS) return true;
	return since < TASK_MS && (!!o.busy || (o.openWaits ?? 0) > 0);
}

export interface Held { at: string; text: string; urgent?: string }
export function holdBatch(text: string, dir = proactiveDir(), now = new Date()) {
	appendFileSync(queuePath(dir), JSON.stringify({ at: now.toISOString(), text } satisfies Held) + "\n");
}
export function readQueue(dir = proactiveDir()): Held[] {
	if (!existsSync(queuePath(dir))) return [];
	return readFileSync(queuePath(dir), "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Held]; } catch { return []; } });
}
export const queuedCount = (dir = proactiveDir()) => readQueue(dir).length;
export function clearQueue(dir = proactiveDir()) { rmSync(queuePath(dir), { force: true }); }

/** Everything held, as one message to For you. */
export function heldPrompt(held: Held[]): string {
	const first = held[0]?.at.slice(0, 16).replace("T", " ") ?? "";
	return `[For you: held while you were in a thread with brook — ${held.length} batch${held.length === 1 ? "" : "es"} since ${first}]
Same rules as for new messages; handle them together, one short reply.

${held.map(h => h.text).join("\n\n---\n\n")}`;
}

/** The one line that may interrupt an active thread. */
export const urgentLine = (source: string, why: string) => `[For you: urgent, ${source}] ${why.replace(/\s+/g, " ").slice(0, 200)} (full batch held for later)`;
