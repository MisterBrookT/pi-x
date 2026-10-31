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

/** Urgent (due within a day) first, then newest. */
export function forYouRows(dir?: string, now = Date.now()): ForYouRow[] {
	const asks: ForYouRow[] = readLive(dir, now).map(a => ({ id: a.id, kind: "ask", who: a.who ?? whoOf(a.source), gist: a.gist ?? a.why, full: a.why, source: sourceName(a.source), at: Date.parse(a.at), urgent: false }));
	const cards: ForYouRow[] = waitingHeads(dir, now).map(({ it }) => {
		const due = it.due ? Date.parse(it.due) : NaN;
		return { id: it.id, kind: "card", who: whoOf(it.source), gist: it.title, full: it.why || it.title, source: sourceName(it.source), ...(it.due ? { due: it.due } : {}), at: Date.parse(it.at), urgent: !Number.isNaN(due) && due - now < DAY };
	});
	// Ties (same ms) keep the later-added row first.
	return [...asks, ...cards].map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.urgent) - Number(a.r.urgent) || b.r.at - a.r.at || b.i - a.i).map(x => x.r);
}

export const CHOOSE_HINT = "↑↓ or 1–9, Enter reply, s show, l later, Esc back";
const W = 72;

/**
 * "For you N", one short row each, then one reserved line: blank normally, the selected row's full text
 * while choosing. Line count never depends on focus, so the TUI never jumps.
 */
export function forYouLines(rows: ForYouRow[], selected?: string): string[] | undefined {
	if (!rows.length) return undefined;
	const sel = rows.find(r => r.id === selected);
	const head = `For you ${rows.length}${sel ? `   ${CHOOSE_HINT}` : ""}`;
	const body = rows.slice(0, 9).map((r, i) => cut(`${i + 1}${r.id === selected ? "›" : " "}${short(r.who, 12).padEnd(12)}  ${short(r.gist, 40)}${r.due ? `, due ${short(r.due, 16)}` : ""}   ${r.source}`, W));
	return [cut(head, W), ...body, sel ? short(sel.full, W) : " "];
}
