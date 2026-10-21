/**
 * Lines of work: brook's few ongoing threads (e.g. "Jev training", "Benchmark"), the map For you thinks in.
 * Each loop belongs to at most one line; a line has a short state ("where it stands, what's next").
 * The judge reads the map first, moves a line's state on progress (often with no card), and files loops under lines.
 * Stored in ~/.pix/proactive/lines.json; brook can edit it by hand.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FACE_NAMES } from "../core/job-faces.ts";

const PROACTIVE_DIR = process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive");

export interface Line { id: string; name: string; project?: string; state: string; next?: string; updated: string; hidden?: boolean;
	/** The job's face on the phone: one emoji For you picks and may change as the job evolves. */
	avatar?: string;
	/** The Pi session working on this line, and what it last said (tracked on every turn end). */
	owner?: { id: string; name?: string; status: string; at: string; busy?: boolean } }
/** A judge edit: a new line (no matching id), a state change, or retire (hidden). */
export interface LineEdit { id: string; name?: string; project?: string; state?: string; next?: string; retire?: boolean; avatar?: string }


const file = (dir = PROACTIVE_DIR) => join(dir, "lines.json");
export const slug = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40);

export function readLines(dir?: string): Line[] {
	try { const v = JSON.parse(readFileSync(file(dir), "utf8")); return Array.isArray(v) ? v.filter(l => l && typeof l.id === "string" && typeof l.name === "string") : []; } catch { return []; }
}
export const liveLines = (dir?: string) => readLines(dir).filter(l => !l.hidden);
export const writeLines = (lines: Line[], dir?: string) => writeFileSync(file(dir), JSON.stringify(lines, null, 2) + "\n");
export const haveLines = (dir?: string) => existsSync(file(dir));

export function parseLineEdits(x: unknown): LineEdit[] {
	if (!Array.isArray(x)) return [];
	const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) : undefined);
	return x.filter(e => e && (str(e.id, 40) || str(e.name, 40))).slice(0, 6).map((e: any) => {
		const out: LineEdit = { id: slug(str(e.id, 40) ?? str(e.name, 40)!) };
		const name = str(e.name, 40), state = str(e.state, 400), next = str(e.next, 120), project = str(e.project, 300);
		if (name) out.name = name;
		if (state) out.state = state;
		if (next) out.next = next;
		if (project && /^(~\/|\/)/.test(project)) out.project = project;
		if (e.retire === true) out.retire = true;
		const av = typeof e.avatar === "string" ? Array.from(e.avatar.trim()).slice(0, 4).join("") : "";
		if (av && /\p{Extended_Pictographic}/u.test(av)) out.avatar = av;
		else if (typeof e.avatar === "string" && FACE_NAMES.includes(e.avatar.trim().toLowerCase())) out.avatar = e.avatar.trim().toLowerCase();
		return out;
	});
}

/** Apply judge edits: update known lines, add a new one only when it has a name and state, retire = hide. */
export function applyLineEdits(lines: Line[], edits: LineEdit[], now = new Date().toISOString()): { lines: Line[]; changed: string[] } {
	const out = lines.map(l => ({ ...l }));
	const changed: string[] = [];
	for (const e of edits) {
		const l = out.find(x => x.id === e.id);
		if (l) {
			if (e.retire) l.hidden = true;
			else { if (e.name) l.name = e.name; if (e.state) l.state = e.state; if (e.next !== undefined) l.next = e.next; if (e.project) l.project = e.project; if (e.avatar) l.avatar = e.avatar; l.hidden = false; }
			l.updated = now; changed.push(e.id);
		} else if (!e.retire && e.name && e.state) {
			out.push({ id: e.id, name: e.name, state: e.state, ...(e.next ? { next: e.next } : {}), ...(e.project ? { project: e.project } : {}), ...(e.avatar ? { avatar: e.avatar } : {}), updated: now });
			changed.push(e.id);
		}
	}
	return { lines: out, changed };
}

/** The map, as the judge and the For you session read it. */
export function linesForPrompt(lines: Line[], loops: { id: string; title: string; line?: string }[] = []): string {
	const live = lines.filter(l => !l.hidden);
	if (!live.length) return "(none yet)";
	return live.map(l => {
		const mine = loops.filter(i => i.line === l.id);
		return `- line=${l.id} "${l.name}"${l.project ? ` (${l.project})` : ""}: ${l.state}${l.owner ? `; owner session ${l.owner.name ?? l.owner.id} (${l.owner.id}), last: ${l.owner.status}` : ""}${l.next ? `; next: ${l.next}` : ""}${mine.length ? `; open loops: ${mine.map(i => i.id).join(", ")}` : ""}`;
	}).join("\n");
}

/** A session that owns loops on a line finished a turn: record it as the line's owner with its latest status. */
export function trackLine(lineId: string, owner: { id: string; name?: string; status: string }, dir?: string, now = new Date().toISOString()): boolean {
	const lines = readLines(dir), l = lines.find(x => x.id === lineId);
	if (!l) return false;
	l.owner = { ...owner, at: now }; l.updated = now;
	writeLines(lines, dir);
	return true;
}

/** Retire a line by id (brook swiped it away). False when there is no such live line. */
export function hideLine(id: string, dir?: string): boolean {
	const lines = readLines(dir), l = lines.find(x => x.id === id && !x.hidden);
	if (!l) return false;
	l.hidden = true; l.updated = new Date().toISOString(); writeLines(lines, dir);
	return true;
}

/**
 * Merge lines of work into one (e.g. three Kairos lines into "Kairos launch"): the loops of every `from` line
 * move to `into` (via `refile`), and the old lines are retired. `into` may be new (then `name` is required).
 * Returns the moved loop ids, or undefined when nothing could be merged.
 */
export function mergeLines(from: string[], into: { id: string; name?: string; state?: string; project?: string }, refile: (loopLine: string, to: string) => string[], dir?: string, now = new Date().toISOString()): string[] | undefined {
	const lines = readLines(dir);
	const src = lines.filter(l => from.includes(l.id) && l.id !== into.id && !l.hidden);
	let target = lines.find(l => l.id === into.id);
	if (!src.length || (!target && !into.name)) return undefined;
	if (!target) { target = { id: into.id, name: into.name!, state: into.state || src.map(l => l.state).filter(Boolean)[0] || "", updated: now, ...(into.project ?? src[0].project ? { project: into.project ?? src[0].project } : {}) }; lines.push(target); }
	else { target.hidden = false; if (into.name) target.name = into.name; if (into.state) target.state = into.state; target.updated = now; }
	for (const l of src) { l.hidden = true; l.updated = now; }
	writeLines(lines, dir);
	return src.flatMap(l => refile(l.id, target!.id));
}

