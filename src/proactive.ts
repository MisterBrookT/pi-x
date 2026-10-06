// Proactive loop core: receive -> judge -> notify -> act.
// Pure helpers only. Channels live in proactive-sources.ts; IO in scripts/proactive-daemon.ts,
// the one list in proactive-store.ts (shared by the Mac pill and Pix Remote "For you").
import { homedir } from "node:os";
import { join } from "node:path";

export const PROACTIVE_DIR = process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive");
export const paths = (dir = PROACTIVE_DIR) => ({
	dir,
	config: join(dir, "config.json"),
	memory: join(dir, "memory.md"),
	state: join(dir, "state.json"),
	inbox: join(dir, "inbox.jsonl"),
	log: join(dir, "daemon.log"),
	memoryLog: join(dir, "memory.log"),
});

/** One watched channel. `kind` picks the adapter in proactive-sources.ts; extra keys are adapter-specific. */
export interface Source { kind: string; id: string; name: string; project?: string; [key: string]: unknown }
export interface Config { me: string; sources: Source[]; intervalSec: number; model: string; maxPerHour: number }
export const defaultConfig: Config = { me: "", sources: [], intervalSec: 120, model: "openai-codex/gpt-6-luna", maxPerHour: 4 };

export interface Msg { id: string; time: string; sender: string; text: string }
/** Memory edits proposed by the judge: lines to add, and existing lines (exact text) to remove. */
export interface MemoryEdit { add: string[]; remove: string[] }
/** One thing worth telling the user about. */
export interface Alert { title: string; why: string; action: string; refs: string[] }
/** The judge's answer for one batch: zero or more alerts, pending items now resolved, and memory edits. */
export interface Verdict { alerts: Alert[]; close: string[]; memory: MemoryEdit }
/** An alert in the list. `quiet` = kept but not pushed (over the hourly limit). `session` = the Pi session working on it. */
export interface Item extends Alert { id: string; at: string; source: string; sourceKey: string; project?: string; howToRead: string; status: "pending" | "done" | "dismissed" | "resolved"; quiet?: boolean; session?: string }

export const sourceKey = (s: Source) => `${s.kind}:${s.id}`;

/** Messages after the last seen id. If the cursor is gone, treat everything as new. */
export function newSince(msgs: Msg[], lastId?: string): Msg[] {
	if (!lastId) return msgs;
	const i = msgs.findIndex(m => m.id === lastId);
	return i < 0 ? msgs : msgs.slice(i + 1);
}

const fmtMsg = (m: Msg) => `[${m.time} id=${m.id}] ${m.sender}: ${m.text}`;

export function judgePrompt(o: { me: string; memory: string; source: Source; context: Msg[]; fresh: Msg[]; pending: Item[]; feedback?: Item[]; now: string }): string {
	const fmt = fmtMsg;
	return `You are ${o.me}'s proactive assistant. You watch his channels (chats, mail, ...) and decide whether to interrupt ${o.me}.
Stay quiet by default. Interrupt only when it clearly matters to ${o.me}:
- someone asks ${o.me} something, @mentions him, or waits on him
- something he asked for is delivered, or a blocker/decision/deadline appears
- it changes what he should do next in his project (see memory)
- he promised something and it is still open
Do NOT interrupt for chit-chat, his own messages, or things already in the pending list.

Now: ${o.now}
Source: ${o.source.name} [${o.source.kind}]${o.source.project ? ` (project: ${o.source.project})` : ""}

## Memory
${o.memory || "(empty)"}

## Pending alerts (already shown, do not repeat; close them if the new messages resolve them)
${o.pending.map(p => `- id=${p.id}: ${p.title}`).join("\n") || "(none)"}

## How ${o.me} reacted to recent alerts
${(o.feedback ?? []).map(f => `- ${f.status === "done" ? "acted on" : "dismissed"}: ${f.title}`).join("\n") || "(none yet)"}

## Earlier messages (context only)
${o.context.map(fmt).join("\n") || "(none)"}

## New messages
${o.fresh.map(fmt).join("\n")}

You also keep the memory up to date. Memory is short bullet lines about ${o.me}'s work:
open promises he made, things he is waiting for, decisions, deadlines, and what he cares about or ignores.
- add a line when something new and lasting appears (e.g. "- Promised: send benchkit API to the group (2026-10-05)")
- remove a line (copy its exact text) when it is resolved or no longer true
- learn from his reactions: if he keeps dismissing a kind of alert, add a line saying he does not care about it
Keep lines short and factual. Most of the time, change nothing.

Reply with JSON only, no prose. "alerts" is usually empty; use one alert per separate thing, never more than 3.
"close" lists pending alert ids that the new messages resolved (done, cancelled, no longer needed).
{"alerts": [{"title": "<=60 chars, what happened", "why": "<=120 chars, why it matters to ${o.me}", "action": "one concrete next step an agent could prepare", "refs": ["message ids"]}], "close": ["pending id"], "memory": {"add": ["- ..."], "remove": ["exact existing line"]}}`;
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
		const alerts = list.filter((a: any) => a && String(a.title ?? "").trim()).slice(0, 3).map((a: any) => ({ title: String(a.title).slice(0, 80), why: String(a.why ?? "").slice(0, 200), action: String(a.action ?? "").slice(0, 400), refs: Array.isArray(a.refs) ? a.refs.map(String) : [] }));
		return { alerts, close: lines(v.close), memory: { add: lines(v.memory?.add), remove: lines(v.memory?.remove) } };
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

/** Pending items, newest first: what every view (Mac pill, iPhone, hub API) shows. */
export function pendingItems(text: string): Item[] {
	return parseInbox(text).filter(i => i.status === "pending").reverse();
}

/** Public view of one item for the phone: no internal paths or commands. */
export const publicItem = (i: Item & { at_status?: string }) => ({ session: i.session ?? "", quiet: !!i.quiet, id: i.id, title: i.title, why: i.why, action: i.action, source: i.source, kind: String(i.sourceKey ?? "").split(":")[0], project: i.project ?? "", at: i.at, status: i.status, handledAt: i.at_status ?? "" });

export function actPrompt(it: Item): string {
	return `A proactive alert from ${it.source}${it.project ? ` (project: ${it.project})` : ""}:

**${it.title}**
Why: ${it.why}
Suggested next step: ${it.action}
Original items: ${it.howToRead}

Read the referenced items and any project files you need, then prepare this next step.
Draft anything outbound and show it to me first; do not send without my confirmation.`;
}
