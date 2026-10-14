// Proactive loop core: receive -> judge -> notify -> act.
// Pure helpers only. Channels live in proactive-sources.ts; IO in scripts/proactive-daemon.ts,
// the one list in proactive-store.ts (shared by the Mac pill and Pix Remote "For you").
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROACTIVE_DIR = process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive");
export const paths = (dir = PROACTIVE_DIR) => ({
	dir,
	config: join(dir, "config.json"),
	memory: join(dir, "memory.md"),
	state: join(dir, "state.json"),
	inbox: join(dir, "inbox.jsonl"),
	log: join(dir, "daemon.log"),
	judgments: join(dir, "judgments.jsonl"),
	health: join(dir, "health.json"),
	memoryLog: join(dir, "memory.log"),
});

/** One watched channel. `kind` picks the adapter in proactive-sources.ts; extra keys are adapter-specific. */
export interface Source { kind: string; id: string; name: string; project?: string; chat?: "group" | "private"; [key: string]: unknown }
export interface Config { me: string; sources: Source[]; intervalSec: number; model: string; maxPerHour: number }
export const defaultConfig: Config = { me: "", sources: [], intervalSec: 600, model: "openai-codex/gpt-6-luna", maxPerHour: 4 };

export interface Msg { id: string; time: string; sender: string; text: string }
/** Memory edits proposed by the judge: lines to add, and existing lines (exact text) to remove. */
export interface MemoryEdit { add: string[]; remove: string[] }
/**
 * One open loop: something unfinished between brook and someone else. `button` names the prepared
 * next step ("Draft reply"); `due` is a date when something is owed.
 */
export interface Alert { title: string; why: string; action: string; refs: string[]; button?: string; due?: string; project?: string;
	/** A live Pi session the judge thinks should do the next step (offered on the card). */
	to?: string;
	/** The card's main buttons, written by the judge for this loop. */
	choices?: Choice[] }
/**
 * One button on a card. `run` says where the work goes: "here" = the For you session does it,
 * "discuss" = For you talks it through first, a live session id, "new" (a session in the project),
 * "later" = back in 2 days, "no" = close the loop.
 * `prompt` is what that session is told to do (default: the loop's next step).
 */
export interface Choice { label: string; run: string; prompt?: string }
/** Keep only well-formed buttons: short label, a known kind of target, at most 3. */
export function cleanChoices(x: unknown): Choice[] | undefined {
	if (!Array.isArray(x)) return undefined;
	const out = x.filter((c: any) => c && typeof c.label === "string" && c.label.trim() && typeof c.run === "string" && /^[\w.-]{1,80}$/.test(c.run))
		.slice(0, 3).map((c: any) => ({ label: c.label.trim().slice(0, 40), run: c.run, ...(typeof c.prompt === "string" && c.prompt.trim() ? { prompt: c.prompt.trim().slice(0, 600) } : {}) }));
	return out.length ? out : undefined;
}
/** One Pi session open right now, as the judge sees it: what brook is working on. */
export interface WorkSession { id: string; name: string; cwd: string; busy?: boolean; todo?: string; preview?: string }
/** Where a loop stands, as the judge sees it. needs = needs brook now; waiting = others owe him; later = he owes it, not yet due. */
export type LoopState = "needs" | "waiting" | "later";
/** A change to an existing loop (any source), e.g. after brook replied or a duplicate showed up elsewhere. */
export interface LoopUpdate extends Partial<Omit<Alert, "refs">> { id: string; state?: LoopState }
/** The judge's answer for one batch: new loops, updated loops, finished loops, and memory edits. */
export interface Verdict { alerts: (Alert & { state?: LoopState })[]; update: LoopUpdate[]; close: string[]; memory: MemoryEdit;
	/** Card edits (memory/people/*, memory/projects/*, memory/index). */
	cards: { card: string; add: string[]; remove: string[] }[] }
