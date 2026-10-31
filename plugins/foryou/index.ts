import { setInjected } from "../core/injected-context.ts";
import { boardNameFor } from "../core/chat-board.ts";
/**
 * The For you coordinator: one Pi session (id "pix-foryou") that looks after brook's open loops.
 * It gets a map of what is open each turn, plus one `loops` tool, and decides the rest itself:
 * do a loop here, hand it to a session already open or already on it, or start one in a project.
 * In every other session this extension does nothing.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { LOOP_MESSAGE, loopMessage, loopPromptSummary, quietSummary } from "../core/loop-message.ts";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { applyCardEdits, lineMemory, logCardChanges } from "./proactive-memory.ts";
import { FACE_NAMES } from "../core/job-faces.ts";
import { addRule, removeRule, rulesForPrompt } from "./autonomy.ts";
import { AUTONOMY, KINDS, applyLineEdits, parseLineEdits, readLines, slug, writeLines } from "./proactive-lines.ts";
import { paths as proactivePaths } from "./proactive.ts";
import { summarizeTurn } from "./session-status.ts";
import { forYouView, mergeJobLines, readOpen, actItem, preparedItem, finishedItem, answerCard, currentCard, stillWaiting, quickAnswer, coordinatorContext, dismissItem, doneItem, forYouSession, sessionLine, publishChoices, laterItem, nextItem, noteItem, trackTurn, createItem, remindItem, type LiveSession } from "./proactive-store.ts";
import type { CardAnswer } from "./proactive-store.ts";
import { registerHubPlugin } from "../core/hub-plugin.ts";
import { forYouHub, forYouRelayAllowed } from "./hub.ts";
import { expandForYou, withForYou } from "./foryou-mention.ts";
import { remoteDefaultPort, remoteTokenPath } from "../core/hub-paths.ts";
import { isBrookText, markBrookActive } from "../core/foryou-queue.ts";
import { livePrompt, readLive, takeLive } from "./live-strip.ts";
import { forYouLines, forYouRows } from "./for-you-list.ts";
import { paths } from "./proactive.ts";
import { existsSync as foldExists, rmSync as foldRm, writeFileSync as foldWrite } from "node:fs";
import { join as foldJoin } from "node:path";
/** ctrl+\\ folds the Mac For you list to its header; a marker file keeps it across renders and reloads. */
/** How long "removed, u undo" stays before the removal is written. */
export const UNDO_MS = 5_000;
export const FOLD_KEY = "ctrl+\\";
const foldFile = (dir?: string) => foldJoin(paths(dir).dir, "list-folded");
export const readFolded = (dir?: string) => foldExists(foldFile(dir));
export const toggleFolded = (dir?: string) => { if (readFolded(dir)) foldRm(foldFile(dir), { force: true }); else foldWrite(foldFile(dir), ""); };
import { waitingHeads } from "./proactive-store.ts";
import { createLiveFocus, type LiveAction } from "./live-focus.ts";

const TOOL = "loops";
const MEMORY_TOOL = "memory";
const JOB_TOOL = "job";

/** Live Pi sessions from the Remote hub; empty when it is not running. */
async function hubSessions(): Promise<LiveSession[]> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
		return res.ok ? await res.json() : [];
	} catch { return []; }
}

/** Hand off through the hub when it runs (it can queue into live sessions); else start directly. */
async function handOff(id: string, into: string, cwd?: string): Promise<boolean> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/act`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ into, ...(cwd ? { cwd } : {}) }), signal: AbortSignal.timeout(5000) });
		if (res.ok) return true;
	} catch { /* no hub */ }
	// No hub, or the hub keeps another list (tests, PIX_PROACTIVE_DIR): act directly.
	return !!(await actItem(id, { into, cwd }));
}

export interface ForYouDeps { summarize?: typeof summarizeTurn; sessions?: () => Promise<LiveSession[]>; handOff?: typeof handOff; answer?: typeof answerViaHub; dir?: string; cardPollMs?: number; badge?: (waiting: boolean) => void }

/** Answer through the hub when it runs (it queues work into sessions and updates the phone). */
async function answerViaHub(id: string, body: { answer: CardAnswer; choice?: number; to?: string; text?: string }): Promise<"ok" | "gone" | "nohub"> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/card`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, by: "mac" }), signal: AbortSignal.timeout(8000) });
		return res.ok ? "ok" : res.status === 409 ? "gone" : "nohub";
	} catch { return "nohub"; }
}

/** Cmd+Shift+Y (Otty sends Cmd as super via the kitty keyboard protocol; plain Cmd+Y is Otty's Redo). */
export const CARD_KEY = "super+shift+y";
export const CARD_ALL = "All unfinished ›";

