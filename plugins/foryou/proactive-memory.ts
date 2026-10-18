// For you memory: a small folder of cards, only for the For you agent (never loaded by normal Pi sessions).
//   memory/index.md          who brook is, what to notify, plus one line per card (kept up to date here)
//   memory/people/<name>.md  one person: role, what they work on with brook, dated facts
//   memory/projects/<name>.md one project: folder, goal, state, dated facts
// The judge sees the index always, and only the cards that the messages mention. Every change is a
// dated, sourced line, logged to memory.log; a weekly tidy rewrites long cards.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Msg, Source } from "./proactive.ts";
import { markMemorySeen, memorySeenAt, memoryUnseen } from "../core/memory-badge.ts";

export interface CardEdit { card: string; add: string[]; remove: string[] }
export interface Card { name: string; text: string }

const norm = (l: string) => l.trim().replace(/^[-*]\s*/, "").replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").replace(/\s*\(from [^)]*\)$/, "");
const GENERATED = "## Cards";

/** A safe card name: "index", "people/<name>" or "projects/<name>". Anything else is not a card. */
export function cardName(raw: unknown): string | undefined {
	const s = String(raw ?? "").trim().replace(/\.md$/, "");
	if (s === "index") return s;
	const m = s.match(/^(people|projects)\/(.+)$/);
	if (!m) return undefined;
	const name = m[2].replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "").replace(/^\.+/, "").trim().slice(0, 60);
	return name ? `${m[1]}/${name}` : undefined;
}

export const memoryDir = (dir: string) => join(dir, "memory");
const cardFile = (dir: string, name: string) => join(memoryDir(dir), `${name}.md`);

export function listCards(dir: string): Card[] {
	const out: Card[] = [];
	for (const kind of ["people", "projects"]) {
		const d = join(memoryDir(dir), kind);
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d).filter(f => f.endsWith(".md")).sort()) out.push({ name: `${kind}/${f.slice(0, -3)}`, text: readFileSync(join(d, f), "utf8") });
	}
	return out;
}

export const readIndex = (dir: string) => { const f = cardFile(dir, "index"); return existsSync(f) ? readFileSync(f, "utf8") : ""; };

/** The first fact line of a card: its one-line summary in the index. */
const summary = (text: string) => norm(text.split("\n").find(l => /^[-*] /.test(l.trim())) ?? "").slice(0, 120);

/** Rewrite the generated "## Cards" section of the index: one line per card. */
export function withCardList(index: string, cards: Card[]): string {
	const i = index.indexOf(`\n${GENERATED}`);
	const head = (i >= 0 ? index.slice(0, i) : index).trimEnd();
	const list = cards.map(c => `- ${c.name}: ${summary(c.text)}`).join("\n");
	return `${head}\n\n${GENERATED} (generated; edit the cards, not this list)\n${list || "(none yet)"}\n`;
}