/**
 * Status: pending = needs brook now; onit = a Pi session took it; later/waiting = hidden until `wakeAt`;
 * done/dismissed/resolved = closed. `quiet` = kept but not pushed. `session` = the Pi session on it.
 */
export type Status = "pending" | "onit" | "later" | "waiting" | "done" | "dismissed" | "resolved";
export interface Item extends Alert { id: string; at: string; source: string; sourceKey: string; howToRead: string; status: Status; quiet?: boolean; session?: string; wakeAt?: string; at_status?: string;
	/** Folder of the session working on it, so a closed session can be resumed there. */
	sessionCwd?: string;
	/** The loop's brief: dated progress lines written by whoever worked on it. Survives any chat. */
	note?: string;
	/** A job card offered in a session: brook answers there (Do it / Discuss / Later / No / Something else). */
	suggest?: { session: string; name?: string; at: string; answer?: "do" | "discuss" | "later" | "no" | "notnow" | "else"; text?: string; answeredAt?: string; by?: string } }

/** The daemon script: work sessions call its `note` verb to leave progress on a loop. */
export const daemonScript = fileURLToPath(new URL("../scripts/proactive-daemon.ts", import.meta.url));

export const isOpen = (i: Pick<Item, "status">) => i.status === "pending" || i.status === "onit" || i.status === "later" || i.status === "waiting";
/** Shown as "needs you": pending, or a parked loop whose time has come. */
export const needsYou = (i: Pick<Item, "status" | "wakeAt">, now = Date.now()) => i.status === "pending" || (isOpen(i) && !!i.wakeAt && Date.parse(i.wakeAt) <= now);
const DAY = 86_400_000;
/** When a parked loop comes back: the morning of the day before it is due, else after `fallbackDays`. */
export function wakeTime(due: string | undefined, now: number, fallbackDays: number): string {
	const d = due ? Date.parse(due) : NaN;
	if (!Number.isNaN(d) && d - DAY > now) { const w = new Date(d - DAY); w.setHours(9, 0, 0, 0); return w.toISOString(); }
	if (!Number.isNaN(d) && d > now) return new Date(now + Math.min(DAY, (d - now) / 2)).toISOString();
	return new Date(now + fallbackDays * DAY).toISOString();
}

export const sourceKey = (s: Source) => `${s.kind}:${s.id}`;

/** Messages after the last seen id. If the cursor is gone, treat everything as new. */
export function newSince(msgs: Msg[], lastId?: string): Msg[] {
	if (!lastId) return msgs;
	const i = msgs.findIndex(m => m.id === lastId);
	return i < 0 ? msgs : msgs.slice(i + 1);
}

/**
 * What to judge for one source. New messages include the user's own replies: they are what
 * resolves an alert. Judge when someone else wrote, or when the user wrote and this source
 * still has pending alerts (so his reply can close them). His own chatter alone costs nothing.
 */
export function planBatch(msgs: Msg[], lastId: string | undefined, me: string, openHere: number): { fresh: Msg[]; context: Msg[]; judge: boolean } {
	const fresh = newSince(msgs, lastId);
	const context = msgs.slice(0, msgs.length - fresh.length).slice(-15);
	const fromOthers = fresh.some(m => m.sender.trim() !== me);
	return { fresh, context, judge: fromOthers || (fresh.length > 0 && openHere > 0) };
}

const loopLine = (p: Item) => `- id=${p.id}: ${p.title} [${p.status === "onit" ? "Pi is on it" : p.status === "later" || p.status === "waiting" ? p.status : "needs him"}${p.due ? `, due ${p.due}` : ""}]${p.source ? ` (from ${p.source})` : ""}${p.project ? ` project=${p.project}` : ""}${p.note ? `\n  progress: ${p.note.split("\n").at(-1)}` : ""}`;

