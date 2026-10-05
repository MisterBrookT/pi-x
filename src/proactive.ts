// Proactive loop core: receive -> judge -> notify -> act.
// Pure helpers only. Channels live in proactive-sources.ts; IO in scripts/proactive-daemon.ts,
// the TUI side in extensions/proactive.ts, the desktop pill in scripts/proactive-pill.swift.
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
});

/** One watched channel. `kind` picks the adapter in proactive-sources.ts; extra keys are adapter-specific. */
export interface Source { kind: string; id: string; name: string; project?: string; [key: string]: unknown }
export interface Config { me: string; sources: Source[]; intervalSec: number; model: string; maxPerHour: number }
export const defaultConfig: Config = { me: "", sources: [], intervalSec: 120, model: "pix-anthropic/claude-sonnet-5", maxPerHour: 4 };

export interface Msg { id: string; time: string; sender: string; text: string }
export interface Verdict { notify: boolean; title: string; why: string; action: string; refs: string[] }
export interface Item extends Verdict { id: string; at: string; source: string; sourceKey: string; project?: string; howToRead: string; status: "pending" | "done" | "dismissed" }

export const sourceKey = (s: Source) => `${s.kind}:${s.id}`;

/** Messages after the last seen id. If the cursor is gone, treat everything as new. */
export function newSince(msgs: Msg[], lastId?: string): Msg[] {
	if (!lastId) return msgs;
	const i = msgs.findIndex(m => m.id === lastId);
	return i < 0 ? msgs : msgs.slice(i + 1);
}

export function judgePrompt(o: { me: string; memory: string; source: Source; context: Msg[]; fresh: Msg[]; pending: Item[]; now: string }): string {
	const fmt = (m: Msg) => `[${m.time} id=${m.id}] ${m.sender}: ${m.text}`;
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

## Pending alerts (already shown, do not repeat)
${o.pending.map(p => `- ${p.title}`).join("\n") || "(none)"}

## Earlier messages (context only)
${o.context.map(fmt).join("\n") || "(none)"}

## New messages
${o.fresh.map(fmt).join("\n")}

Reply with JSON only, no prose:
{"notify": boolean, "title": "<=60 chars, what happened", "why": "<=120 chars, why it matters to ${o.me}", "action": "one concrete next step an agent could prepare", "refs": ["message ids"]}`;
}

export function parseVerdict(raw: string): Verdict | null {
	const m = raw.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const v = JSON.parse(m[0]);
		if (typeof v.notify !== "boolean") return null;
		return { notify: v.notify, title: String(v.title ?? "").slice(0, 80), why: String(v.why ?? "").slice(0, 200), action: String(v.action ?? "").slice(0, 400), refs: Array.isArray(v.refs) ? v.refs.map(String) : [] };
	} catch { return null; }
}

/** Rate limit: at most `max` notifications in the last hour. */
export function underLimit(items: Item[], max: number, now = Date.now()): boolean {
	return items.filter(i => now - Date.parse(i.at) < 3600_000).length < max;
}

export function parseInbox(text: string): Item[] {
	const byId = new Map<string, Item>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { const it = JSON.parse(line); if (it?.id) byId.set(it.id, { ...byId.get(it.id), ...it }); } catch { /* skip */ }
	}
	return [...byId.values()];
}

export function actPrompt(it: Item): string {
	return `A proactive alert from ${it.source}${it.project ? ` (project: ${it.project})` : ""}:

**${it.title}**
Why: ${it.why}
Suggested next step: ${it.action}
Original items: ${it.howToRead}

Read the referenced items and any project files you need, then prepare this next step.
Draft anything outbound and show it to me first; do not send without my confirmation.`;
}
