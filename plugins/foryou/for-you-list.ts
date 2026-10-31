// One For you list on the Mac: live asks (live.json) and waiting cards (loops) as one list of small rows.
// Both stores stay shared with the phone, so acting on any device clears the row everywhere.
import { readLive } from "./live-strip.ts";
import { waitingHeads } from "./proactive-store.ts";

export interface ForYouRow { id: string; kind: "ask" | "card"; who: string; gist: string; full: string; source: string; due?: string; at: number; urgent: boolean }

const DAY = 86_400_000;
const short = (t: string, n: number) => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const sourceName = (s: string) => s.split(":")[0].trim();
const cut = (t: string, n: number) => t.length > n ? `${t.slice(0, n - 1)}…` : t;
const whoOf = (s: string) => (s.split(":").slice(1).join(":").trim() || s).trim();

/** Newest first, by time only. */
export function forYouRows(dir?: string, now = Date.now()): ForYouRow[] {
	const asks: ForYouRow[] = readLive(dir, now).map(a => ({ id: a.id, kind: "ask", who: a.who ?? whoOf(a.source), gist: a.gist ?? a.why, full: a.why, source: sourceName(a.source), at: Date.parse(a.at), urgent: false }));
	const cards: ForYouRow[] = waitingHeads(dir, now).map(({ it }) => {
		const due = it.due ? Date.parse(it.due) : NaN;
		return { id: it.id, kind: "card", who: whoOf(it.source), gist: it.title, full: it.why || it.title, source: sourceName(it.source), ...(it.due ? { due: it.due } : {}), at: Date.parse(it.at), urgent: !Number.isNaN(due) && due - now < DAY };
	});
	// Ties (same ms) keep the later-added row first.
	return [...asks, ...cards].map((r, i) => ({ r, i })).sort((a, b) => b.r.at - a.r.at || b.i - a.i).map(x => x.r);
}

export const CHOOSE_HINT = "enter do  s show  d remove  u undo  esc";

/** Plain full detail for s: title, source, the whole text, prepared draft, latest notes. Wrapped to 72, at most 10 lines. */
export function forYouDetail(id: string, dir?: string, now = Date.now()): string[] | undefined {
	const a = readLive(dir, now).find(x => x.id === id);
	const parts: string[] = a ? [`${a.who ?? whoOf(a.source)}  ${sourceName(a.source)}`, a.why]
		: (() => { const it = waitingHeads(dir, now).find(h => h.it.id === id)?.it; if (!it) return [];
			const notes = (it.note ?? "").split("\n").filter(Boolean).slice(-3);
			return [it.title, it.source, ...(it.why && it.why !== it.title ? [it.why] : []), ...(it.prepared ? [`Prepared: ${it.prepared}`] : []), ...notes]; })();
	if (!parts.length) return undefined;
	const lines = parts.flatMap(p => { const out: string[] = []; let t = p.replace(/\s+/g, " ").trim(); while (t.length > W) { const k = t.lastIndexOf(" ", W) > 20 ? t.lastIndexOf(" ", W) : W; out.push(t.slice(0, k)); t = t.slice(k).trim(); } if (t) out.push(t); return out; });
	const head = "esc back", room = 9;
	return [head, ...(lines.length > room ? [...lines.slice(0, room - 1), cut(lines[room - 1], W - 4) + " ..."] : lines)];
}
export const REMOVED_NOTE = "removed, u undo";
const W = 72;

export const SHOWN = 1;

/**
 * Two lines: "For you N" (plus the keys while choosing), then one row: the newest item, or the selected one
 * as "2/9" with its full text. " ..." ends the row when more exist. Folded: the header alone.
 * Line count depends only on fold, never on focus.
 */
export function forYouLines(rows: ForYouRow[], selected?: string, folded = false, removed = false): string[] | undefined {
	if (!rows.length) return removed ? [`For you 0   ${REMOVED_NOTE}`] : undefined;
	const at = rows.findIndex(r => r.id === selected), sel = rows[at];
	const head = `For you ${rows.length}${removed ? `   ${REMOVED_NOTE}` : sel ? `   ${CHOOSE_HINT}` : ""}`;
	if (folded && !sel) return [cut(head, W)];
	const more = rows.length > 1, room = more ? W - 4 : W, r = sel ?? rows[0];
	const text = sel ? `${at + 1}/${rows.length}  ${r.full}` : `1  ${short(r.who, 12)}  ${short(r.gist, 40)}${r.due ? `, due ${short(r.due, 16)}` : ""}  ${r.source}`;
	return [cut(head, W), cut(text, room) + (more ? " ..." : "")];
}