export function judgePrompt(o: { me: string; memory: string; source: Source; context: Msg[]; fresh: Msg[]; pending: Item[]; feedback?: Item[]; now: string; work?: WorkSession[]; cards?: boolean }): string {
	const fmt = (m: Msg) => `[${m.time} id=${m.id}] ${m.sender}${o.me && m.sender.trim() === o.me ? " (me)" : ""}: ${m.text}`;
	return `You are ${o.me}'s proactive assistant. You watch his channels (chats, mail, ...) and keep track of his open loops:
things still unfinished between ${o.me} and someone else. He should only see what needs him now.
A loop is worth tracking when:
- someone asks ${o.me} something, @mentions him, replies to him, or waits on him (a direct chat counts as asking him)
- something he asked for is delivered, or a blocker/decision/deadline appears
- it changes what he should do next in his project (see memory)
- he promised something and it is still open
Never track chit-chat, FYI, or anything that needs nothing from him. If your suggested action would be "no follow-up", do not create it.
Messages marked (me) are ${o.me}'s own.
In a group chat, a question or request is for ${o.me} only with evidence: it @mentions or names him, quotes/replies to his message,
answers something he just said, or memory says it is his job. A question that follows someone else's share or message
(e.g. "你接入claude是用cli吗？" after another person posted their bot workflow) is for that person, not him: no loop.
When unsure who it is for, create nothing. Project updates, deadlines, and promises that matter to his projects (see memory) still count.

Now: ${o.now}
Source: ${o.source.name} [${o.source.kind}${o.source.chat ? `, ${o.source.chat} chat` : ""}]${o.source.project ? ` (project: ${o.source.project})` : ""}

## Memory
${o.memory || "(empty)"}

## What ${o.me} is working on now (open Pi sessions)
${(o.work ?? []).map(w => `- id=${w.id} "${w.name}" in ${w.cwd}${w.busy ? " (busy)" : ""}${w.todo ? `; doing: ${w.todo}` : ""}${w.preview ? `; last: ${w.preview.replace(/\s+/g, " ").slice(0, 120)}` : ""}`).join("\n") || "(none known)"}

## Open loops (all sources; already known, never create a duplicate)
${o.pending.map(loopLine).join("\n") || "(none)"}

## How ${o.me} reacted to recent loops
${(o.feedback ?? []).map(f => `- ${f.status === "done" || f.status === "onit" ? "acted on" : f.status === "resolved" ? "resolved" : "dismissed"}: ${f.title}`).join("\n") || "(none yet)"}

## Earlier messages (context only)
${o.context.map(fmt).join("\n") || "(none)"}

## New messages
${o.fresh.map(fmt).join("\n")}

Decide, in this order:
1. Do the new messages move an existing loop (from any source)? Then put it in "update", never a new alert.
   Example: someone asked ${o.me} to test X; he replied "ok, by next week" -> update that loop:
   {"id": "...", "state": "later", "title": "Test X for Y", "due": "2026-10-16", "action": "...", "button": "Start test"}.
   A task card or mail about the same thing as an open loop is the same loop: update it.
   When a step is finished and the loop moves on, give the next step's "button" and "action"
   (e.g. the test is done -> "button": "Send results to Amber", "state": "needs").
   If ${o.me} already did it himself, close it.
   state: "needs" = needs him now; "waiting" = he is waiting on someone else; "later" = he owes it, not due yet.
2. Is a loop finished (done, answered, cancelled, no longer needed)? Put its id in "close".
3. Only then, a truly new loop goes in "alerts" (usually none, never more than 3).
4. Who should do the next step? If one open Pi session above is clearly already working on this exact thing
   (same project folder and its "doing"/"last" matches), set "to" to that session id: his card in For you will offer
   "Send to <that session>". Otherwise omit "to".

${o.cards ? `You also keep the memory, as cards: "index" (about ${o.me}, what to notify), one card per person
("people/<name>", e.g. "people/Knight") and one per project ("projects/<name>", e.g. "projects/newsdecision").
Put a lasting fact on the card it is about: roles, who works on what, decisions, project state, what he cares about or ignores.
Open loops (promises, waiting, deadlines) live in the loop list, not memory.
- add a short line (no date; it is added for you); remove a line (copy its text) when it is no longer true
- a new person or project that matters to him gets a new card: first line "who/what they are"
- learn from his reactions: if he keeps dismissing a kind of loop, add a line to "index" saying he does not care about it
Most of the time, change nothing.` : `You also keep the memory: short bullet lines of lasting facts about ${o.me}'s world: people and their roles,
projects, decisions, and what he cares about or ignores. Open loops (promises, waiting, deadlines) live in the loop list, not memory.
- add a line when a new lasting fact appears; remove a line (copy its exact text) when it is no longer true
- learn from his reactions: if he keeps dismissing a kind of loop, add a line saying he does not care about it
Most of the time, change nothing.`}

"button" is 1-3 words: the outcome ${o.me} wants, as a verb, in the language of the loop. Name the result, not the preparation;
never start with "Draft" or "Prepare". Good: "Reply to 杨奕辉", "Send wallet address", "Start Databento test", "Check backtest", "Ask 黄恩浩".
"choices" are the buttons on his card: the 1-3 moves that fit THIS loop best, best first (as many as make sense).
Each has "label" (<=4 words, in the loop's language), "run" (what happens: "here" = his For you assistant does it,
"discuss" = talk it through with him first, an open Pi session id from above when that session is the right place,
"new" = a fresh session in the project, "later" = remind him in 2 days), and optionally "prompt"
(one line: what to do, when it differs from "action"). Three buttons are always added after yours, do not repeat
them: "Not important" (drop it), "Send to a session" (he picks any open session), "Something else" (he writes his own). Example: [{"label": "Fix in minara", "run": "<session id>"}, {"label": "Ask Lowes for steps",
"run": "here", "prompt": "Draft a reply asking Lowes for repro steps"}, {"label": "Not now", "run": "later"}].
"due" is YYYY-MM-DD when there is a deadline, else omit.
"project" is the folder of the project this loop belongs to, taken from memory (e.g. "~/workspace/minara/newsdecision"); omit if none is clear.
Every alert needs "for" and "evidence": "me" = addressed to him, "project" = changes his project (memory), "promise" = he owes or is owed it.
If you cannot fill "evidence", it is not his loop: leave it out.
Reply with JSON only, no prose:
{"alerts": [{"title": "<=60 chars, the loop", "why": "<=120 chars, why it matters to ${o.me}", "action": "one concrete next step an agent could prepare", "button": "<outcome verb>", "state": "needs", "due": "YYYY-MM-DD", "project": "~/path or omit", "for": "me|project|promise", "evidence": "<=120 chars: the @mention, reply, name, or memory line showing it is his", "refs": ["message ids"], "to": "session id or omit", "choices": [{"label": "...", "run": "here|discuss|<session id>|new|later|no", "prompt": "optional"}]}], "update": [{"id": "open loop id", "state": "later", "title": "...", "why": "...", "action": "...", "button": "...", "due": "YYYY-MM-DD", "project": "...", "choices": [...]}], "close": ["open loop id"], ${o.cards ? `"cards": [{"card": "people/Knight", "add": ["..."], "remove": ["existing line text"]}]` : `"memory": {"add": ["- ..."], "remove": ["exact existing line"]}`}}`;
}