/** The hand icon on the For you tab in Otty's sidebar while a card waits (like the phone). */
/** One line per card UI event in ~/.pix/proactive/card-ui.log, so a misbehaving card can be traced later. */
export function cardLog(dir: string | undefined, event: string, data: Record<string, unknown> = {}) {
	try { appendFileSync(join(dir ?? join(homedir(), ".pix", "proactive"), "card-ui.log"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n"); } catch { /* logging never breaks the card */ }
}

export function ottyBadge(waiting: boolean, run: (cmd: string, args: string[]) => void = (c, a) => { try { execFile(c, a, () => {}); } catch { /* no otty */ } }, pane = process.env.OTTY_PANE_ID) {
	if (!pane) return;
	run("otty", ["pane", "badge", pane.startsWith("p_") ? pane : `p_${pane}`, ...(waiting ? ["--kind", "awaiting-input"] : ["--clear"])]);
}
export const CARD_LATER = "Later", CARD_NO = "Not important, forget it", CARD_ELSE = "Something else…";
/** How a judge-written button reads in the Mac picker: where it runs, when that is another session. */
export const choiceLabel = (c: { label: string; run: string; name?: string }) => ["here", "discuss", "later", "no"].includes(c.run) ? c.label : c.run === "new" ? `${c.label} (new session) ›` : `${c.label} (${c.name ?? c.run}) ›`;

/** The waiting card as a few short lines above the editor. */
/** Every unfinished loop, one line each, for the list brook opens himself (⌘⇧Y when no card waits, or from the card). */
export function unfinishedLines(v: { pending?: any[]; onit?: any[]; later?: any[]; lines?: { id: string; name: string }[] }): { id: string; label: string; tasks?: string[] }[] {
	const day = (t: string) => t ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
	const row = (i: any, tag: string) => ({ id: i.id, label: `${tag.padEnd(9)} ${i.title}${i.due ? `, due ${day(i.due)}` : ""}${tag === "later" && i.wakeAt ? `, back ${day(i.wakeAt)}` : ""}` });
	const tagged = [...(v.pending ?? []).map(i => [i, "needs you"] as const), ...(v.onit ?? []).map(i => [i, "on it"] as const), ...(v.later ?? []).map(i => [i, "later"] as const)];
	// One row per job: a line with 2+ unfinished loops is one row ("Kairos launch, 3 tasks, 2 need you"), at its first loop's place.
	const jobs = new Map<string, (typeof tagged)[number][]>();
	for (const t of tagged) if (t[0].line && v.lines?.some(l => l.id === t[0].line)) jobs.set(t[0].line, [...(jobs.get(t[0].line) ?? []), t]);
	const out: { id: string; label: string; tasks?: string[] }[] = [], done = new Set<string>();
	for (const t of tagged) {
		const g = t[0].line ? jobs.get(t[0].line) : undefined;
		if (!g || g.length < 2) { out.push(row(...t)); continue; }
		if (done.has(t[0].line)) continue;
		done.add(t[0].line);
		const you = g.filter(x => x[1] === "needs you").length, name = v.lines!.find(l => l.id === t[0].line)!.name;
		out.push({ id: `line:${t[0].line}`, label: `${(you ? "needs you" : t[1]).padEnd(9)} ${name}, ${g.length} tasks${you ? `, ${you} need you` : ""}`, tasks: g.map(x => `${x[0].id}: ${x[0].title} (${x[1]})`) });
	}
	return out;
}

export const cardLines = (it: { line?: string; related?: unknown[]; title: string; why?: string; source: string; left: number; choices: { label: string; run: string; name?: string }[] }) => [
	`● ${((t: string) => t.length > 60 ? `${t.slice(0, 59)}…` : t)(it.line && it.related?.length ? `${it.line}, ${it.related.length + 1} tasks` : it.title)}${it.left ? `  +${it.left}` : ""}   Tab`,
];

/** A session to hand the task to, as one option in the card's list. */
export const sendLabel = (x: { id: string; name: string; cwd?: string; hint?: string }) => x.id === "new" ? `Do it in a new session (${x.cwd ?? "project"}) ›` : `Do it in ${x.name}${x.hint ? `, ${x.hint}` : ""} ›`;

/** The card in the Mac picker: what it is, then what each button would do (so the decision is clear). */
export const cardTitle = (it: { autonomy?: string; line?: string; related?: { title: string }[]; prepared?: string; title: string; why?: string; source: string; left: number; at?: number; action?: string; task?: string; choices: { label: string; run: string; name?: string; task?: string }[] }) => [
	...(it.line && it.related?.length ? [`${it.line}, ${it.related.length + 1} tasks`, `  • ${it.title}`, ...it.related.map(r => `  • ${r.title}`), ""] : [it.title]),
	`${it.source}${it.autonomy ? `, ${it.autonomy}` : ""}${it.left ? `, ${it.at ?? 1} of ${it.left + 1}   ← → more cards` : ""}`,
	"",
	...(it.why ? [it.why, ""] : []),
	...(it.prepared ? [`Prepared: ${it.prepared}`, ""] : []),
	...(it.task ?? it.action ? [`Plan: ${it.task ?? it.action}`] : []),
].join("\n");

/** A short reply in the For you editor that answers the waiting card: a button number or later/no/done. */
export function cardReply(text: string, buttons: number): { answer: CardAnswer; choice?: number; text?: string } | undefined {
	const t = text.trim();
	const n = /^\d$/.test(t) ? Number(t) : NaN;
	if (n >= 1 && n <= buttons) return { answer: "choice", choice: n - 1 };
	return quickAnswer(t) ? { answer: "else", text: t } : undefined;
}

const memoryDirOf = (dir?: string) => proactivePaths(dir).dir;

/** The cheap model for session status: the filter's model from config.json (cfg.statusModel overrides; "" turns it off). */
function statusModel(dir?: string): string | undefined {
	try { const c = JSON.parse(readFileSync(join(proactivePaths(dir).dir, "config.json"), "utf8")); return c.statusModel ?? c.model; } catch { return undefined; }
}

export default function (pi: ExtensionAPI, deps: ForYouDeps = {}) {
	// The phone side: the bell page, cards on the For you session, and its /api/foryou routes.
	registerHubPlugin("foryou", forYouHub(), forYouRelayAllowed);
	const isCoordinator = (ctx: any) => ctx?.sessionManager?.getSessionId?.() === forYouSession.id;
	let isForYouProcess = false;
	const sessions = deps.sessions ?? hubSessions;

	// Line sessions share For you's memory: the same cards, the same log, saved with this session's name as source.
	pi.registerTool({
		name: MEMORY_TOOL,
		label: "Memory",
		description: "Keep a lasting fact in brook's shared memory (the one For you and every line session read). Cards: lines/<your line id> for facts about your line of work, people/<name> for a person, index for facts about brook. Only lasting facts (decisions, roles, preferences, results); not progress, todos, or which session does what. Check the memory above first; do not repeat a fact already there.",
		parameters: Type.Object({
			card: Type.String({ description: "lines/<line id>, people/<name>, or index" }),
			add: Type.Optional(Type.Array(Type.String(), { description: "short lasting facts to add" })),
			remove: Type.Optional(Type.Array(Type.String(), { description: "exact lines no longer true" })),
		}),
		async execute(_id, p, _signal, _update, ctx: any) {
			const who = ctx?.sessionManager?.getSessionName?.() || ownedLine(ctx)?.owner?.name || "a line session";
			const ch = /^(lines|people)\/|^index$/.test(p.card) ? applyCardEdits(memoryDirOf(deps.dir), [{ card: p.card, add: p.add ?? [], remove: p.remove ?? [] }], { source: who }) : [];
			if (ch.length) logCardChanges(proactivePaths(deps.dir).memoryLog, ch);
			return { content: [{ type: "text" as const, text: ch.length ? `Remembered on ${ch[0].card} (+${ch[0].added.length} -${ch[0].removed.length}).` : "Nothing changed (card must be lines/<id>, people/<name> or index; give lines to add or remove)." }], details: {} };
		},
	});

	// A line session updates its own jobs' posts (the loops on its line), like For you does: progress, a draft back to brook, done.
	pi.registerTool({
		name: JOB_TOOL,
		label: "Job",
		description: "Update a job (loop) on your line so brook's post shows where it stands. note: progress while you work. next: this step is done and brook decides next; give the button he taps (e.g. 'Send to wenzhen') and, if you prepared something to send, the exact draft text (shown as the newest comment). finished: the whole job is done. Only loops on your own line.",
		parameters: Type.Object({
			id: Type.String({ description: "loop id" }),
			action: StringEnum(["note", "next", "finished"] as const),
			text: Type.String({ description: "note: progress; next: what is done; finished: one-line summary" }),
			button: Type.Optional(Type.String({ description: "next: 1-3 word button for brook" })),
			step: Type.Optional(Type.String({ description: "next: what happens when he taps it" })),
			draft: Type.Optional(Type.String({ description: "next: exact text to send, if any" })),
		}),
		async execute(_id, p, _signal, _update, ctx: any) {
			const line = ownedLine(ctx);
			const it = readOpen(deps.dir).find(i => i.id === p.id);
			const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (!line || !it) return say(`No open loop ${p.id}.`);
			if (it.line !== line.id) return say(`Loop ${p.id} is on another line (${it.line ?? "none"}); ask For you.`);
			const ok = p.action === "note" ? noteItem(p.id, p.text, deps.dir)
				: p.action === "finished" ? finishedItem(p.id, p.text, deps.dir)
				: nextItem(p.id, { button: p.button ?? "", action: p.step ?? p.button ?? "", note: p.text, draft: p.draft }, deps.dir);
			return say(ok ? `Updated ${p.id} (${p.action}).` : `Nothing changed (next needs a button).`);
		},
	});

	pi.registerTool({
		name: TOOL,
		label: "Loops",
		description: "Act on brook's open loops (For you). remind: bring a loop back as a card at an exact time (at, text = what to remind). remember: keep a lasting fact about brook (preference, person, project) on a memory card. line: create, move or retire a line of work (id or name, state, step = next); merge = other line ids to fold into it (one job: their loops become its tasks, one card). A line is a job: file every loop of the same job under one line, so brook sees one card with tasks, not many cards. create: put a new card on brook's For you (title, why, source, sourceKey, howToRead, refs, line, optional due, choices, text = what you prepared, step = the next step). prepared: the result of preparing a new loop under the hood (text = the draft or facts brook will see on the card). handoff: send a loop to another Pi session (an open one by id, the one already on it, or \"new\" in a folder). note: add a progress line to a loop's brief. finished: the whole loop is done (text = what was done); it goes back to brook once to check and close. next: a step is finished and the next one is brook's; give the new button (1-3 word outcome, e.g. \"Send results to Amber\") and next step, and it comes back to him. choices: brook must decide; put 1-3 buttons (label + run: here|discuss|<session id>|new|later|no, optional prompt) and an optional question on his card, then end your turn without waiting (he can also type his own answer or pick Later). later: park it until near its due date. done: brook handled it. drop: not worth tracking.",
		parameters: Type.Object({
			action: StringEnum(["remind", "remember", "rule", "line", "create", "prepared", "handoff", "note", "next", "finished", "choices", "later", "done", "drop"] as const),
			id: Type.Optional(Type.String({ description: "Loop id (not for create)" })),
			at: Type.Optional(Type.String({ description: "remind: ISO time with timezone, when the card comes back" })),
			card: Type.Optional(Type.String({ description: "remember: the memory card: foryou (your own operating rules: how to work with brook, approvals, style, autonomy defaults), index (facts about brook), people/Knight, lines/<line id> (facts about one line of work)" })),
			add: Type.Optional(Type.Array(Type.String(), { description: "remember: short lasting facts to add" })),
			remove: Type.Optional(Type.Array(Type.String(), { description: "remember: exact lines no longer true" })),
			name: Type.Optional(Type.String({ description: "line: 2-4 words (new line)" })),
			state: Type.Optional(Type.String({ description: "line: where it stands now" })),
			retire: Type.Optional(Type.Boolean({ description: "line: it has ended" })),
			kind: Type.Optional(Type.String({ description: "line: its broad category, one of: " + KINDS.join(", ") + " (research = models, evals, data; launch = product and go-to-market; phd = school, papers, reviews, advisor; personal = friends, life; admin = accounts, tools, money, paperwork). Set it on every line; the phone colours by it." })),
			avatar: Type.Optional(Type.String({ description: "line: the job's face on the phone, one of: " + FACE_NAMES.join(", ") + ". Pick what fits the job (rocket = launch, owl = review/eval, hamster or chart = data, cap = study, sprout = training); give every line one; change it when the job changes" })),
			autonomy: Type.Optional(StringEnum(AUTONOMY, { description: "line, rule, create: how much may happen without brook: do (just do it, report after), prepare (do read-only/draft work, put it on the card), discuss (ask first). Set when brook states a preference for this job." })),
			scope: Type.Optional(StringEnum(["line", "person", "type"] as const, { description: "rule: what it matches: a line id, a person/source name, or a work-type word (e.g. replay)" })),
			match: Type.Optional(Type.String({ description: "rule: the line id, person name, or work-type word" })),
			join: Type.Optional(Type.Array(Type.String(), { description: "line: session ids to add to this line (they belong to it without owning it or holding a loop)" })),
			leave: Type.Optional(Type.Array(Type.String(), { description: "line: session ids to remove from this line" })),
			merge: Type.Optional(Type.Array(Type.String(), { description: "line: ids of lines to merge into this one (id, or name for a new line); their loops become tasks of one job card" })),
			title: Type.Optional(Type.String({ description: "create: <=60 chars, the piece of work" })),
			why: Type.Optional(Type.String({ description: "create: <=120 chars, why it needs brook" })),
			source: Type.Optional(Type.String({ description: "create: the source name, as in the forwarded message" })),
			who: Type.Optional(Type.String({ description: "create: the one person who needs brook (as named in the message, e.g. Lowes, 陈老师); omit for Pi's own work" })),
			sourceKey: Type.Optional(Type.String({ description: "create: the source key, as in the forwarded message" })),
			howToRead: Type.Optional(Type.String({ description: "create: how to read the original messages" })),
			refs: Type.Optional(Type.Array(Type.String(), { description: "create: message ids" })),
			line: Type.Optional(Type.String({ description: "create: the line id it belongs to: the existing line of the same project or topic. Omit it when none truly fits (personal and social asks from friends or family never go in a work line); loops of the same job share one line so brook sees one job card. Make a new line only for a new lasting job." })),
			project: Type.Optional(Type.String({ description: "create: project folder" })),
			due: Type.Optional(Type.String({ description: "create: YYYY-MM-DD" })),
			into: Type.Optional(Type.String({ description: "handoff: a session id, or \"new\"" })),
			cwd: Type.Optional(Type.String({ description: "handoff into \"new\": the project folder (default: the loop's project)" })),
			text: Type.Optional(Type.String({ description: "note: the progress line; next: what is done" })),
			button: Type.Optional(Type.String({ description: "next: the new main button, 1-3 words naming the outcome" })),
			choices: Type.Optional(Type.Array(Type.Object({ label: Type.String(), run: Type.String({ description: "here, discuss, a session id, new, later, or no" }), prompt: Type.Optional(Type.String()) }), { description: "choices: the card's buttons" })),
			question: Type.Optional(Type.String({ description: "choices: what brook is deciding, one line" })),
			step: Type.Optional(Type.String({ description: "next: the next step" })),
		}),
		async execute(_id, p) {
			const done = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (p.action === "remember") {
				const ch = p.card ? applyCardEdits(memoryDirOf(deps.dir), [{ card: p.card, add: p.add ?? [], remove: p.remove ?? [] }], { source: "For you" }) : [];
				if (ch.length) logCardChanges(proactivePaths(deps.dir).memoryLog, ch);
				return done(ch.length ? `Remembered on ${ch[0].card} (+${ch[0].added.length} -${ch[0].removed.length}).` : "Nothing changed (name a card, and lines to add or remove).");
			}
			if (p.action === "rule") {
				const pd = proactivePaths(deps.dir).dir;
				if (p.retire) return done(p.match && removeRule(pd, p.match, p.scope) ? `Rule "${p.match}" removed.` : "No such rule.");
				if (!p.match || !p.scope || !p.autonomy) return done("rule needs scope (line|person|type), match and autonomy.");
				return done(`Rule saved: ${p.scope} "${p.match}" -> ${p.autonomy}. Rules now:\n${rulesForPrompt(addRule(pd, { scope: p.scope, match: p.match, level: p.autonomy }))}`);
			}
			if (p.action === "line" && p.merge?.length) {
				const id = p.id ?? (p.name ? slug(p.name) : "");
				const moved = id ? mergeJobLines(p.merge, { id, name: p.name, state: p.state, project: p.project }, deps.dir) : undefined;
				return done(moved ? `Merged ${p.merge.join(", ")} into ${id}; ${moved.length} loop(s) moved. They now show as tasks of one job.` : "Nothing merged (name existing lines in merge, and an id or name for the target).");
			}
			if (p.action === "line") {
				const edits = parseLineEdits([{ id: p.id ?? p.name, name: p.name, state: p.state, next: p.step, project: p.project, retire: p.retire, kind: p.kind, avatar: p.avatar, autonomy: p.autonomy, join: p.join, leave: p.leave }]);
				const r = applyLineEdits(readLines(deps.dir), edits);
				if (r.changed.length) writeLines(r.lines, deps.dir);
				return done(r.changed.length ? `Line ${r.changed[0]} updated.` : "No change (a new line needs name and state).");
			}
			if (p.action === "create") {
				const it = createItem({ title: p.title ?? "", why: p.why ?? "", action: p.step, source: p.source ?? "", sourceKey: p.sourceKey, howToRead: p.howToRead, refs: p.refs, autonomy: p.autonomy, line: p.line, project: p.project, due: p.due, choices: p.choices, prepared: p.text, who: p.who }, deps.dir);
				return done(it ? `Card ${it.id} is on brook's For you (${it.autonomy}: ${it.autonomyWhy}).` : "create needs title, why and source.");
			}
			if (!p.id) return done("This action needs id.");
			if (p.action === "remind") return done(remindItem(p.id, p.at ?? "", p.text ?? "", deps.dir) ? `Reminder set; the card comes back at ${p.at}.` : `No loop ${p.id}, or the time is missing or past.`);
			p = { ...p, id: p.id } as typeof p & { id: string };
			if (p.action === "prepared") return done(preparedItem(p.id, p.text ?? "", deps.dir) ? "On brook's card. End your turn." : `No open loop ${p.id}, or empty text.`);
			if (p.action === "note") return done(noteItem(p.id, p.text ?? "", deps.dir) ? "Noted." : `No loop ${p.id}, or empty note.`);
			if (p.action === "finished") return done(finishedItem(p.id, p.text ?? "", deps.dir) ? "Back to brook to check and close." : `No open loop ${p.id}, or empty text.`);
			if (p.action === "choices") return done(publishChoices(p.id, p.choices, { question: p.question, dir: deps.dir }) ? "On brook's card. End your turn; his answer will come back." : `No open loop ${p.id}, or no valid choices.`);
			if (p.action === "later") return done(laterItem(p.id, deps.dir) ? "Parked." : `No open loop ${p.id}.`);
			if (p.action === "next") return done(nextItem(p.id, { button: p.button ?? "", action: p.step ?? "", note: p.text }, deps.dir) ? `Moved ${p.id} on: "${p.button}".` : `No open loop ${p.id}, or missing button/step.`);
			if (p.action === "done") return done(doneItem(p.id, deps.dir) ? "Done." : `No open loop ${p.id}.`);
			if (p.action === "drop") return done(dismissItem(p.id, deps.dir) ? "Dropped." : `No open loop ${p.id}.`);
			if (!p.into || p.into === forYouSession.id) return done("Name a session id or \"new\"; to do it here, just do it.");
			return done((await (deps.handOff ?? handOff)(p.id, p.into, p.cwd)) ? `Handed ${p.id} to ${p.into === "new" ? "a new session" : `${boardNameFor({ id: p.into, name: "", cwd: "" }) ?? "session"} (${p.into})`}. Its reply comes back here on the same thread.` : `Could not hand off ${p.id} (closed, or no folder for a new session).`);
		},
	});

	// The tool is only declared in the coordinator, so other sessions pay nothing for it.
	// The line this session owns (lines.json owner), if any: it reads and writes the shared memory for that line.
	const ownedLine = (ctx: any) => { const id = ctx?.sessionManager?.getSessionId?.(); return id && !isCoordinator(ctx) ? sessionLine(id, deps.dir) : undefined; };
	const apply = (ctx: any) => {
		const active = new Set(pi.getActiveTools());
		if (isCoordinator(ctx)) active.add(TOOL); else active.delete(TOOL);
		for (const t of [MEMORY_TOOL, JOB_TOOL]) if (ownedLine(ctx)) active.add(t); else active.delete(t);
		pi.setActiveTools([...active]);
	};
	// Cards: in the For you session only. A card never pops up by itself: it sits as a small widget above the
	// editor (reply with a number, later, no or done) and on the phone, so the session keeps working. brook answers whenever he wants;
	// the first answer (Mac or phone) wins. Typing "later"/"no"/"done" on the card acts directly.
	let timer: ReturnType<typeof setInterval> | undefined, showing: string | undefined, close: AbortController | undefined, shown: string | undefined, badged: boolean | undefined;
	const widget = (ctx: any, it: Awaited<ReturnType<typeof currentCard>>) => {
		const key = it ? `${it.id}:${it.left}:${it.choices.map(c => c.label).join("|")}` : "";
		if (key === shown) return;
		if (!!key !== badged) { badged = !!key; (deps.badge ?? ottyBadge)(badged); }
		shown = key;
		cardLog(deps.dir, "widget", { id: it?.id ?? null, left: it?.left });
		ctx.ui.setWidget?.("foryou-card", undefined);
		liveWidget(ctx);
	};
	// Focus stays in the existing strip; nothing changes size.
	let liveShown = "", liveContext: ExtensionContext | undefined, removeLiveInput: (() => void) | undefined;
	// d / Backspace removes a row at once on screen; the store changes after UNDO_MS unless u brings it back.
	let pending: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
	const visibleRows = () => forYouRows(deps.dir).filter(r => r.id !== pending?.id);
	const commitRemove = () => {
		const p = pending; if (!p) return;
		clearTimeout(p.timer); pending = undefined;
		// Live ask: off live.json. Card: the loop is done (handled), through the hub like the phone.
		if (!takeLive(p.id, deps.dir)) void (deps.answer ?? answerViaHub)(p.id, { answer: "done" }).catch(() => {});
		if (liveContext) liveWidget(liveContext);
	};
	const liveWidget = (ctx: any) => {
		const rows = visibleRows(), selected = liveFocus.selectedId;
		const lines = forYouLines(rows, selected, readFolded(deps.dir), !!pending), key = JSON.stringify(lines ?? null);
		if (key === liveShown || (!liveShown && !lines)) return;
		liveShown = key;
		ctx.ui.setWidget?.("foryou-live", lines);
	};
	const actLive = (id: string, verb: LiveAction, ctx: ExtensionContext) => {
		// Claim by id, exactly like the phone endpoint; a stale selection never replies twice.
		const a = takeLive(id, deps.dir);
		liveWidget(ctx);
		if (!a) { ctx.ui.notify("That ask was already handled.", "info"); return; }
		if (verb !== "later") pi.sendUserMessage(livePrompt(a, verb), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	};
	const liveFocus = createLiveFocus({
		rows: visibleRows,
		remove: id => {
			commitRemove();
			pending = { id, timer: setTimeout(commitRemove, UNDO_MS) };
			(pending.timer as { unref?: () => void }).unref?.();
		},
		render: () => { if (liveContext) liveWidget(liveContext); },
		act: (id, verb) => { if (liveContext) actRow(id, verb, liveContext); },
		gone: () => liveContext?.ui.notify("That ask was already handled.", "info"),
	});
	// A card row: Enter or s opens its picker, l puts it off (through the hub, like the phone).
	const actRow = (id: string, verb: LiveAction, ctx: ExtensionContext) => {
		if (readLive(deps.dir).some(a => a.id === id)) return actLive(id, verb, ctx);
		const at = waitingHeads(deps.dir, Date.now()).findIndex(h => h.it.id === id);
		if (at < 0) { ctx.ui.notify("That ask was already handled.", "info"); return; }
		const run = verb === "later" ? (deps.answer ?? answerViaHub)(id, { answer: "later" }).then(() => check(ctx)) : answer(ctx, at);
		void run.catch(e => ctx.ui.notify(String(e), "error"));
	};
	const check = async (ctx: any) => {
		if (!isCoordinator(ctx) || !ctx.hasUI) return;
		liveWidget(ctx);
		const it = currentCard(deps.dir, await sessions().catch(() => []));
		// Close the open picker only when its card was answered elsewhere (phone) or went away,
		// not because another card is first in line (the picker may show card 2 of 3).
		if (showing && !stillWaiting(showing, deps.dir)) { cardLog(deps.dir, "picker closed: card answered or gone", { id: showing }); close?.abort(); }
		widget(ctx, it);
	};
	// The whole unfinished list, only when brook asks for it; picking one talks it through here.
	const listAll = async (ctx: any) => {
		const rows = unfinishedLines(forYouView(deps.dir));
		if (!rows.length) { ctx.ui.notify("Nothing unfinished.", "info"); return; }
		const pick = await ctx.ui.select(`Unfinished, ${rows.length}`, rows.map(r => r.label));
		const row = rows.find(r => r.label === pick);
		if (row?.tasks) pi.sendUserMessage(`Let's look at the job "${row.label.replace(/^\S+(?: you)?\s+/, "")}". Its tasks:\n${row.tasks.map(t => `- ${t}`).join("\n")}\nWhere does each stand, and what do you need from me (once, for the whole job)?`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		else if (row) pi.sendUserMessage(`Let's look at loop ${row.id}: ${row.label.replace(/^\S+(?: you)?\s+/, "")}. Where does it stand?`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	};
	const answer = async (ctx: any, skip = 0): Promise<void> => {
		const it = currentCard(deps.dir, await sessions().catch(() => []), Date.now(), skip);
		if (!it) { cardLog(deps.dir, "shortcut: no card"); return void (await listAll(ctx)); }
		if (showing) { cardLog(deps.dir, "shortcut ignored: picker already open", { showing }); return; }
		cardLog(deps.dir, "picker open", { id: it.id, at: it.at, of: it.left + 1, skip });
		showing = it.id; close = new AbortController();
		try {
			const title = cardTitle(it);
			const labels = it.choices.map(choiceLabel);
			// One flat list: no second picker. Only sessions that fit this loop (same project, or the suggested one) are offered; anything else, type it.
			const taken = new Set(it.choices.map(c => c.run));
			const named = it.choices.some(c => !["here", "discuss", "later", "no"].includes(c.run));
			const targets = named ? [] : it.sessions.filter(x => x.fits && !taken.has(x.id)).slice(0, 2);
			const sendLabels = targets.map(sendLabel);
			// ←/→ flip between waiting cards without leaving the picker.
			let step = 0;
			const flip = (it.left && ctx.ui.onTerminalInput) ? ctx.ui.onTerminalInput((data: string) => {
				// One press = one flip: a key release (kitty protocol) must not flip the next card again.
				const d = matchesKey(data, "right") ? 1 : matchesKey(data, "left") ? -1 : 0;
				if (!d) return undefined;
				if (isKeyRelease(data) || step) return { consume: true };
				step = d; cardLog(deps.dir, d > 0 ? "key →" : "key ←", { id: it.id }); close?.abort();
				return { consume: true };
			}) : undefined;
			let pick: string | undefined;
			try { pick = await ctx.ui.select(title, [...labels, ...sendLabels, CARD_ELSE, ...(taken.has("later") ? [] : [CARD_LATER]), CARD_NO, CARD_ALL], { signal: close.signal }); }
			finally { flip?.(); }
			if (step) { showing = undefined; return void (await answer(ctx, skip + step + it.left + 1)); }
			if (pick === CARD_ALL) { showing = undefined; return void (await listAll(ctx)); }
			if (!pick) { cardLog(deps.dir, close?.signal.aborted ? "picker closed by code" : "picker closed: esc", { id: it.id }); return; }
			cardLog(deps.dir, "pick", { id: it.id, pick });
			const text = pick === CARD_ELSE ? await ctx.ui.input("Your answer (or later / no / done)", "", { signal: close.signal }) : undefined;
			if (pick === CARD_ELSE && !text?.trim()) return;
			const to = targets[sendLabels.indexOf(pick)]?.id;
			const index = labels.indexOf(pick);
			const kind: CardAnswer = index >= 0 ? "choice" : pick === CARD_LATER ? "later" : pick === CARD_NO ? "no" : to ? "send" : "else";
			const choice = index >= 0 ? index : undefined;
			const via = await (deps.answer ?? answerViaHub)(it.id, { answer: kind, choice, ...(to ? { to } : {}), text });
			cardLog(deps.dir, "answer", { id: it.id, kind, choice, to, via, text });
			if (via === "gone") { ctx.ui.notify("That card was already answered.", "info"); return; }
			if (via !== "ok") {
				// No hub: answer here directly.
				const r = answerCard(it.id, kind, { choice, to, text, by: "mac", dir: deps.dir, live: await sessions().catch(() => []) });
				if (!r) { ctx.ui.notify("That card was already answered.", "info"); return; }
				if (r.note) pi.sendMessage({ customType: "pix-foryou-note", content: r.note, display: true }, { deliverAs: "nextTurn" });
				if (r.here) pi.sendUserMessage(r.here, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				if (r.into) await (deps.handOff ?? handOff)(it.id, r.into);
			}
		} catch (e) { cardLog(deps.dir, "error", { id: it.id, error: String((e as Error)?.stack ?? e) }); throw e; }
		finally { showing = undefined; close = undefined; await check(ctx).catch(() => {}); }
	};
	const focusForYou = async (ctx: ExtensionContext) => {
		if (!isCoordinator(ctx) || ctx.mode !== "tui" || showing) return;
		liveContext = ctx;
		if (!liveFocus.focus()) await answer(ctx);
	};
	pi.registerShortcut(CARD_KEY, { description: "Choose a waiting For you card or live ask", handler: async ctx => {
		if (!isCoordinator(ctx) || ctx.mode !== "tui" || showing) return;
		// ⌘⇧Y goes straight to the first card's picker; ↓ on an empty input chooses from the whole list.
		if (currentCard(deps.dir, [])) { liveFocus.reset(); await answer(ctx); }
		else await focusForYou(ctx);
	} });
	const installLiveInput = (ctx: ExtensionContext) => {
		removeLiveInput?.(); removeLiveInput = undefined;
		liveContext = undefined; liveFocus.reset(); liveShown = "";
		if (!isCoordinator(ctx) || ctx.mode !== "tui" || !ctx.ui.onTerminalInput) return;
		removeLiveInput = ctx.ui.onTerminalInput(data => {
			if (showing || matchesKey(data, CARD_KEY)) return undefined;
			if (pending && matchesKey(data, "u") && (liveFocus.selectedId || !ctx.ui.getEditorText())) {
				if (!isKeyRelease(data)) { const id = pending.id; clearTimeout(pending.timer); pending = undefined; if (liveFocus.selectedId) liveFocus.select(id); liveWidget(ctx); }
				return { consume: true };
			}
			if (!liveFocus.selectedId && matchesKey(data, FOLD_KEY)) {
				if (!isKeyRelease(data)) { toggleFolded(deps.dir); liveWidget(ctx); }
				return { consume: true };
			}
			// ↓ on an empty input opens the list (Tab stays completion; ↓ there does nothing in Pi).
			if (!liveFocus.selectedId && matchesKey(data, "down") && !ctx.ui.getEditorText() && forYouRows(deps.dir).length) {
				if (!isKeyRelease(data)) void focusForYou(ctx).catch(e => ctx.ui.notify(String(e), "error"));
				return { consume: true };
			}
			return liveFocus.handleInput(data);
		});
	};
	// Pix's own loop prompts (card answers, handoffs) fold to one line on screen; the model still gets all of it.
	// Older loop prompts were stored as plain user messages: fold them the same way when drawn.
	pi.registerCommand?.("live", {
		description: "Act on a For you row: /live <n> reply|show|later (n as numbered in the list)",
		handler: async (args: string, ctx: any) => {
			const [n, verb = "reply"] = String(args ?? "").trim().split(/\s+/), a = forYouRows(deps.dir)[Number(n) - 1];
			if (!a || !["reply", "show", "later"].includes(verb)) { ctx.ui.notify("Usage: /live <n> reply, show or later", "info"); return; }
			actRow(a.id, verb as LiveAction, ctx);
		},
	});
	pi.registerMarkdownTransformer?.((md, c) => {
		if (c.messageType === "assistant" && isForYouProcess && /^\s*No change\.?\s*$/i.test(md)) return "";
		if (c.messageType !== "user") return md;
		const q = quietSummary(md);
		if (q) return `↳ ${q}`;
		const f = loopPromptSummary(md);
		return f ? `↳ loop **${f.title}**${f.you ? `, you: ${f.you}` : ""}` : md;
	});
	pi.registerMessageRenderer(LOOP_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const s = (message.details ?? {}) as { title?: string; you?: string };
		const head = `${theme.fg("accent", "↳ loop")} ${theme.bold(s.title ?? "")}${s.you ? theme.fg("dim", `, you: ${s.you}`) : ""}`;
		const box = new Box(outputPad, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(expanded ? `${head}\n${theme.fg("dim", String(message.content))}` : head, 0, 0));
		return box;
	});
	pi.on("input", async (event, ctx) => {
		// brook talking to For you opens a "thread": the daemon holds new batches until it goes quiet.
		if (isCoordinator(ctx) && isBrookText(event.text)) markBrookActive(deps.dir); // Mac or phone (the hub)
		// brook's own short reply answers the waiting card; anything longer is a normal chat with For you.
		if (event.source === "interactive" && !event.images?.length && isCoordinator(ctx) && event.text.trim().length <= 20) {
			const it = currentCard(deps.dir, await sessions().catch(() => []));
			const r = it && cardReply(event.text, it.choices.length);
			if (it && r) {
				const via = await (deps.answer ?? answerViaHub)(it.id, r);
				if (via === "nohub") {
					const a = answerCard(it.id, r.answer, { ...r, by: "mac", dir: deps.dir, live: await sessions().catch(() => []) });
					if (a?.note) pi.sendMessage({ customType: "pix-foryou-note", content: a.note, display: true }, { deliverAs: "nextTurn" });
					if (a?.here) pi.sendUserMessage(a.here, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
					if (a?.into) await (deps.handOff ?? handOff)(it.id, a.into);
				}
				ctx.ui.notify(via === "gone" ? "That card was already answered." : `✓ ${it.title}`, "info");
				await check(ctx).catch(() => {});
				return { action: "handled" as const };
			}
		}
		if (event.source !== "extension" || event.images?.length) return { action: "continue" as const };
		const m = loopMessage(event.text);
		if (!m) return { action: "continue" as const };
		pi.sendMessage(m, { triggerTurn: true, deliverAs: event.streamingBehavior ?? "followUp" });
		return { action: "handled" as const };
	});
	pi.on("session_start", (_e, ctx) => {
		isForYouProcess = isCoordinator(ctx);
		apply(ctx);
		installLiveInput(ctx);
		clearInterval(timer);
		timer = setInterval(() => void check(ctx).catch(() => {}), deps.cardPollMs ?? 4000);
		timer.unref?.();
	});
	pi.on("agent_end", (_e, ctx) => void check(ctx).catch(() => {}));
	// Job tracking: a session that owns a loop reports where it stands on every turn end, without being asked.
	pi.on("agent_end", (event: any, ctx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			if (!id || id === forYouSession.id) return;
			const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
			const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
			const name = ctx?.sessionManager?.getSessionName?.();
			trackTurn({ id, name, cwd: ctx?.cwd }, text, deps.dir);
			// Beside the session: a cheap model writes its one-line status (not awaited; no context or time taken from the turn).
			const user = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "user");
			const ask = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
			const model = statusModel(deps.dir);
			if (model && !process.env.PIX_STATUS_OFF) void (deps.summarize ?? summarizeTurn)({ session: id, name, cwd: ctx?.cwd, ask, reply: text, model, dir: deps.dir });
		} catch { /* tracking never breaks a turn */ }
	});
	pi.on("session_start", (_e, ctx) => { shown = undefined; badged = undefined; void check(ctx).catch(() => {}); });
	pi.on("session_shutdown", () => {
		clearInterval(timer); close?.abort(); commitRemove();
		removeLiveInput?.(); removeLiveInput = undefined;
		liveContext = undefined; liveFocus.reset();
	});
	// /context html shows this block as "For you memory"; Pi's own /export cannot see it.
	setInjected("For you memory", async (ctx: any) => isCoordinator(ctx) ? coordinatorContext(deps.dir, await sessions()) : undefined);
	pi.on("before_agent_start", async (event, ctx) => {
		apply(ctx);
		if (!isCoordinator(ctx)) {
			const line = ownedLine(ctx);
			if (!line) return undefined;
			try { return { systemPrompt: `${event.systemPrompt}\n\n## Shared memory (line "${line.name}", id ${line.id})\nYou own this line of work. This is brook's shared memory for it; keep it true with the memory tool (lines/${line.id}). Keep your jobs' posts current with the job tool: when a draft is ready, use next with the draft so brook can just send it.\n\n${lineMemory(memoryDirOf(deps.dir), line.id)}` }; } catch { return undefined; }
		}
		try { return { systemPrompt: `${event.systemPrompt}\n\n${coordinatorContext(deps.dir, await sessions())}` }; } catch { return undefined; }
	});
	// "@foryou:<id>" in any session: completion in the input box, and the full loop on send.
	pi.on("session_start", (_e, ctx) => { if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider?.(current => withForYou(current, () => readOpen())); });
	pi.on("input", (event, ctx) => {
		// "@" makes this session the loop's home: later taps on the loop come back here.
		let text = event.text;
		try { text = expandForYou(text, ctx?.sessionManager?.getSessionId?.() ?? "pi", undefined, ctx?.cwd); } catch { /* list unreadable: keep text */ }
		return text !== event.text ? { action: "transform", text } : { action: "continue" };
	});
}