/** Words a card is recognised by: its file name, and anything in its first line before ":" or "(". */
const aliases = (c: Card) => {
	const base = c.name.split("/")[1];
	const head = c.text.split("\n")[0].replace(/^#\s*/, "");
	return [base, ...head.split(/[,，/、]|\s+aka\s+/)].map(s => s.trim()).filter(s => s.length >= 2);
};

/** The cards these messages touch: named in the text, the sender, the source name, or the project folder. */
export function relevantCards(cards: Card[], o: { msgs: Msg[]; source?: Source; extra?: string }, max = 8): Card[] {
	const hay = [o.source?.name ?? "", String(o.source?.project ?? ""), o.extra ?? "", ...o.msgs.map(m => `${m.sender} ${m.text}`)].join("\n").toLowerCase();
	return cards.filter(c => aliases(c).some(a => hay.includes(a.toLowerCase()))).slice(0, max);
}

/** What the judge reads: the index, then the full text of each relevant card. */
export function memoryForPrompt(dir: string, o: { msgs: Msg[]; source?: Source; extra?: string }): string {
	const cards = listCards(dir);
	const index = withCardList(readIndex(dir), cards).trim();
	const hits = relevantCards(cards, o);
	return [index || "(empty)", ...hits.map(c => `### Card ${c.name}\n${c.text.trim()}`)].join("\n\n");
}

/** Everything (index + every card): for the For you coordinator, which may work on any loop. */
export function memoryAll(dir: string): string {
	const cards = listCards(dir);
	return [withCardList(readIndex(dir), cards).trim(), ...cards.map(c => `### Card ${c.name}\n${c.text.trim()}`)].filter(Boolean).join("\n\n");
}

/** Apply edits to cards. New lines get a date and the source; a new card starts with a "# name" title. */
export function applyCardEdits(dir: string, edits: CardEdit[], o: { source?: string; now?: Date } = {}): { card: string; added: string[]; removed: string[] }[] {
	const day = (o.now ?? new Date()).toISOString().slice(0, 10);
	const changes: { card: string; added: string[]; removed: string[] }[] = [];
	for (const e of edits) {
		const name = cardName(e.card);
		if (!name) continue;
		const file = cardFile(dir, name);
		const old = existsSync(file) ? readFileSync(file, "utf8") : name === "index" ? "# For you memory\n" : `# ${name.split("/")[1]}\n`;
		const drop = new Set(e.remove.map(norm));
		const removed: string[] = [];
		const lines = old.split("\n").filter(l => { if (l.trim() && !l.startsWith("#") && drop.has(norm(l))) { removed.push(l.trim()); return false; } return true; });
		const have = new Set(lines.map(norm));
		const added = e.add.map(l => l.trim()).filter(Boolean).filter(l => !have.has(norm(l)) && (have.add(norm(l)), true))
			.map(l => `- ${day}: ${norm(l)}${o.source ? ` (from ${o.source})` : ""}`);
		if (!added.length && !removed.length) continue;
		// The index keeps its generated list last; card lines go above it.
		const cut = lines.findIndex(l => l.startsWith(GENERATED));
		const body = (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trimEnd().split("\n");
		const text = [...body, ...added].join("\n") + "\n" + (cut >= 0 ? `\n${lines.slice(cut).join("\n").trim()}\n` : "");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
		changes.push({ card: name, added, removed });
	}
	if (changes.length) refreshIndex(dir);
	return changes;
}

export const refreshIndex = (dir: string) => { const f = cardFile(dir, "index"); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, withCardList(readIndex(dir) || "# For you memory\n", listCards(dir))); };

export function logCardChanges(file: string, changes: { card: string; added: string[]; removed: string[] }[], now = new Date()) {
	const stamp = now.toISOString();
	const lines = changes.flatMap(c => [...c.added.map(l => `${stamp} ${c.card} + ${l}`), ...c.removed.map(l => `${stamp} ${c.card} - ${l}`)]);
	if (lines.length) appendFileSync(file, lines.join("\n") + "\n");
}

/** Overwrite one card with a tidied text (weekly tidy). Returns false when the name is bad or text empty. */
export function writeCard(dir: string, name: string, text: string): boolean {
	const n = cardName(name);
	if (!n || !text.trim()) return false;
	mkdirSync(dirname(cardFile(dir, n)), { recursive: true });
	writeFileSync(cardFile(dir, n), text.trim() + "\n");
	if (n !== "index") refreshIndex(dir);
	return true;
}

/**
 * One-time move from the old single memory.md: "## People" lines become people cards (name before ":"),
 * "## Projects" lines become project cards, everything else stays in the index. Does nothing when
 * memory/ already exists or there is no memory.md.
 */
export function migrateMemory(dir: string, old = join(dir, "memory.md")): boolean {
	if (existsSync(memoryDir(dir)) || !existsSync(old)) return false;
	const text = readFileSync(old, "utf8");
	const keep: string[] = [];
	const cards = new Map<string, string[]>();
	let section = "";
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) section = line.slice(3).trim().toLowerCase();
		const m = line.match(/^[-*]\s+([^:：(]{1,40}?)\s*(?:\(([^)]*)\))?\s*[:：]\s*(.+)$/);
		const kind = section === "people" ? "people" : section === "projects" ? "projects" : "";
		if (kind && m) {
			const name = cardName(`${kind}/${m[1]}`)!;
			cards.set(name, [...(cards.get(name) ?? [`# ${m[1].trim()}${m[2] ? ` (${m[2]})` : ""}`]), `- ${m[3].trim()}`]);
		} else if (kind && cards.size && /^\s+\S/.test(line)) {
			const last = [...cards.keys()].at(-1)!;
			cards.get(last)!.push(`- ${line.trim()}`);
		} else keep.push(line);
	}
	mkdirSync(join(memoryDir(dir), "people"), { recursive: true });
	mkdirSync(join(memoryDir(dir), "projects"), { recursive: true });
	for (const [name, lines] of cards) writeFileSync(cardFile(dir, name), lines.join("\n") + "\n");
	writeFileSync(cardFile(dir, "index"), keep.join("\n").replace(/^## (People|Projects)\n(?=\s*(## |$))/gm, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
	refreshIndex(dir);
	return true;
}

export const tidyPrompt = (name: string, text: string, now: string) => `You keep one memory card for brook's proactive assistant. Today is ${now}.
Rewrite the card "${name}" below so it stays short and true:
- merge duplicate or near-duplicate lines into one (keep the earliest date and the sources)
- drop lines that are clearly outdated or replaced by a newer line
- keep the "# title" first line, keep "- YYYY-MM-DD: fact (from source)" line format, keep any undated base facts
- never invent facts; at most 20 lines
Reply with the full new card text only, no prose, no code fence.

${text}`;

// What brook sees: recent memory changes (from memory.log), how many he has not looked at, and removing one.
export interface MemoryChange { at: string; card: string; op: "+" | "-"; line: string }
export function memoryChanges(dir: string, limit = 40): MemoryChange[] {
	let text = ""; try { text = readFileSync(join(dir, "memory.log"), "utf8"); } catch { return []; }
	const out: MemoryChange[] = [];
	for (const l of text.split("\n")) {
		const m = l.match(/^(\S+) (\S+) ([+-]) (.+)$/);
		if (m && cardName(m[2])) out.push({ at: m[1], card: m[2], op: m[3] as "+" | "-", line: m[4] });
	}
	return out.slice(-limit).reverse();
}
export { markMemorySeen, memorySeenAt, memoryUnseen };

/** The Memory view: every card (index first) and the recent changes. Only this folder; nothing else is readable. */
export function memoryView(dir: string) {
	return { cards: [{ name: "index", text: readIndex(dir) }, ...listCards(dir)].filter(c => c.text.trim()), changes: memoryChanges(dir), seenAt: memorySeenAt(dir), unseen: memoryUnseen(dir) };
}

/** brook removes one line (from the view). Logged like any other change. */
export function removeMemoryLine(dir: string, card: string, line: string, now = new Date()): boolean {
	const ch = applyCardEdits(dir, [{ card, add: [], remove: [line] }], { now });
	if (ch.length) logCardChanges(join(dir, "memory.log"), ch, now);
	return ch.some(c => c.removed.length > 0);
}