export function parseVerdict(raw: string): Verdict | null {
	const m = raw.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const v = JSON.parse(m[0]);
		const lines = (x: unknown) => (Array.isArray(x) ? x.map(l => String(l).trim()).filter(Boolean).slice(0, 10).map(l => l.slice(0, 200)) : []);
		// Older one-alert shape: {"notify": true, "title": ...}
		const list = Array.isArray(v.alerts) ? v.alerts : typeof v.notify === "boolean" ? (v.notify ? [v] : []) : null;
		if (!list) return null;
		const str = (x: unknown, n: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : undefined);
		const state = (x: unknown): LoopState | undefined => (x === "needs" || x === "waiting" || x === "later" ? x : undefined);
		const project = (x: unknown) => { const p = str(x, 300); return p && /^(~\/|\/)/.test(p) ? p : undefined; };
		const due = (x: unknown) => { const d = str(x, 10); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined; };
		const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
		// "No follow-up" is not a loop: drop it (the judge sometimes says so in the action).
		const noop = (a: any) => /无需跟进|no (follow[- ]?up|action)( needed)?|nothing to do/i.test(String(a.action ?? ""));
		// Recipient guard: an alert the judge says is for someone else, or with no evidence it is his, is dropped.
		// A verdict without "for" (older shape) is kept.
		const unaddressed = (a: any) => a.for !== undefined && (!["me", "project", "promise"].includes(String(a.for)) || !str(a.evidence, 200));
		const alerts = list.filter((a: any) => a && String(a.title ?? "").trim() && !noop(a) && a.fyi !== true && !unaddressed(a)).slice(0, 3).map((a: any) => clean({ title: String(a.title).slice(0, 80), why: String(a.why ?? "").slice(0, 200), action: String(a.action ?? "").slice(0, 400), refs: Array.isArray(a.refs) ? a.refs.map(String) : [], button: str(a.button, 24), due: due(a.due), state: state(a.state), project: project(a.project), to: typeof a.to === "string" && /^[\w.-]{1,80}$/.test(a.to) ? a.to : undefined, choices: cleanChoices(a.choices) }));
		const update = (Array.isArray(v.update) ? v.update : []).filter((u: any) => u && typeof u.id === "string").slice(0, 10).map((u: any) => clean({ id: u.id, state: state(u.state), title: str(u.title, 80), why: str(u.why, 200), action: str(u.action, 400), button: str(u.button, 24), due: due(u.due), project: project(u.project), choices: cleanChoices(u.choices) }));
		const cards = (Array.isArray(v.cards) ? v.cards : []).filter((c: any) => c && typeof c.card === "string").slice(0, 8).map((c: any) => ({ card: c.card.trim().slice(0, 80), add: lines(c.add), remove: lines(c.remove) })).filter((c: any) => c.add.length || c.remove.length);
		return { alerts, update, close: lines(v.close), memory: { add: lines(v.memory?.add), remove: lines(v.memory?.remove) }, cards };
	} catch { return null; }
}

