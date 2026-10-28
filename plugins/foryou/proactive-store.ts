import { boardNameFor, readBoard, sendChat } from "../core/chat-board.ts";
import { sessionLabeler } from "../core/session-label.ts";
import { isAutonomy, levelFor, risky, readRules, rulesForPrompt } from "./autonomy.ts";
import { guessKind, type Line, linesForPrompt, liveLines, mergeLines, readLines, trackLine } from "./proactive-lines.ts";
// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { actPrompt, addNote, type Choice, cleanChoices, daemonScript, isOpen, needsYou, parseInbox, paths, pendingItems, publicItem as basePublic, wakeTime, type Item } from "./proactive.ts";
import { focusOttyTab, launchPi, type RemoteMode } from "../core/launch.ts";
import { relayConfigPath } from "../core/hub-paths.ts";
import { recentAutoClosed } from "../core/auto-close.ts";
import { readStatus } from "./session-status.ts";
import { whoFor } from "./who.ts";
import { listCards, memoryDir, readForYouRules, readIndex, withCardList } from "./proactive-memory.ts";

export function readPending(dir?: string): Item[] {
	const { inbox } = paths(dir);
	return existsSync(inbox) ? pendingItems(readFileSync(inbox, "utf8")) : [];
}

const readAll = (dir?: string): Item[] => { const { inbox } = paths(dir); return existsSync(inbox) ? parseInbox(readFileSync(inbox, "utf8")) : []; };

/** Every open loop, needs-you first then newest: what "@" in Pi offers. */
export function readOpen(dir?: string, now = Date.now()): Item[] {
	const all = readAll(dir).filter(isOpen).reverse();
	return [...all.filter(i => needsYou(i, now)), ...all.filter(i => !needsYou(i, now))];
}

/**
 * What the phone's For you page shows: loops that need brook now; loops Pi is on; loops parked for
 * later or waiting on others (with when they come back); what closed in the last day; how many sources are watched.
 */
/**
 * The loop's latest word, for its one comment: the owner session's status line (status.json) when it is newer
 * than the loop's last note, else that note. So a card says where the work stands now, not an old note.
 */
export function latestWord(i: Item, status: { session: string; name?: string; at: string; line: string }[]): { text: string; at: string; by: string } | undefined {
	const notes = String(i.note ?? "").split("\n").filter(Boolean), last = notes.at(-1);
	const m = last?.match(/^- (\d{4}-\d{2}-\d{2}): (.*)$/);
	const note = last ? { text: (m ? m[2] : last.replace(/^- /, "")).replace(/^\d\d-\d\d:?\s+/, ""), at: m ? `${m[1]}T00:00:00Z` : "", by: "note" } : undefined;
	const s = i.session ? status.find(x => x.session === i.session) : undefined;
	const live = s?.line ? { text: s.line, at: s.at, by: s.name || "session" } : undefined;
	// A draft written after the last step is what brook needs to see: it is the newest comment.
	if (i.prepared && i.preparedAt && i.status === "pending" && [live?.at, note?.at].every(t => !t || Date.parse(i.preparedAt!) >= Date.parse(t))) return { text: i.prepared, at: i.preparedAt, by: "prepared" };
	if (live && (!note || Date.parse(live.at) >= Date.parse(note.at || "0"))) return live;
	return note ?? (i.prepared ? { text: i.prepared, at: "", by: "prepared" } : undefined);
}

/** One comment on a loop's post page: who said it, when, what. Kinds: source (the original message), prepared (Pi's draft), note, status (owner session's line), you (brook's own move). */
export interface ThreadEntry { by: string; at: string; text: string; kind: "source" | "prepared" | "note" | "status" | "you" }

/**
 * A loop's whole history as one comment list, oldest first, built from what the inbox already keeps: the source
 * message, the draft, each dated note, the owner session's status line, and brook's own answers and closing move.
 * Shared by the phone post page and the Mac. Capped (30 entries, 600 chars each) to keep the payload small.
 */
export function loopThread(i: Item, status: { session: string; name?: string; at: string; line: string }[] = []): ThreadEntry[] {
	const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 600);
	const sender = i.who?.name || (/^[^:]+:\s*(.{1,40})$/.exec(i.source ?? "") ?? [])[1] || i.source || "Source";
	const start = Date.parse(i.at) || 0, iso = (t: number) => new Date(t).toISOString();
	const out: ThreadEntry[] = [];
	const source = clip([i.why, i.howToRead && !/^[\w-]+-cli\b|^lark-cli|^Feishu meeting/i.test(i.howToRead) ? i.howToRead : ""].filter(Boolean).join(" "));
	if (source) out.push({ by: sender, at: i.at, text: source, kind: "source" });
	if (i.prepared) out.push({ by: "Pi", at: i.preparedAt || i.at, text: i.preparedAt ? i.prepared.trim().slice(0, 4000) : clip(i.prepared), kind: "prepared" });
	for (const raw of String(i.note ?? "").split("\n")) {
		const m = raw.match(/^- (\d{4}-\d{2}-\d{2}): (.*)$/), body = (m ? m[2] : raw.replace(/^- /, "")).trim();
		if (!body || /^Prepared: /.test(body) || /^ongoing$/i.test(body)) continue;
		const at = iso(Math.max(start, m ? Date.parse(`${m[1]}T00:00:00Z`) : start));
		const you = body.match(/^brook (?:said|chose|tapped|asked|replied):?\s*(.*)$/i), who = body.match(/^([\w.-]{1,30}): (.+)$/);
		if (you) out.push({ by: "You", at, text: clip(you[1] || body), kind: "you" });
		else if (who && !/^(Finished|Reminder|Step done|Same card|Handled with)$/i.test(who[1])) out.push({ by: who[1], at, text: clip(who[2]), kind: "note" });
		else out.push({ by: "Pi", at, text: clip(body), kind: "note" });
	}
	const s = i.session ? status.find(x => x.session === i.session) : undefined;
	if (s?.line && !out.some(e => e.text === clip(s.line))) out.push({ by: s.name || "Session", at: s.at, text: clip(s.line), kind: "status" });
	const a = i.suggest?.answer;
	if (a) out.push({ by: "You", at: i.suggest!.answeredAt || i.suggest!.at, text: clip(a === "else" ? i.suggest!.text || "Replied" : { do: "Do it", discuss: "Discuss", later: "Later", no: "No", notnow: "Not now" }[a]), kind: "you" });
	const closed = { done: "Done", dismissed: "Removed", later: "Later" }[i.status as string];
	if (closed && i.at_status) out.push({ by: "You", at: i.at_status, text: closed, kind: "you" });
	// A repeated tap ("Do it" three times) is one comment.
	for (let k = out.length - 1; k > 0; k--) if (out[k].kind === "you" && out.slice(0, k).some(e => e.kind === "you" && e.text === out[k].text)) out.splice(k, 1);
	const sorted = out.map((e, n) => [e, n] as const).sort(([x, n], [y, k]) => (Date.parse(x.at) || 0) - (Date.parse(y.at) || 0) || n - k).map(([e]) => e);
	return sorted.length > 30 ? [sorted[0], ...sorted.slice(-29)] : sorted;
}

