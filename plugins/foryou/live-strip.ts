// Live strip: asks that reached For you while brook was mid-thread with it. The page shows them as a small
// strip in the For you chat ("Knight asks for the CSV": Reply now / Show / Later) instead of holding them silently.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { paths } from "./proactive.ts";

export interface LiveAsk { id: string; at: string; source: string; sourceKey: string; why: string; /** Short sender name. */ who?: string; /** Short English gist ("asks for the October CSV"); `why` is the fallback. */ gist?: string }
const file = (dir?: string) => join(paths(dir).dir, "live.json");
/** An ask stays on the strip for 6 h unless brook acts on it. */
export const LIVE_MS = 6 * 3_600_000;

export function readLive(dir?: string, now = Date.now()): LiveAsk[] {
	try { return (JSON.parse(readFileSync(file(dir), "utf8")) as LiveAsk[]).filter(a => now - Date.parse(a.at) < LIVE_MS); } catch { return []; }
}
const write = (list: LiveAsk[], dir?: string) => { const f = file(dir), t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(list, null, 2)); renameSync(t, f); };

/** One entry per chat: a newer ask from the same chat replaces the older one. */
export function addLive(dir: string | undefined, a: Omit<LiveAsk, "id" | "at">, now = Date.now()): LiveAsk {
	const it = { id: randomUUID().slice(0, 8), at: new Date(now).toISOString(), ...a, why: a.why.replace(/\s+/g, " ").slice(0, 160), ...(a.who ? { who: a.who.slice(0, 30) } : {}), ...(a.gist ? { gist: a.gist.slice(0, 80) } : {}) };
	write([...readLive(dir, now).filter(x => x.sourceKey !== a.sourceKey), it].slice(-12), dir);
	return it;
}
export function takeLive(id: string, dir?: string): LiveAsk | undefined {
	const list = readLive(dir), hit = list.find(a => a.id === id);
	if (hit) write(list.filter(a => a.id !== id), dir);
	return hit;
}
export const liveExists = (dir?: string) => existsSync(file(dir));

/** What For you is told when brook taps a strip button. "later" only removes it from the strip. */
export function livePrompt(a: LiveAsk, verb: "reply" | "show"): string {
	return verb === "reply"
		? `[For you: brook tapped Reply now] ${a.source} (source key ${a.sourceKey}): ${a.gist ?? a.why}. Draft the reply for this ask now and show it to him.`
		: `[For you: brook tapped Show] ${a.source} (source key ${a.sourceKey}): ${a.gist ?? a.why}. Show him the messages of this ask, briefly.`;
}

/** Handled elsewhere (his own reply, a loop made or closed, For you acted): drop that chat's rows. */
export function clearLive(sourceKey: string, dir?: string): number {
	const list = readLive(dir), keep = list.filter(a => a.sourceKey !== sourceKey);
	if (keep.length !== list.length) write(keep, dir);
	return list.length - keep.length;
}

/** "Do all": one For you turn for every row. Rows stay until handled (auto-clear) so nothing vanishes unseen. */
export function doAllPrompt(list: LiveAsk[]): string {
	return `[For you: brook tapped Do all] Handle every waiting ask now, per his rules: reply (routine, in an existing thread), route it to the session on that work, or make a card when he must decide. Use the loops tool for that chat (create / done / drop) so each one clears from the strip.
${list.map((a, i) => `${i + 1}. ${a.who ? `${a.who}: ` : ""}${a.gist ?? a.why} — ${a.source} (source key ${a.sourceKey})`).join("\n")}`;
}