const bullet = (l: string) => (l.startsWith("- ") ? l : `- ${l.replace(/^[-*]\s*/, "")}`);
const norm = (l: string) => l.trim().replace(/^[-*]\s*/, "");

/**
 * Apply a memory edit to memory.md. Removals match existing lines by text (bullet ignored);
 * additions go under "## Learned" unless already present. Returns the new text and what changed.
 */
export function applyMemory(text: string, edit: MemoryEdit): { text: string; added: string[]; removed: string[] } {
	const drop = new Set(edit.remove.map(norm));
	const removed: string[] = [];
	let lines = text.split("\n").filter(l => {
		if (l.trim() && drop.has(norm(l))) { removed.push(l.trim()); return false; }
		return true;
	});
	const have = new Set(lines.map(norm));
	const added = edit.add.map(bullet).filter(l => !have.has(norm(l)) && (have.add(norm(l)), true));
	if (added.length) {
		const i = lines.findIndex(l => l.trim() === "## Learned");
		if (i < 0) lines = [...lines.join("\n").trimEnd().split("\n"), "", "## Learned", ...added];
		else {
			let end = i + 1;
			while (end < lines.length && !lines[end].startsWith("## ")) end++;
			while (end > i + 1 && !lines[end - 1].trim()) end--;
			lines.splice(end, 0, ...added);
		}
	}
	return { text: lines.join("\n").replace(/\n*$/, "\n"), added, removed };
}