export function forYouView(dir?: string, now = Date.now()) {
	const P = paths(dir);
	const all = readAll(dir);
	const status = readStatus(dir);
	const publicItem = (i: Item) => { const w = latestWord(i, status); return { ...basePublic(i), ...(w ? { latest: w } : {}), thread: loopThread(i, status) }; };
	const newest = (a: Item, b: Item) => Date.parse(b.at) - Date.parse(a.at);
	const handled = all.filter(i => !isOpen(i) && now - Date.parse(i.at_status ?? i.at) < 86_400_000).reverse().slice(0, 20);
	const parked = all.filter(i => isOpen(i) && !needsYou(i, now));
	let watching = 0, problems: { text: string; since: string }[] = [];
	try { problems = JSON.parse(readFileSync(P.health, "utf8")).problems ?? []; } catch {}
	try { watching = JSON.parse(readFileSync(P.config, "utf8")).sources?.length ?? 0; } catch {}
	return {
		pending: all.filter(i => needsYou(i, now)).sort(newest).map(publicItem),
		onit: parked.filter(i => i.status === "onit").sort(newest).map(publicItem),
		later: parked.filter(i => i.status !== "onit").sort((a, b) => Date.parse(a.wakeAt ?? "") - Date.parse(b.wakeAt ?? "")).map(publicItem),
		handled: handled.map(publicItem),
		lines: liveLines(dir).map(({ id, name, project, state, next, updated, owner, members, avatar, autonomy, kind }) => {
			const open = all.filter(i => i.line === id && isOpen(i));
			const waitsOnYou = open.some(i => needsYou(i, now));
			// What the line is waiting on, in words: its open loops (title + whether brook or a session holds it).
			const loops = open.slice(0, 5).map(i => ({ id: i.id, title: i.title, you: needsYou(i, now), status: i.status, ...(i.session ? { session: i.session } : {}), ...(i.note ? { last: i.note.split("\n").at(-1)!.replace(/^- [\d-]+: /, "") } : {}) }));
			return { id, name, kind: kind ?? guessKind({ id, name, project }), autonomy: autonomy ?? "", ...(avatar ? { avatar } : {}), ...(project ? { project } : {}), state, next: next ?? "", updated, loops, ...(owner ? { owner } : {}), sessions: [...new Set([owner?.id, ...(members ?? []), ...open.map(i => i.session)].filter((x): x is string => !!x && x !== forYouSession.id))], open: open.length, mode: waitsOnYou ? "you" : open.some(i => i.status === "onit") ? "working" : open.length ? "waiting" : "quiet" };
		}),
		watching,
		problems,
		autoClosed: recentAutoClosed(join(paths(dir).dir, "autoclosed.jsonl"), now).map(({ id, name, summary, at }) => ({ id, name, summary, at })),
	};
}

const write = (dir: string | undefined, line: Record<string, unknown>) => appendFileSync(paths(dir).inbox, JSON.stringify({ ...line, at_status: new Date().toISOString() }) + "\n");

/** ✕: drop a loop for good. Works on any open loop (the phone may show parked ones). */
export function dismissItem(id: string, dir?: string): boolean {
	if (!readAll(dir).some(i => i.id === id && isOpen(i))) return false;
	write(dir, { id, status: "dismissed" });
	return true;
}

/** ✓ Done: brook handled it himself (unlike ✕, this is not "not worth tracking"). */
export function doneItem(id: string, dir?: string): boolean {
	if (!readAll(dir).some(i => i.id === id && isOpen(i))) return false;
	write(dir, { id, status: "done" });
	return true;
}

/**
 * A work session says the whole loop is done: it closes, with the result in its brief (shown under Done).
 * It does not come back as a new card: brook said finished work re-notifying him is noise.
 */
export function finishedItem(id: string, summary: string, dir?: string): boolean {
	const text = summary.replace(/\s+/g, " ").trim();
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!text || !it) return false;
	write(dir, { id, status: "done", wakeAt: null, note: addNote(it.note, `Finished: ${text}`) });
	return true;
}

/** Now: bring a parked or "on it" loop back to "needs you" at once. */
export function nowItem(id: string, dir?: string): boolean {
	if (!readAll(dir).some(i => i.id === id && isOpen(i))) return false;
	write(dir, { id, status: "pending", wakeAt: null });
	return true;
}

/**
 * A step is finished and the next one is brook's: the loop moves forward with a new button and action
 * (e.g. after the Databento test, "Send results to Amber") and comes back to "needs you".
 */
export function nextItem(id: string, step: { button: string; action: string; note?: string; draft?: string }, dir?: string): boolean {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	const button = step.button.replace(/\s+/g, " ").trim().slice(0, 40), action = step.action.replace(/\s+/g, " ").trim().slice(0, 200);
	if (!it || !button || !action) return false;
	const draft = step.draft?.trim().slice(0, 4000);
	write(dir, { id, status: "pending", wakeAt: null, button, action, note: addNote(it.note, step.note?.trim() || `Step done; next: ${action}`), approved: null, ...(draft ? { prepared: draft, preparedAt: new Date().toISOString() } : {}) });
	return true;
}

/** The Otty tab name a loop's session runs under (what launchPi named it). */
export const sessionTabName = (it: Item) => (it.session === forYouSession.id ? forYouSession.name : shortName(it));

/**
 * Open: show the session working on a loop. Focus its tab if one is open, else resume it in a new tab.
 * Changes nothing on the loop. False when no session has the loop.
 */
export async function openItem(id: string, options: { dir?: string; focusTab?: (name: string) => Promise<boolean>; launch?: typeof launchPi; mode?: RemoteMode; home?: string } = {}): Promise<boolean> {
	const it = readAll(options.dir).find(i => i.id === id && isOpen(i));
	if (!it?.session) return false;
	const name = sessionTabName(it);
	if (await (options.focusTab ?? focusOttyTab)(name)) return true;
	const coordinator = it.session === forYouSession.id;
	const cwd = coordinator ? forYouFolder(options.home) : it.sessionCwd ?? (it.project ? expandHome(it.project, options.home) : forYouFolder(options.home));
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(cwd, mode, { sessionId: it.session, name, model: coordinator ? forYouSession.model : undefined, focus: true });
	return true;
}

