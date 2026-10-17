/**
 * The new flow: a cheap filter, then For you.
 * The daemon fetches new messages; one cheap model call per batch only says pass or drop (with a reason).
 * What passes goes to the For you session as one chat message; For you decides, makes cards, hands work out, tracks.
 */
import type { Msg, Source } from "./proactive.ts";

export interface FilterVerdict { pass: boolean; why: string; ids: string[] }

/** The cheap model's only question: does any of this involve brook? */
export function filterPrompt(o: { me: string; source: Source; context: Msg[]; fresh: Msg[]; memory: string; lines: string }): string {
	const fmt = (m: Msg) => `[${m.id}] ${m.time} ${m.sender}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`;
	return `You filter messages for ${o.me}'s assistant. Pass a batch only if at least one new message needs or changes something for ${o.me}:
asks or @mentions him, replies to him, waits on him, delivers something he asked for, sets a deadline or decision in his projects,
or moves one of his lines of work (below). Drop chit-chat, FYI that changes nothing, and questions clearly addressed to someone else
(an @mention of another person makes that question theirs). When unsure, pass: the assistant decides.

About ${o.me}: ${o.memory.slice(0, 1500) || "(no memory)"}
His lines of work:
${o.lines || "(none)"}

Source: ${o.source.name}${o.source.chat ? ` (${o.source.chat} chat)` : ""}
Earlier messages (context only):
${o.context.map(fmt).join("\n") || "(none)"}
New messages:
${o.fresh.map(fmt).join("\n")}

Reply with JSON only: {"pass": true|false, "why": "<one short line>", "ids": ["<ids of the new messages that matter>"]}`;
}

export function parseFilter(raw: string): FilterVerdict | undefined {
	const m = raw.match(/\{[\s\S]*\}/);
	if (!m) return undefined;
	try {
		const v = JSON.parse(m[0]);
		if (typeof v.pass !== "boolean") return undefined;
		return { pass: v.pass, why: String(v.why ?? "").slice(0, 200), ids: Array.isArray(v.ids) ? v.ids.map(String).slice(0, 40) : [] };
	} catch { return undefined; }
}

export interface Forward { source: Source; sourceKey: string; fresh: Msg[]; context: Msg[]; why: string; ids: string[]; howToRead: string }

/** One chat message to For you for everything that passed this round. */
export function forwardPrompt(batches: Forward[], now = new Date()): string {
	const fmt = (m: Msg, hot: Set<string>) => `${hot.has(m.id) ? "▸ " : "  "}[${m.id}] ${m.time} ${m.sender}: ${m.text.replace(/\s+/g, " ").slice(0, 1200)}`;
	const parts = batches.map(b => {
		const hot = new Set(b.ids);
		return `### ${b.source.name} (source key ${b.sourceKey})${b.source.project ? `, project ${b.source.project}` : ""}
Filter: ${b.why}
${b.context.length ? `Before:\n${b.context.slice(-6).map(m => fmt(m, hot)).join("\n")}\n` : ""}New:
${b.fresh.map(m => fmt(m, hot)).join("\n")}
Read more: ${b.howToRead}`;
	});
	return `[For you: new messages, ${now.toISOString().slice(0, 16).replace("T", " ")}] ▸ marks what the filter thinks matters.

${parts.join("\n\n")}

Decide with everything you know (memory, lines, open loops, the session board):
- Already tracked or already done? Update that loop/line (loops tool "note", "done") instead of a new card.
- Someone else's question, or nothing for brook? Leave it.
- Needs brook? Create one card per piece of work (loops tool "create", with line, refs, and choices). Prepare first when
  it is cheap and read-only (read the thread, check the owner session or project), so the card brings facts or a draft.
- Work for a session? Hand it over with the chat tool (handoff to the line's owner); its reply comes back to you.
Then reply to brook in ONE short message: what came in and what you did, e.g. "3 new: 1 needs you (card), 2 noted".
If nothing needs him, reply only "No change." (it is hidden from him).`;
}

/**
 * The hourly review: For you wakes by itself and brings every card up to date with what changed since
 * (brook did it, a session moved on, a date passed). Silent unless something needs him.
 */
export function reviewPrompt(o: { open: { id: string; title: string; status: string; at: string; due?: string; session?: string; wakeAt?: string }[]; since?: string; now?: Date }): string {
	const now = o.now ?? new Date();
	const list = o.open.map(i => `- id=${i.id} [${i.status}${i.due ? `, due ${i.due}` : ""}${i.wakeAt ? `, back ${i.wakeAt.slice(0, 16)}` : ""}${i.session ? `, ${i.session}` : ""}] ${i.title}`).join("\n");
	return `[For you: hourly review, ${now.toISOString().slice(0, 16).replace("T", " ")}${o.since ? `; last review ${o.since.slice(0, 16).replace("T", " ")}` : ""}]

Bring brook's cards up to date. For each open card below, check what changed since it was made:
- the activity log (what sessions did), the owner session's latest state, the session board, and the source thread if cheap;
- brook may have done it himself (a reply already sent, a file already submitted): then close it (loops "done") with a one-line note;
- the task changed (new ask, new date, someone else took it): update it (loops "note", "next", "choices", or "remind");
- a passed date or a stale wait: "later", or ask him once.
Also update lines of work and memory if you learn something lasting.
Do not start work and do not send anything. When nothing changed, reply only "No change." (brook is not told).
Otherwise reply with one short line per changed card.

Open cards:
${list || "(none)"}`;
}