/** Rate limit: at most `max` notifications in the last hour. */
export function underLimit(items: Item[], max: number, now = Date.now()): boolean {
	return items.filter(i => !i.quiet && now - Date.parse(i.at) < 3600_000).length < max;
}

export function parseInbox(text: string): Item[] {
	const byId = new Map<string, Item>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { const it = JSON.parse(line); if (it?.id) byId.set(it.id, { ...byId.get(it.id), ...it }); } catch { /* skip */ }
	}
	// A status line whose item was lost (cut file, bad line) is not an item.
	return [...byId.values()].filter(i => i.title !== undefined);
}

/** Loops that need brook now, newest first: what every view (Mac pill, iPhone, hub API) shows. */
export function pendingItems(text: string, now = Date.now()): Item[] {
	return parseInbox(text).filter(i => needsYou(i, now)).reverse();
}

/** Status line for a judge's update: parked states get a wake time; "needs" brings it back now. */
export function updateLine(it: Item, u: LoopUpdate, now = Date.now()): Record<string, unknown> {
	const { id, state, ...fields } = u;
	const line: Record<string, unknown> = { id, ...fields, at_status: new Date(now).toISOString() };
	const due = u.due ?? it.due;
	if (state === "needs") Object.assign(line, { status: "pending", wakeAt: null });
	else if (state === "waiting" || state === "later") {
		// A loop a Pi session already took stays "on it"; it just gets the new due time.
		if (it.status !== "onit") line.status = state;
		line.wakeAt = wakeTime(due, now, state === "waiting" ? 3 : 7);
	} else if (u.due && it.status !== "pending") line.wakeAt = wakeTime(due, now, 3);
	return line;
}

/**
 * The daily pile check: every open loop, with age and brief, and the judge says which are finished,
 * stale (nothing will happen and nobody waits), or duplicates of another loop. Most loops stay.
 */
export function pilePrompt(o: { me: string; memory: string; open: Item[]; now: string; work?: WorkSession[] }): string {
	return `You keep ${o.me}'s list of open loops (things unfinished between him and someone else) short and true. Now: ${o.now}.
Look at every loop below and decide which ones should leave the list:
- "close": finished, answered, cancelled, or stale (older than ~2 weeks, past due with no sign anyone still waits, or no longer relevant)
- "merge": two loops about the same thing; keep the better one, close the other
- a loop whose latest progress line says the work is finished, submitted, or confirmed: close it
Leave a loop when unsure. Do not close a loop that is still in progress or has a future due date.
Also, for loops that need ${o.me} now: if one open Pi session below works in that loop's project (same folder or
clearly the same work), put it in "route": his card in For you will offer "Send to <that session>".
When several sessions share a folder, pick the one he is actively using (it has "doing", or the most recent "last").
Finally, for every loop marked "needs him" that has no buttons yet (no "choices:" in its line), or whose buttons no longer fit,
write its "choices": the 1-3 moves that fit THIS loop best, best first, specific to it (never a generic set like
"Do it here / Discuss"). Each: "label" (<=4 words, the loop's language), "run" ("here" = his For you assistant does it,
"discuss" = talk it through first, an open session id from above, "new" = a fresh session in the project,
"later" = remind him in 2 days), optional "prompt" (one line). "Not important", "Send to a session", and
"Something else" are always added; do not repeat them.

## Open Pi sessions
${(o.work ?? []).map(w => `- id=${w.id} "${w.name}" in ${w.cwd}${w.todo ? `; doing: ${w.todo}` : ""}${w.preview ? `; last: ${w.preview.replace(/\s+/g, " ").slice(0, 120)}` : ""}`).join("\n") || "(none)"}

## Memory
${o.memory || "(empty)"}

## Open loops
${o.open.map(i => `${loopLine(i)} created ${i.at.slice(0, 10)}${i.why ? `\n  why: ${i.why}` : ""}${i.action ? `\n  next: ${i.action}` : ""}${i.choices?.length ? `\n  choices: ${i.choices.map(c => `${c.label} (${c.run})`).join(", ")}` : ""}${i.note ? `\n  latest progress: ${i.note.split("\n").at(-1)!.slice(0, 400)}` : ""}`).join("\n")}

Reply with JSON only: {"close": [{"id": "...", "why": "<=80 chars"}], "merge": [{"keep": "id", "drop": "id", "why": "<=80 chars"}], "route": [{"id": "loop id", "to": "session id", "why": "<=80 chars"}], "choices": [{"id": "loop id", "choices": [{"label": "...", "run": "...", "prompt": "optional"}]}]}`;
}