/** Later: hide a loop until the day before it is due, or tomorrow morning. */
export function laterItem(id: string, dir?: string, now = Date.now()): boolean {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!it) return false;
	const morning = new Date(now + 86_400_000); morning.setHours(9, 0, 0, 0);
	const due = it.due ? wakeTime(it.due, now, 1) : morning.toISOString();
	write(dir, { id, status: it.status === "onit" ? "onit" : "later", wakeAt: due });
	return true;
}

/**
 * A Pi session takes a loop ("@" in Pi, or Do it): the loop is "on it", not done. It closes when
 * the chat shows it is finished (the judge closes it) or brook drops it.
 */
export function takeItem(id: string, session: string, dir?: string, cwd?: string): Item | undefined {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!it) return undefined;
	write(dir, { id, status: "onit", session, wakeAt: null, ...(cwd ? { sessionCwd: cwd } : {}) });
	return it;
}

/** Leave a progress line on a loop's brief (work sessions and the coordinator call this). */
/** For you prepared the next step under the hood: the result goes on the card. */
export function preparedItem(id: string, text: string, dir?: string): boolean {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	const t = text.trim().slice(0, 2000);
	if (!it || !t) return false;
	write(dir, { id, prepared: t, note: addNote(it.note, "Prepared: " + t.replace(/\s+/g, " ").slice(0, 160)) });
	return true;
}

export function noteItem(id: string, text: string, dir?: string): boolean {
	const it = readAll(dir).find(i => i.id === id);
	if (!it || !text.trim()) return false;
	write(dir, { id, note: addNote(it.note, text) });
	return true;
}

/**
 * Cards. Every loop that needs brook shows as a card in the one For you session (Mac and phone),
 * oldest first, one at a time. Nothing runs until he answers; the first answer wins (the loop leaves
 * "needs you"). The judge may suggest a session for the work (`suggest`); the card offers it as a button.
 *   do      = For you does the next step itself
 *   send    = hand it to a session (`to`: a live session id, or "new" in the loop's project)
 *   discuss = For you talks it through with him first, no changes
 *   else    = For you does his own instruction instead
 *   later   = hidden, back in 2 days (morning);  no = he won't do it, the loop closes
 */
export function suggestItem(id: string, session: { id: string; name?: string }, dir?: string, now = new Date()): boolean {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!it || !/^[\w.-]{1,80}$/.test(session.id)) return false;
	write(dir, { id, suggest: { session: session.id, ...(session.name ? { name: session.name } : {}), at: now.toISOString() } });
	return true;
}

/**
 * The coordinator publishes a decision for brook without waiting on him: the loop gets these buttons
 * and comes back to "needs you" as a card (Mac and phone). He can still type his own answer or pick Later.
 */
export function publishChoices(id: string, choices: unknown, o: { question?: string; dir?: string } = {}): boolean {
	const it = readAll(o.dir).find(i => i.id === id && isOpen(i));
	const clean = cleanChoices(choices);
	if (!it || !clean) return false;
	const action = o.question?.replace(/\s+/g, " ").trim().slice(0, 200);
	write(o.dir, { id, status: "pending", wakeAt: null, choices: clean, ...(action ? { action } : {}) });
	return true;
}

export type CardAnswer = "choice" | "send" | "else" | "later" | "no" | "done" | "do" | "discuss";

/**
 * A typed answer that is really a button: "later", "no", "done" (and close typos/translations).
 * These act on the loop directly instead of becoming a task for the model.
 */
export function quickAnswer(text: string | undefined): "later" | "no" | "done" | undefined {
	const t = (text ?? "").trim().toLowerCase().replace(/[.!。！\s]+$/u, "");
	if (/^(later|latter|laters|not now|snooze|tomorrow|稍后|以后|晚点|等等|待会|回头|明天)$/u.test(t)) return "later";
	if (/^(no|nope|skip|drop|ignore|forget it|not important|不|不用|不要|算了|忽略|不重要)$/u.test(t)) return "no";
	if (/^(done|did it|handled|finished|ok done|已完成|完成|搞定|做完了|好了|处理了)$/u.test(t)) return "done";
	return undefined;
}
export const cardLaterDays = 2;
/** A button as the card shows it: the judge's label, and where it runs (session name for display). */
export interface CardChoice { label: string; run: string; name?: string;
	/** What happens when tapped, in plain words: the task the session is given, or what Later/No/Discuss do. */
	task?: string }
/** The plain-words outcome of a button, so brook sees what he is deciding, not only where it goes. */
export function choiceTask(it: Item, c: { run: string; prompt?: string }): string {
	if (c.run === "later") return `Hide it; back in ${cardLaterDays} days`;
	if (c.run === "no") return "Close the loop; nothing is done";
	if (c.run === "discuss") return "For you talks it through with you first; changes nothing";
	return c.prompt || it.action;
}
export interface Card {
	/** 1-based position among waiting cards (the Mac picker can step through them). */
	at?: number; id: string; title: string; why: string; action: string; source: string; kind?: string; autonomy?: string;
	/** Other waiting asks in the same line of work, decided together on this card. */
	when?: string;
	related?: { id: string; title: string; source: string; why: string; kind?: string }[]; line?: string; due?: string; prepared?: string; left: number; choices: CardChoice[];
	/** Where "Send to a session" can hand it: open sessions, the likeliest first ("new" = a session in its project). */
	sessions: { id: string; name: string; cwd?: string; fits?: boolean; hint?: string }[];
	/** What "Send to a session…" hands over. */
	task?: string }

/** Open sessions to hand a loop to: the judge's pick, then ones in the loop's project, then the rest; "new" when it has a project. */
export function sendTargets(it: Item, live: LiveSession[], home = homedir(), label = sessionLabeler()): { id: string; name: string; cwd?: string; fits?: boolean; hint?: string }[] {
	const dir = it.project ? expandHome(it.project, home) : "";
	const near = (s: LiveSession) => it.suggest?.session === s.id ? 0 : dir && s.cwd && (s.cwd === dir || dir.startsWith(s.cwd + "/") || s.cwd.startsWith(dir + "/")) ? 1 : 2;
	const out = live.filter(s => s.id !== forYouSession.id).sort((a, b) => near(a) - near(b)).slice(0, 8).map(s => ({ id: s.id, ...label(s), cwd: s.cwd.replace(home, "~"), ...(near(s) < 2 ? { fits: true } : {}) }));
	return it.project ? [...out, { id: "new", name: "New session", cwd: it.project, ...(out.some(s => s.fits) ? {} : { fits: true }) }] : out;
}

/**
 * The card's main buttons: what the judge wrote for this loop. A button for a session that is not
 * open becomes "new" (a session in the project); no buttons (or none valid) falls back to "Do it here"
 * and, when the judge suggested a live session, "Send to <it>".
 */
