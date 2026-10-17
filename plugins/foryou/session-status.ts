// Session status: after each turn a cheap model writes one very short line about where that session stands.
// It runs beside the session (a separate `pi -p` call, detached), so it costs the session no context and no time.
// The result lands in two places in For you's notebook:
//   status.json   one line per session, overwritten each turn (the tracker: "where is everyone now")
//   activity.jsonl one line per turn, newest last (the history)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./proactive.ts";

export interface SessionStatus { session: string; name?: string; cwd?: string; at: string; line: string; needs?: boolean }

export const statusFile = (dir?: string) => join(paths(dir).dir, "status.json");

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The prompt: one line, very concise; the reply text is the main evidence. */
export function statusPrompt(name: string, ask: string, reply: string): string {
	return `Summarize where this coding session stands, for its owner brook, in ONE very short line (max 12 words).
Say what was done or what it is doing, and what is next or what it waits on. No filler, no "the session".
If brook must decide or do something, start the line with "needs you:".
Reply with only the line, in the language the reply uses.

Session: ${name}
brook asked: ${clip(ask, 600) || "(nothing new)"}
Session replied: ${clip(reply, 2400)}`;
}

/** Clean the model's answer to one short line; undefined when it is unusable. */
export function parseStatus(raw: string): { line: string; needs: boolean } | undefined {
	const first = raw.replace(/```\w*|```/g, "").split("\n").map(l => l.replace(/^[-*•>\s"]+|["\s]+$/g, "")).find(Boolean);
	if (!first) return undefined;
	const needs = /^needs you\s*[:：]/i.test(first);
	const line = clip(first.replace(/^needs you\s*[:：]\s*/i, ""), 120);
	return line ? { line, needs } : undefined;
}

export function readStatus(dir?: string): SessionStatus[] {
	try { return Object.values(JSON.parse(readFileSync(statusFile(dir), "utf8"))) as SessionStatus[]; } catch { return []; }
}

/** Put one session's line in status.json (atomic write; at most 40 sessions, oldest dropped). */
export function writeStatus(s: SessionStatus, dir?: string): void {
	const f = statusFile(dir);
	let all: Record<string, SessionStatus> = {};
	try { if (existsSync(f)) all = JSON.parse(readFileSync(f, "utf8")); } catch { /* start fresh */ }
	all[s.session] = s;
	const keep = Object.values(all).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
	const tmp = `${f}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep.map(x => [x.session, x])), null, 1));
	renameSync(tmp, f);
}

/** The tracker as text: one line per session, newest first. */
export function statusBoard(list: SessionStatus[], now = Date.now()): string {
	const ago = (at: string) => { const m = Math.max(0, Math.round((now - Date.parse(at)) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
	return [...list].sort((a, b) => b.at.localeCompare(a.at))
		.map(s => `${(s.name || s.session).slice(0, 16).padEnd(16)} · ${s.needs ? "needs you: " : ""}${s.line} · ${ago(s.at)} ago`).join("\n");
}

export type Ask = (prompt: string, model: string) => Promise<string>;

/** One cheap, tool-less, sessionless call through Pi. Detached and time-limited so it never holds the session. */
export const askCheap: Ask = (prompt, model) => new Promise((ok, bad) => {
	const child = execFile("pi", ["-p", "--no-session", "-nt", "-ne", "--model", model, "--thinking", "low"], { timeout: 60_000, maxBuffer: 1 << 20 }, (e, out) => e ? bad(e) : ok(String(out)));
	child.stdin?.end(prompt);
	child.unref?.();
});

/** Summarize one finished turn; never throws. Returns what was written, or undefined. */
export async function summarizeTurn(t: { session: string; name?: string; cwd?: string; ask: string; reply: string; model: string; dir?: string; now?: Date }, ask: Ask = askCheap): Promise<SessionStatus | undefined> {
	if (!t.reply.trim()) return undefined;
	try {
		const p = parseStatus(await ask(statusPrompt(t.name || t.session, t.ask, t.reply), t.model));
		if (!p) return undefined;
		const s: SessionStatus = { session: t.session, ...(t.name ? { name: t.name } : {}), ...(t.cwd ? { cwd: t.cwd } : {}), at: (t.now ?? new Date()).toISOString(), line: p.line, ...(p.needs ? { needs: true } : {}) };
		writeStatus(s, t.dir);
		return s;
	} catch { return undefined; }
}