export function parsePile(raw: string, open: Set<string>, sessions: Set<string> = new Set()): { close: { id: string; why: string }[]; merge: { keep: string; drop: string; why: string }[]; route: { id: string; to: string; why: string }[]; choices: { id: string; choices: Choice[] }[] } {
	try {
		const v = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "");
		const why = (x: unknown) => String(x ?? "").slice(0, 120);
		const close = (Array.isArray(v.close) ? v.close : []).filter((c: any) => open.has(c?.id)).map((c: any) => ({ id: c.id, why: why(c.why) }));
		const merge = (Array.isArray(v.merge) ? v.merge : []).filter((m: any) => open.has(m?.keep) && open.has(m?.drop) && m.keep !== m.drop).map((m: any) => ({ keep: m.keep, drop: m.drop, why: why(m.why) }));
		const gone = new Set([...close.map((c: any) => c.id), ...merge.map((m: any) => m.drop)]);
		const route = (Array.isArray(v.route) ? v.route : []).filter((r: any) => open.has(r?.id) && !gone.has(r.id) && sessions.has(r?.to)).map((r: any) => ({ id: r.id, to: r.to, why: why(r.why) }));
		const choices = (Array.isArray(v.choices) ? v.choices : []).filter((c: any) => open.has(c?.id) && !gone.has(c.id)).map((c: any) => ({ id: c.id, choices: cleanChoices(c.choices) })).filter((c: any): c is { id: string; choices: Choice[] } => !!c.choices);
		return { close, merge, route, choices };
	} catch { return { close: [], merge: [], route: [], choices: [] }; }
}

/**
 * "On it" loops nobody touched for `hours`: the session stopped (finished without saying so, or stuck).
 * They come back to brook as "needs you" with a Check button, so nothing sits silently in "Pi is on it".
 */
export function staleOnit(items: Item[], now: number, hours = 6): Item[] {
	return items.filter(i => i.status === "onit" && now - Date.parse(i.at_status ?? i.at) > hours * 3_600_000);
}