export function cardChoices(it: Item, live: LiveSession[], label = sessionLabeler()): (CardChoice & { prompt?: string })[] {
	const others = live.filter(s => s.id !== forYouSession.id);
	const fix = (c: Choice) => ["here", "discuss", "new", "later", "no"].includes(c.run) ? c : others.some(s => s.id === c.run) ? { ...c, name: label(others.find(s => s.id === c.run)!).name } : { ...c, run: "new" };
	const own = (it.choices ?? []).map(fix).filter(c => c.run !== "new" || it.project);
	if (own.length) return own;
	return [{ label: "Do it here", run: "here" }, { label: "Discuss", run: "discuss" }, { label: "Later", run: "later" }];
}

/** The card For you shows now: the oldest loop that needs brook (undefined when none). */
/** All waiting cards, oldest first (the phone flips through them like the Mac's ← →). */
export function waitingCards(dir?: string, live: LiveSession[] = [], now = Date.now(), max = 12): Card[] {
	const n = waitingHeads(dir, now).length;
	return Array.from({ length: Math.min(n, max) }, (_, k) => currentCard(dir, live, now, k)!).filter(Boolean);
}

/** Is this loop still waiting for brook (anywhere in the queue, not only first)? */
export function stillWaiting(id: string, dir?: string, now = Date.now()) { return readAll(dir).some(i => i.id === id && needsYou(i, now)); }

