// Auto-close: a Pi session left idle for a day with nothing in flight quits on its own (like /quit).
// Its history stays on disk, so it is still in Resume; a one-line summary goes to autoclosed.jsonl
// so For you can say "closed N idle sessions".
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { behavior } from "./behavior.ts";

/** Hours of idleness before a session closes itself. Settings > Behavior, else PIX_AUTOCLOSE_HOURS; 0 turns it off. */
export const autoCloseHours = (env = process.env): number => behavior("autoCloseHours", env);

export interface CloseState {
	id: string;
	idleSince: number;
	now: number;
	hours: number;
	busy: boolean;
	hubHost: boolean;
	draft: boolean;
	question: boolean;
	background: number;
	helpers: number;
	/** Open loops this session holds (For you inbox). */
	openLoops: number;
	/** Lines this session owns or was added to. */
	lines: number;
}

/** Why this session must stay open, or undefined when it may close. */
export function keepOpen(s: CloseState): string | undefined {
	if (!s.hours) return "auto-close is off";
	if (s.id === "pix-foryou") return "For you";
	if (s.hubHost) return "hosts the hub";
	if (s.busy) return "working";
	if (s.draft) return "unsent draft";
	if (s.question) return "question open";
	if (s.background) return "background job running";
	if (s.helpers) return "helpers running";
	if (s.openLoops) return "holds an open loop";
	if (s.lines) return "on a line";
	if (s.now - s.idleSince < s.hours * 3_600_000) return "not idle long enough";
	return undefined;
}

export const autoClosedFile = (dir = process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive")) => join(dir, "autoclosed.jsonl");

export function recordAutoClose(entry: { id: string; name: string; cwd: string; summary: string; at?: string }, file = autoClosedFile()) {
	mkdirSync(dirname(file), { recursive: true });
	const summary = entry.summary.replace(/\s+/g, " ").trim().slice(0, 200);
	appendFileSync(file, JSON.stringify({ ...entry, summary, at: entry.at ?? new Date().toISOString() }) + "\n");
}

/** Sessions auto-closed in the last `withinMs` (default a day), newest first. */
export function recentAutoClosed(file = autoClosedFile(), now = Date.now(), withinMs = 86_400_000): { id: string; name: string; summary: string; at: string }[] {
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch { return []; }
	return text.split("\n").flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
		.filter(e => e && typeof e.at === "string" && now - Date.parse(e.at) < withinMs).reverse();
}

const proactiveDir = () => process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive");
const OPEN = new Set(["pending", "onit", "later", "waiting"]);
/** Open For you loops a session holds: the inbox is an append-only log, the last line per id wins. */
export function openLoopsHeldBy(session: string, dir = proactiveDir()): number {
	const f = join(dir, "inbox.jsonl");
	if (!existsSync(f)) return 0;
	const byId = new Map<string, any>();
	for (const l of readFileSync(f, "utf8").split("\n")) { try { const e = JSON.parse(l); if (e?.id) byId.set(e.id, { ...byId.get(e.id), ...e }); } catch {} }
	return [...byId.values()].filter(i => OPEN.has(i.status) && i.session === session).length;
}
/** Lines (not retired) a session owns or was added to. */
export function linesHeldBy(session: string, dir = proactiveDir()): number {
	try { const v = JSON.parse(readFileSync(join(dir, "lines.json"), "utf8")); return Array.isArray(v) ? v.filter(l => l && !l.hidden && (l.owner?.id === session || l.members?.includes?.(session))).length : 0; } catch { return 0; }
}