export interface Problem { source: string; since: string; times: number; error: string }
/** Plain words for a fetch error: a login that expired reads differently from a flaky network. */
export function problemText(error: string): string {
	if (/token_invalid|authentication|auth.*expired|not logged in|login/i.test(error)) return "login expired";
	if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(error)) return "network";
	if (/pi exited/i.test(error)) return "model call failed";
	return error.split("\n").find(l => /message|error/i.test(l))?.replace(/[\s"{},]+/g, " ").trim().slice(0, 80) || error.split("\n")[0].slice(0, 80);
}
/**
 * Track failing sources across ticks. A source counts as a problem after it failed `after` checks in a row;
 * one success clears it. Returns the new state (keyed by source name).
 */
export function trackHealth(old: Record<string, Problem>, failed: { source: string; error: string }[], ok: string[], now: string): Record<string, Problem> {
	const next: Record<string, Problem> = {};
	for (const [k, p] of Object.entries(old)) if (!ok.includes(k)) next[k] = p;
	for (const f of failed) next[f.source] = { source: f.source, since: old[f.source]?.since ?? now, times: (old[f.source]?.times ?? 0) + 1, error: problemText(f.error) };
	return next;
}
/** What brook sees: problems that lasted 3+ checks, grouped by kind ("Feishu: login expired, 12 chats"). */
export function healthSummary(state: Record<string, Problem>, after = 3): { text: string; since: string }[] {
	const groups = new Map<string, Problem[]>();
	for (const p of Object.values(state)) if (p.times >= after) { const kind = p.source.startsWith("WeChat") ? "WeChat" : p.source === "Gmail" ? "Gmail" : /model|pile|tidy/.test(p.source) ? "For you" : "Feishu"; const k = `${kind}: ${p.error}`; groups.set(k, [...(groups.get(k) ?? []), p]); }
	return [...groups].map(([k, ps]) => ({ text: `${k} (${ps.length === 1 ? ps[0].source.replace(/^WeChat: /, "") : `${ps.length} chats`})`, since: ps.map(p => p.since).sort()[0] }));
}

/** Weekly log cleanup: keep JSON lines from the last `days` days (and any line without a readable date). */
export function pruneLog(text: string, now: number, days = 30): string {
	const cut = now - days * 86_400_000;
	return text.split("\n").filter(l => { if (!l.trim()) return false; try { const t = Date.parse(JSON.parse(l).at); return Number.isNaN(t) || t >= cut; } catch { return true; } }).map(l => l + "\n").join("");
}

/** Public view of one item for the phone: no internal paths or commands. */
export const publicItem = (i: Item) => ({ session: i.session ?? "", quiet: !!i.quiet, id: i.id, title: i.title, why: i.why, action: i.action, source: i.source, kind: String(i.sourceKey ?? "").split(":")[0], project: i.project ?? "", at: i.at, status: i.status, handledAt: i.at_status ?? "", button: i.button ?? "", due: i.due ?? "", wakeAt: i.wakeAt ?? "", note: i.note ?? "", suggest: i.suggest && !i.suggest.answer ? { session: i.suggest.session, name: i.suggest.name ?? "" } : undefined });

/** A note line appended to a loop's brief, keeping the brief short (newest lines win). */
export function addNote(old: string | undefined, text: string, now = new Date()): string {
	const line = `- ${now.toISOString().slice(0, 10)}: ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
	return [...(old ? old.split("\n") : []), line].slice(-12).join("\n");
}

/** The task a session gets for a loop: the loop, its brief so far, and how to leave progress behind. */
export function actPrompt(it: Item, dir = PROACTIVE_DIR): string {
	const cli = `${dir === join(homedir(), ".pix", "proactive") ? "" : `PIX_PROACTIVE_DIR=${dir} `}node ${daemonScript}`;
	return `${it.session && it.status === "onit" ? `(Picked up again; earlier work is in Pi session ${it.session}.)\n\n` : ""}A proactive loop from ${it.source}${it.project ? ` (project: ${it.project})` : ""}:

**${it.title}**
Why: ${it.why}
Suggested next step: ${it.action}${it.due ? `\nDue: ${it.due}` : ""}
Original items: ${it.howToRead}
${it.note ? `\nProgress so far (the loop's brief):\n${it.note}\n` : ""}
Read the referenced items and any project files you need, then prepare this next step.
Draft anything outbound and show it to me first; do not send without my confirmation.
When you stop, record where the loop stands, so whoever picks it up next knows (one of these):
- still in progress: ${cli} note ${it.id} "<what is done, what is next>"
- this step is finished and the next step is brook's (e.g. after a test, sending the results):
  ${cli} next ${it.id} "<1-3 word outcome button, e.g. Send results to Amber>" "<the next step>" "<what is done>"
- the whole loop is finished (nothing left to do): ${cli} finished ${it.id} "<what was done, one line>"
  (brook gets it back once to check and close; never leave a finished loop "on it")`;
}