/** Waiting loops, one per line of work: related asks share a card (the oldest leads). */
function waitingHeads(dir: string | undefined, now: number): { it: Item; related: Item[] }[] {
	const all = readAll(dir).filter(i => needsYou(i, now)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const out: { it: Item; related: Item[] }[] = [];
	for (const i of all) {
		const g = i.line ? out.find(h => h.it.line === i.line) : undefined;
		if (g) g.related.push(i); else out.push({ it: i, related: [] });
	}
	return out;
}
/** The other waiting loops that share this loop's card. */
export const relatedWaiting = (id: string, dir?: string, now = Date.now()) => waitingHeads(dir, now).find(h => h.it.id === id)?.related ?? [];

export function currentCard(dir?: string, live: LiveSession[] = [], now = Date.now(), skip = 0): Card | undefined {
	const heads = waitingHeads(dir, now), waiting = heads.map(h => h.it);
	const lineOf = (i: Item) => i.line ? liveLines(dir).find(l => l.id === i.line) : undefined;
	const at = waiting.length ? skip % waiting.length : 0;
	const it = waiting[at];
	if (!it) return undefined;
	const rel = heads[at].related, ln = lineOf(it);
	return { ...(rel.length ? { related: rel.map(r => ({ id: r.id, title: r.title, source: r.source, why: r.why, kind: String(r.sourceKey ?? "").split(":")[0] })) } : {}), ...(ln && rel.length ? { line: ln.name } : {}), ...((it.autonomy ?? ln?.autonomy) ? { autonomy: it.autonomy ?? ln?.autonomy } : {}), at: at + 1, when: it.at, id: it.id, title: it.title, why: it.why, action: it.action, source: it.source, kind: String(it.sourceKey ?? "").split(":")[0], ...(it.due ? { due: it.due } : {}), ...(it.prepared ? { prepared: it.prepared } : {}), left: waiting.length - 1, choices: cardChoices(it, live).map(({ prompt, ...c }) => ({ ...c, task: choiceTask(it, { run: c.run, prompt }) })), sessions: sendTargets(it, live), task: choiceTask(it, { run: "here" }) };
}

/**
 * Record brook's answer and change the loop. `choice` is the index of the button he tapped.
 * Returns what to tell the For you session (`here`), or where to hand the loop (`into`, with
 * `prompt`); undefined when the card is gone or the answer is bad. Every answer is logged.
 */
export function answerCard(id: string, answer: CardAnswer, o: { choice?: number; to?: string; text?: string; by?: string; dir?: string; live?: LiveSession[]; now?: Date } = {}): { item: Item; here?: string; into?: string; note?: string } | undefined {
	const at = o.now ?? new Date();
	const it = readAll(o.dir).find(i => i.id === id && needsYou(i, at.getTime()));
	const text = o.text?.replace(/\s+/g, " ").trim().slice(0, 2000);
	if (answer === "else") answer = quickAnswer(text) ?? "else";
	if (!it || !["choice", "send", "else", "later", "no", "done", "do", "discuss"].includes(answer) || (answer === "else" && !text)) return undefined;
	let c = answer === "choice" ? cardChoices(it, o.live ?? []).at(o.choice ?? -1) : undefined;
	// Nested pick: brook chose an action, then where to run it (here = For you, new, or a session id).
	if (c && o.to && !["later", "no", "discuss"].includes(c.run)) {
		if (!/^[\w.-]{1,80}$/.test(o.to) || (o.to === "new" && !it.project)) return undefined;
		c = { ...c, run: o.to === "here" ? "here" : o.to };
	}
	if (answer === "send" && !(o.to && /^[\w.-]{1,80}$/.test(o.to) && (o.to !== "new" || it.project))) return undefined;
	if (answer === "choice" && (!c || !Number.isInteger(o.choice) || o.choice! < 0)) return undefined;
	appendFileSync(paths(o.dir).judgments, JSON.stringify({ at: at.toISOString(), kind: "card", id, title: it.title, answer, ...(c ? { label: c.label, run: c.run } : {}), ...(answer === "send" ? { to: o.to } : {}), ...(text ? { text } : {}), by: o.by }) + "\n");
	if (c?.run === "later" || c?.run === "no") answer = c.run;
	// The two fixed buttons on every post. Do it: For you decides how (itself, or hands it to the right session). Discuss: talk first.
	if (answer === "do" || answer === "discuss") {
		// The main button is the job's own next step ("Send to wenzhen"): his tap shows under the post with that label,
		// and when it sits on a ready draft it is his approval of exactly that draft.
		const label = answer === "do" ? (it.button || "Do it") : "Discuss";
		const approved = answer === "do" && it.button && it.prepared && it.preparedAt ? it.button : undefined;
		write(o.dir, { id, note: addNote(it.note, `brook tapped: ${label}`), ...(approved ? { approved } : {}) });
		// Do it on a loop whose line has a live owner session: straight to that owner; For you gets a quiet note and keeps tracking.
		const owner = answer === "do" ? workOwner(it, o.live ?? [], o.dir) : undefined;
		if (owner)
			return { item: it, into: owner.id, note: `[decision] brook tapped Do it on loop ${id} ("${it.title}"); it went straight to the ${owner.role} owner ${owner.name} (${owner.id}). Track it; step in if it stalls.` };
		takeItem(id, forYouSession.id, o.dir, forYouFolder());
		const base = actPrompt({ ...it, session: undefined }, paths(o.dir).dir);
		return { item: it, here: answer === "do"
			? `brook tapped "Do it" on loop ${id}. Decide how: do it yourself if it is small, or hand it to the session that owns this work (chat tool handoff). Note each step on the loop (loops tool "note") so his post shows progress; close it with "done" and the result. Never move money or share credentials without asking him; routine replies in an existing conversation follow his message rules (below).\n\n${base}`
			: `brook tapped "Discuss" on loop ${id}. Talk it through with him before doing anything: say briefly what you understand, the options with their tradeoffs, and ask what he wants. Change nothing and send nothing yet.\n\n${base}` };
	}
	// His tap is part of the item's story: it shows under the post as "You: <label>", then the work that follows.
	if (c && !["later", "no"].includes(c.run)) write(o.dir, { id, note: addNote(it.note, `brook tapped: ${c.label}`) });
	else if (answer === "else" && text && !(it.session && it.session !== forYouSession.id)) write(o.dir, { id, note: addNote(it.note, `brook said: ${text}`) });
	const group = relatedWaiting(id, o.dir, at.getTime());
	const all = (patch: Partial<Item>) => { for (const g of [it, ...group]) write(o.dir, { id: g.id, ...patch }); };
	const also = group.length ? `\n\nThe same card also covers these related asks (same line of work); handle them together and close each with its id:\n${group.map(g => `- id=${g.id} from ${g.source}: ${g.title} (${g.why})`).join("\n")}` : "";
	// Every decision reaches For you as one quiet line it sees on its next turn (no turn is started for it).
	const said = (what: string) => `[decision] brook ${what} on loop ${id} ("${it.title}").`;
	if (answer === "later") { const wake = new Date(at.getTime() + cardLaterDays * 86_400_000); wake.setHours(9, 0, 0, 0); all({ status: "later", wakeAt: wake.toISOString() }); return { item: it, note: said(`chose Later (back ${wake.toISOString().slice(0, 10)})`) }; }
	if (answer === "no") { all({ status: "dismissed" }); return { item: it, note: said("removed it") }; }
	if (answer === "done") { all({ status: "done" }); return { item: it, note: said("marked it done") }; }
	// Acting on the card acts on the whole group: the lead carries the related asks; the rest wait on it.
	const take = () => { if (!group.length) return; write(o.dir, { id, note: addNote(it.note, `Same card, handle together: ${group.map(g => `${g.id} ${g.title}`).join("; ")}`) }); for (const g of group) write(o.dir, { id: g.id, status: "waiting", wakeAt: null, note: addNote(g.note, `Handled with ${id} (${it.title})`) }); };
	if (answer === "send") { take(); return { item: it, into: o.to, note: said(`sent it to ${o.to}`) }; }
	// His own words always go to the For you chat, like a normal message; For you forwards to the owner over chat.
	// A comment never opens or resumes a tab by itself.
	if (answer === "else" && it.session && it.session !== forYouSession.id) {
		write(o.dir, { id, note: addNote(it.note, `brook said: ${text}`) });
		return { item: it, here: `brook commented on loop ${id} ("${it.title}"), which ${it.session} owns:\n${text}\n\nAnswer him here. If the owner session must act, forward it to that session over chat (do not open a new tab).\n\n(The loop, for context:)\n${actPrompt(it, paths(o.dir).dir)}` };
	}
	if (c && c.run !== "here" && c.run !== "discuss" && c.run !== "later" && c.run !== "no") {
		if (c.prompt) write(o.dir, { id, action: c.prompt });
		take();
		return { item: it, into: c.run, note: said(`tapped "${c.label}" (runs in ${c.run})`) };
	}
	takeItem(id, forYouSession.id, o.dir, forYouFolder());
	for (const g of group) takeItem(g.id, forYouSession.id, o.dir, forYouFolder());
	const base = actPrompt({ ...it, ...(c?.prompt ? { action: c.prompt } : {}), session: undefined }, paths(o.dir).dir) + also;
	const here = c?.run === "discuss" ? `brook tapped "${c.label}" on loop ${id}. Talk it through with him before doing anything: say briefly what you understand, the options you see with their tradeoffs, and ask what he wants. Change nothing and send nothing yet.\n\n${base}`
		: answer === "else" ? `brook answered loop ${id} with his own instruction. Do this instead of the suggested step:\n${text}\n\n(The loop, for context:)\n${base}`
		: `brook tapped "${c!.label}" on loop ${id}. Do it here.\n\n${base}`;
	return { item: it, here };
}

/** The coordinator: one Pi session that sees every loop, does small ones itself, and hands big ones to work sessions. */
export const forYouSession = { id: "pix-foryou", name: "For you", model: "openai-codex/gpt-6.1-sol" };

/** Where the coordinator runs: home, so it can reach every project by path. */
export const forYouFolder = (home = homedir()) => home;

/** A Pi session connected to Remote, as the hub knows it. */
export interface LiveSession { id: string; name: string; cwd: string; busy?: boolean }

/**
 * Who should do a loop's next step without asking the coordinator. One line can hold several loops, each
 * worked by its own session: the loop's own live session comes first, then the line's owner, else none
 * (For you coordinates).
 */
export function workOwner(it: Item, live: LiveSession[], dir?: string): { id: string; name: string; role: "loop" | "line" } | undefined {
	const isLive = (id?: string) => !!id && id !== forYouSession.id && live.some(l => l.id === id);
	if (isLive(it.session)) return { id: it.session!, name: live.find(l => l.id === it.session)!.name, role: "loop" };
	const owner = it.line ? liveLines(dir).find(l => l.id === it.line)?.owner : undefined;
	if (owner && isLive(owner.id)) return { id: owner.id, name: owner.name ?? owner.id, role: "line" };
	return undefined;
}

/** The line a session works on: the one it owns, else one it was added to (members), else the line of an open loop it holds. */
export function sessionLine(id: string, dir?: string): Line | undefined {
	const lines = liveLines(dir);
	const loopLine = () => readAll(dir).find(i => i.session === id && isOpen(i) && i.line && lines.some(l => l.id === i.line))?.line;
	return lines.find(l => l.owner?.id === id) ?? lines.find(l => l.members?.includes(id)) ?? lines.find(l => l.id === loopLine());
}

export const expandHome = (p: string, home = homedir()) => resolve(p.replace(/^~(?=\/|$)/, home));
const folderName = (dir: string) => dir.split("/").filter(Boolean).pop() || "pi";
const shortName = (it: Item) => (it.title.length > 28 ? `${it.title.slice(0, 27)}…` : it.title);

/**
 * Where a loop's work goes. No `into`: the coordinator (it decides). `into` = a session id
 * (live: queue it there; else resume that id), or "new" (a fresh session in `cwd` or the loop's project).
 */
export function routeFor(it: Item, live: LiveSession[], into?: string, cwd?: string, home = homedir()) {
	const here = { session: forYouSession.id, name: forYouSession.name, cwd: forYouFolder(home), coordinator: true };
	if (!into || into === forYouSession.id) return here;
	if (into === "new") {
		const dir = cwd ?? it.project;
		// A new session is named after its folder (kaji), never after the task title.
		return dir ? { session: `loop-${it.id}`, name: folderName(expandHome(dir, home)), cwd: expandHome(dir, home), coordinator: false } : here;
	}
	const s = live.find(x => x.id === into);
	return { session: into, name: s?.name ?? shortName(it), cwd: s?.cwd ?? (cwd ? expandHome(cwd, home) : it.session === into && it.sessionCwd ? it.sessionCwd : it.project ? expandHome(it.project, home) : forYouFolder(home)), coordinator: false };
}

/**
 * Hand a loop to a session. The main button (phone, pill) sends it to the coordinator, which reads the
 * loop and decides; the coordinator's `loops` tool calls this with `into` to route it elsewhere.
 * A live session gets the task queued (via `send`); otherwise a tab starts or resumes that session id.
 */
export async function actItem(id: string, options: { dir?: string; mode?: RemoteMode; launch?: typeof launchPi; focus?: boolean; focusTab?: (name: string) => Promise<boolean>; send?: (session: string, text: string) => boolean; chat?: typeof sendChat; boardName?: (s: LiveSession) => string | undefined; live?: LiveSession[]; into?: string; cwd?: string; home?: string } = {}): Promise<Item | undefined> {
	const before = readAll(options.dir).find(i => i.id === id && isOpen(i));
	if (!before) return undefined;
	// Do it on a loop whose line has a live owner session goes straight there, not through the coordinator.
	const owner = options.into ? undefined : workOwner(before, options.live ?? [], options.dir);
	const into = options.into ?? owner?.id;
	const route = routeFor(before, options.live ?? [], into, options.cwd, options.home);
	// For you stays in charge: it hears about every job that skipped it (a quiet note, read on its next turn).
	const tellForYou = () => { if (into && !options.into) try { (options.chat ?? sendChat)("pix", "for-you", "note", `brook tapped Do it on loop ${id} "${before.title}" (line ${before.line}); it went straight to the ${owner?.role ?? "line"} owner ${route.name} (${route.session}). Track it; step in if it stalls.`); } catch { /* For you offline: the loop still shows who has it */ } };
	const it: Item = { ...takeItem(id, route.session, options.dir, route.cwd)!, status: "onit", session: route.session, sessionCwd: route.cwd };
	// "Picked up again" only when this same session already had the loop.
	const prompt = route.coordinator ? coordinatorTask(before, options.dir) : actPrompt(before.session === route.session ? it : { ...it, session: undefined }, paths(options.dir).dir);
	// A live session on the chat board gets a chat handoff from For you; its reply comes back to For you.
	const target = route.coordinator ? undefined : (options.live ?? []).find(l => l.id === route.session);
	const boardName = target && (options.boardName ?? boardNameFor)(target);
	if (boardName) {
		(options.chat ?? sendChat)("for-you", boardName, "handoff", prompt);
		write(options.dir, { id, note: addNote(it.note, `Handed to ${boardName} over chat`) });
		tellForYou();
		if (options.focus) await (options.focusTab ?? focusOttyTab)(route.name);
		return it;
	}
	if (options.send?.(route.session, prompt)) {
		tellForYou();
		if (options.focus) await (options.focusTab ?? focusOttyTab)(route.name);
		return it;
	}
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(route.cwd, mode, { prompt, sessionId: route.session, name: route.name, model: route.coordinator ? forYouSession.model : undefined, focus: options.focus });
	return it;
}

/** Start (or resume) the For you session with a prompt, when it is not open. */
export async function startForYou(prompt: string, options: { mode?: RemoteMode; launch?: typeof launchPi; home?: string } = {}) {
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(forYouFolder(options.home), mode, { prompt, sessionId: forYouSession.id, name: forYouSession.name, model: forYouSession.model, focus: false });
}

/** What the coordinator gets when brook taps a loop: the loop, and the choice is its own. */
export const coordinatorTask = (it: Item, dir?: string) => `brook tapped "${it.button || "Do it"}" on loop ${it.id}.

${actPrompt({ ...it, session: undefined }, paths(dir).dir)}

Decide where this is best done: here, in a session already open or already on this loop, or a new session in the project. Use the loops tool to hand it off.`;

/**
 * What the coordinator ("For you" session) knows at the start of each turn, rebuilt from files,
 * so its own chat can stay short: memory (projects and folders), every open loop with its brief,
 * and the Pi sessions open right now. Work stays in per-loop sessions; this is the map.
 */
/** The injected prompt split by "##"/"###" heading, with a rough token size (chars/4 Latin, 1/char CJK). */
export function contextSections(prompt: string): { title: string; tokens: number; text: string }[] {
	const tok = (s: string) => Math.round((s.match(/[\u3000-\u9fff]/g)?.length ?? 0) + s.replace(/[\u3000-\u9fff]/g, "").length / 4);
	return prompt.split(/\n(?=#{2,3} )/).map(s => s.trim()).filter(Boolean).map(s => ({ title: s.match(/^#{2,3} (.+)/)?.[1] ?? "(top)", tokens: tok(s), text: s.slice(0, 4000) }));
}

export function coordinatorContext(dir?: string, live: LiveSession[] = [], now = Date.now()): string {
	const P = paths(dir);
	const memory = existsSync(memoryDir(P.dir)) ? withCardList(readIndex(P.dir), listCards(P.dir)).trim() || "(empty)" : existsSync(P.memory) ? readFileSync(P.memory, "utf8").trim() : "(empty)";
	const open = readOpen(dir, now);
	const loop = (i: Item) => [
		`- id=${i.id}${i.autonomy ? ` <${i.autonomy}>` : ""} [${needsYou(i, now) ? "needs brook" : i.status === "onit" ? "Pi is on it" : i.status}${i.due ? `, due ${i.due}` : ""}${!needsYou(i, now) && i.wakeAt ? `, back ${i.wakeAt.slice(0, 10)}` : ""}] ${i.title} (${i.source})`,
		i.prepared ? `  prepared: ${i.prepared.replace(/\s+/g, " ").slice(0, 200)}` : "",
		i.project ? `  project: ${i.project}` : "",
		i.session ? `  session: ${i.session}${i.session === forYouSession.id ? " (this one)" : ""}` : "",
		i.note ? i.note.split("\n").map(l => `  ${l}`).join("\n") : "",
	].filter(Boolean).join("\n");
	const closed = recentAutoClosed(join(P.dir, "autoclosed.jsonl"), now);
	return `## Who you are: For you
You are not a coding session. You are brook's own assistant, the one who looks ahead for him: you see his chats and mail
(through a filter), every Pi session at work, his lines of work and open loops, and you keep a memory of him.
Treat him with care and respect: his attention is the scarce thing you protect. Be calm, brief and warm; never nag.
- Proactive: notice what is coming, prepare before he asks (read the thread, check the owner session), bring facts or a draft.
- Grow with him: whenever he shows a preference, a priority, how he likes to work, or a fact about a person or project,
  keep it with the loops tool "remember" (foryou for how you should work with him, index for facts about him and his preferences, people/<name>, lines/<line id>). Remove what is
  no longer true. Learn from what he skips or drops. Do this quietly, without announcing it each time.
- Keep the map: move lines of work with the loops tool "line" when their state changes; retire ended ones.
- Speak plainly, in his mix of Chinese and English when he uses it; recommend one next step when there is a clear best.

## Your notebook (read it when you need it; only the essentials are below)
- ${memoryDir(P.dir)}/: memory cards. index.md is shown below; read people/<name>.md or lines/<line id>.md before acting on them.
- ${join(paths(dir).dir, "status.json")}: where every session stands now, one short line each (a cheap model writes it after each turn). Read this first.
- ${activityFile(dir)}: what every Pi session did lately (one JSON line per turn end). Read the tail for "what's going on" or "what did I do today".
- ${P.inbox}: every loop's full history (JSON lines; later lines update earlier ones by id).
- ${P.dir}/lines.json: lines of work. ~/.pi/agent/chat/<name>/me.json: what each session says it is doing.

## Seeing the other sessions (do this before you bring something back to brook)
You can see every open Pi session and what it is saying right now. Look before you act on someone else's work:
- Who is open: curl -s -H "authorization: Bearer $(cat ~/.pi/agent/pix-remote/token)" http://127.0.0.1:8787/api/sessions
  (id, name, folder, busy or idle, its todo).
- What one is saying: same, with /api/sessions/<id>?tail=20 (its last 20 messages).
- Ask its owner: the chat tool, kind "ask". It answers in this chat.
Before you resurface a card or ask brook, check the owner session: it may already be done or in progress.

## Proactive coordinator
You are brook's coordinator for his open loops (things unfinished between him and others). Below is what you know;
use the loops tool to act on loops. How to do each one is your call. Sending follows brook's message rules: a routine reply or update in a conversation and task that already exist may go out directly (exact signature line, exact recipient, read it back, no blind retry). Ask him first only for money, credentials, a new recipient, sensitive personal claims, new commitments, or anything destructive or exposing, or when he asked for a draft first.
Only change a loop (drop, later, handoff) when brook asks or a loop was just tapped; a question is not a request to act.
Routing: prefer the session already on a loop, then an open session in the same project or whose recent work matches
(see the list below); start a new session only when none fits. Never push work into an unrelated session. A busy session
gets the task queued after its current turn; that is fine, do not wait for it.
Decisions: when a loop needs brook to choose, do not ask with a blocking question. Use the loops tool action "choices" to
put 1-3 buttons on his card (labels and routes that fit this loop, your call) and end your turn. He can always type his
own answer or pick Later instead; his answer comes back to you or goes to the session the button names.
Do not start expensive or risky work, or send anything outside the routine-reply rule above, beyond what he already allowed.
Autonomy (his "preferences"): every loop has <do|prepare|discuss>. do = you or the owner do it and report after;
prepare = do the work, put the result on the card (loops "prepared"), wait for his OK; discuss = ask him before any work.
On "create", pass your guess as autonomy; his rules (below) win, unsure = discuss, and money / outbound messages /
credentials / new contacts are never "do" (the tool caps them). When he states a rule ("Kairos replays -> do",
"恩浩 -> prepare", "anything from Lowes -> discuss"), save it with loops action "rule" (scope line|person|type, match, autonomy);
remove one with action "rule" and retire=true. When he changes a loop's level, you get "[autonomy] …": act on it.
Never interrupt: while you and brook are working on something, do not switch to a newly arrived loop. If a new loop is
about the same thing, fold it in quietly ("also, Lowes just asked about the same curve"). Otherwise, when you finish the
current thing, end with one line: "<n> new waiting — next: <the most urgent one>. Show it?" Only something due today, or
someone blocked on him right now, may break in, and then as one line, not a full card.
Related loops: loops in the same line of work are one card for brook and one decision; handle them together.
New messages: a cheap filter reads brook's chats and mail and forwards to you what may matter ("[For you: new messages …]").
You are the one who decides: update what is already tracked, ignore what is not his, create cards (loops tool "create") for
what needs him, hand work to sessions, keep lines and memory current. Answer each batch in one short message.
Tracking: every line has an owner session; when that session ends a turn its status is recorded on the line and its
loops (you see it below). To hand work to a live session or ask what it is doing, use the chat tool (send kind "handoff"
or "ask" to its board name); its reply comes back to you. New messages about a line go to that line's owner, not a new session.
Reminders: when brook asks to be reminded, use the loops tool "remind" with an exact time; a note alone never fires.
Sending outward: a routine reply in an existing chat and task goes out under the rule above (asks of brook, @mentions and
DMs get a routed reply task, not only a card). For anything outside it, ask brook on the card with two buttons:
"Send now" (the owner sends it as drafted) and "Show me first" (you show the exact text; he edits or approves).
The whole picture: you know every open job (below). When he asks "what's next", "what's left", or similar, answer from it:
1. Recommend the ONE thing to do now and why (due soonest, blocks others, or he is waiting on it), then offer to do it
   (put buttons on its card with the loops tool action "choices", or just ask "Do it?").
2. Then the rest, short, grouped: needs you · Pi on it (which session) · waiting / later (when it comes back).
Be proactive: when you finish a task or a thread ends, close with one line, "Next: <the next job> — do it?".
He can also just chat with you about a card ("why this?", "send it to pix", "merge with the other one"): answer, and use
the loops tool when he asks for a change.

### Autonomy rules (brook's; ~/.pix/proactive/autonomy-rules.json, change with loops "rule")
${rulesForPrompt(readRules(paths(dir).dir))}

### Lines of work (the map; ~/.pix/proactive/lines.json, edit it when brook asks)
${linesForPrompt(readLines(dir), open)}
${closed.length ? `\n### Auto-closed idle sessions (last 24h; still in Resume). Tell brook once, in one line: "closed ${closed.length} idle session${closed.length > 1 ? "s" : ""}"\n${closed.map(c => `- ${c.name} (${c.id}): ${c.summary}`).join("\n")}\n` : ""}
### How you work with brook (memory/foryou.md: your operating rules; follow them, keep them current with loops "remember" card=foryou)
${readForYouRules(P.dir).replace(/^# .*\n/, "").trim() || "(none yet)"}

### Memory (index: facts about brook, people, projects)
${memory}

### Open loops
${open.map(loop).join("\n") || "(none)"}

### The card on brook's screen now
${(() => { const c = currentCard(dir, live, now); return c ? `id=${c.id} "${c.title}" (${c.left} more after it). When he talks about "this" or "the card", he means this loop.
Its buttons: ${c.choices.map(x => `"${x.label}" -> ${x.run}`).join(", ")}; plus Later, No, Something else.` : "(none)"; })()}

### Pi sessions open now
${live.map(s => `- ${s.name} (${s.id}) in ${s.cwd}${s.busy ? ", busy" : ""}`).join("\n") || "(none known)"}

### Session board (chat): what each live session says it is doing
${readBoard().filter(b => b.name !== "for-you").map(b => `- ${b.name}${b.session ? ` (${b.session})` : ""} in ${b.cwd}: ${b.doing || b.status || "(nothing posted)"}${b.claims?.length ? `; claims ${b.claims.slice(0, 4).join(", ")}` : ""}`).join("\n") || "(empty)"}`;
}

/** One line from a turn's last reply: its first sentence or line, plain. */
export const turnStatus = (text: string) => text.replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim().split(/(?<=[.!?。！？])\s/)[0].slice(0, 200);

/**
 * Tracking without asking the agent: when a session that owns open loops ends a turn, each loop gets a short note
 * of where it stands, and its line records this session as owner with the same status. Returns the loop ids touched.
 */
export function trackTurn(session: { id: string; name?: string; cwd?: string }, lastText: string, dir?: string, now = new Date()): string[] {
	const status = turnStatus(lastText);
	if (!status) return [];
	logActivity({ at: now.toISOString(), session: session.name ?? session.id, ...(session.cwd ? { cwd: session.cwd } : {}), did: status }, dir);
	const mine = readAll(dir).filter(i => i.session === session.id && i.status === "onit");
	for (const i of mine) {
		const last = i.note?.split("\n").at(-1) ?? "";
		if (!last.endsWith(status)) write(dir, { id: i.id, note: addNote(i.note, `${session.name ?? "session"}: ${status}`, now) });
	}
	// Several sessions may work loops on one line. The line keeps its owner while that owner still holds an open
	// loop there; another session's turn updates only its own loops (it takes the line only when the owner left).
	const all = readAll(dir), lines = liveLines(dir);
	const keeps = (line: string) => { const o = lines.find(l => l.id === line)?.owner; return !!o && o.id !== session.id && all.some(i => i.line === line && i.session === o.id && i.status === "onit"); };
	for (const line of new Set(mine.map(i => i.line).filter(Boolean) as string[])) if (!keeps(line)) trackLine(line, { id: session.id, ...(session.name ? { name: session.name } : {}), status }, dir, now.toISOString());
	return mine.map(i => i.id);
}

/** For you creates a loop itself (the new flow: the filter forwards, For you decides). */
export function createItem(a: { autonomy?: string; title: string; why: string; action?: string; source: string; sourceKey?: string; howToRead?: string; refs?: string[]; line?: string; project?: string; due?: string; choices?: Choice[]; prepared?: string; quiet?: boolean; who?: string }, dir?: string, now = new Date()): Item | undefined {
	const title = a.title?.trim(), why = a.why?.trim();
	if (!title || !why || !a.source?.trim()) return undefined;
	const it: Item = {
		id: Math.random().toString(16).slice(2, 10), at: now.toISOString(), title: title.slice(0, 80), why: why.slice(0, 200), action: (a.action ?? "").trim().slice(0, 300) || title,
		source: a.source.trim().slice(0, 80), sourceKey: a.sourceKey ?? "", howToRead: a.howToRead ?? "", refs: (a.refs ?? []).map(String).slice(0, 20), status: "pending",
		...(a.line ? { line: a.line } : {}), ...(a.project ? { project: a.project } : {}), ...(a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? { due: a.due } : {}),
		...(a.prepared?.trim() ? { prepared: a.prepared.trim().slice(0, 4000) } : {}), ...(a.quiet ? { quiet: true } : {}),
		...(a.who?.trim() ? { who: whoFor(a.who, a.source, a.sourceKey) } : {}),
	};
	const clean = cleanChoices(a.choices ?? []);
	if (clean?.length) it.choices = clean;
	const lv = levelFor({ ...it, line: a.line }, isAutonomy(a.autonomy) ? a.autonomy : undefined, readRules(paths(dir).dir));
	it.autonomy = lv.level; it.autonomyWhy = lv.why;
	appendFileSync(paths(dir).inbox, JSON.stringify(it) + "\n");
	return it;
}

/** A real reminder: the loop comes back as a card at `at` (reopened if it was done). A note is not a reminder. */
export function remindItem(id: string, at: string, text: string, dir?: string, now = new Date()): boolean {
	const it = readAll(dir).find(i => i.id === id);
	const t = Date.parse(at);
	if (!it || !Number.isFinite(t) || t <= now.getTime()) return false;
	write(dir, { id, status: "later", wakeAt: new Date(t).toISOString(), ...(text.trim() ? { action: text.trim().slice(0, 300) } : {}), note: addNote(it.note, `Reminder set for ${new Date(t).toISOString()}: ${text.trim()}`) });
	return true;
}

/** The notebook's activity page: what every session did lately (one line per turn end), newest last; kept to 500 lines. */
export const activityFile = (dir?: string) => join(paths(dir).dir, "activity.jsonl");
export function logActivity(e: { at: string; session: string; cwd?: string; did: string }, dir?: string): void {
	const f = activityFile(dir);
	const old = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
	writeFileSync(f, [...old.slice(-499), JSON.stringify(e)].join("\n") + "\n");
}

/** Merge lines into one job: every open loop of the `from` lines moves to `into`; the old lines retire. */
export function mergeJobLines(from: string[], into: { id: string; name?: string; state?: string; project?: string }, dir?: string): string[] | undefined {
	return mergeLines(from, into, (old, to) => {
		const moved = readAll(dir).filter(i => i.line === old && isOpen(i));
		for (const i of moved) write(dir, { id: i.id, line: to });
		return moved.map(i => i.id);
	}, dir);
}


/** brook changed a loop's level (tap on the chip): store it. Returns the new level, or undefined for no such open loop. */
export function setItemAutonomy(id: string, level: string | undefined, dir?: string): { level: "do" | "prepare" | "discuss"; capped: boolean } | undefined {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!it) return undefined;
	const order = ["do", "prepare", "discuss"] as const;
	let next = isAutonomy(level) ? level : order[(order.indexOf(it.autonomy ?? "discuss") + 1) % 3];
	// Money, outbound, credentials, new contacts: never "do", even by tap (the cycle skips it).
	const capped = next === "do" && risky([it.title, it.why, it.action].join(" "));
	if (capped) next = isAutonomy(level) ? "prepare" : order[(order.indexOf(next) + 1) % 3];
	write(dir, { id, autonomy: next, autonomyWhy: "brook" });
	return { level: next, capped };
}
