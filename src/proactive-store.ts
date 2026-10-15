// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { actPrompt, addNote, type Choice, cleanChoices, daemonScript, isOpen, needsYou, parseInbox, paths, pendingItems, publicItem, wakeTime, type Item } from "./proactive.ts";
import { focusOttyTab, launchPi, type RemoteMode } from "./remote-mac.ts";
import { relayConfigPath } from "./remote-relay-agent.ts";
import { memoryAll, memoryDir } from "./proactive-memory.ts";

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
export function forYouView(dir?: string, now = Date.now()) {
	const P = paths(dir);
	const all = readAll(dir);
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
		watching,
		problems,
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

/** A work session says the whole loop is done: it comes back once so brook can check and close it (✓). */
export function finishedItem(id: string, summary: string, dir?: string): boolean {
	const text = summary.replace(/\s+/g, " ").trim();
	return !!text && nextItem(id, { button: "Check result", action: `Finished: ${text.slice(0, 180)}. Check it, then ✓ to close.`, note: `Finished: ${text}` }, dir);
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
export function nextItem(id: string, step: { button: string; action: string; note?: string }, dir?: string): boolean {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	const button = step.button.replace(/\s+/g, " ").trim().slice(0, 40), action = step.action.replace(/\s+/g, " ").trim().slice(0, 200);
	if (!it || !button || !action) return false;
	write(dir, { id, status: "pending", wakeAt: null, button, action, note: addNote(it.note, step.note?.trim() || `Step done; next: ${action}`) });
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

export type CardAnswer = "choice" | "send" | "else" | "later" | "no" | "done";

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
	at?: number; id: string; title: string; why: string; action: string; source: string; due?: string; left: number; choices: CardChoice[];
	/** Where "Send to a session" can hand it: open sessions, the likeliest first ("new" = a session in its project). */
	sessions: { id: string; name: string; cwd?: string; fits?: boolean }[];
	/** What "Send to a session…" hands over. */
	task?: string }

/** Open sessions to hand a loop to: the judge's pick, then ones in the loop's project, then the rest; "new" when it has a project. */
export function sendTargets(it: Item, live: LiveSession[], home = homedir()): { id: string; name: string; cwd?: string; fits?: boolean }[] {
	const dir = it.project ? expandHome(it.project, home) : "";
	const near = (s: LiveSession) => it.suggest?.session === s.id ? 0 : dir && s.cwd && (s.cwd === dir || dir.startsWith(s.cwd + "/") || s.cwd.startsWith(dir + "/")) ? 1 : 2;
	const out = live.filter(s => s.id !== forYouSession.id).sort((a, b) => near(a) - near(b)).slice(0, 8).map(s => ({ id: s.id, name: s.name, cwd: s.cwd.replace(home, "~"), ...(near(s) < 2 ? { fits: true } : {}) }));
	return it.project ? [...out, { id: "new", name: "New session", cwd: it.project, ...(out.some(s => s.fits) ? {} : { fits: true }) }] : out;
}

/**
 * The card's main buttons: what the judge wrote for this loop. A button for a session that is not
 * open becomes "new" (a session in the project); no buttons (or none valid) falls back to "Do it here"
 * and, when the judge suggested a live session, "Send to <it>".
 */
export function cardChoices(it: Item, live: LiveSession[]): (CardChoice & { prompt?: string })[] {
	const others = live.filter(s => s.id !== forYouSession.id);
	const fix = (c: Choice) => ["here", "discuss", "new", "later", "no"].includes(c.run) ? c : others.some(s => s.id === c.run) ? { ...c, name: others.find(s => s.id === c.run)!.name } : { ...c, run: "new" };
	const own = (it.choices ?? []).map(fix).filter(c => c.run !== "new" || it.project);
	if (own.length) return own;
	return [{ label: "Do it here", run: "here" }, { label: "Discuss", run: "discuss" }, { label: "Later", run: "later" }];
}

/** The card For you shows now: the oldest loop that needs brook (undefined when none). */
/** Is this loop still waiting for brook (anywhere in the queue, not only first)? */
export function stillWaiting(id: string, dir?: string, now = Date.now()) { return readAll(dir).some(i => i.id === id && needsYou(i, now)); }

export function currentCard(dir?: string, live: LiveSession[] = [], now = Date.now(), skip = 0): Card | undefined {
	const waiting = readAll(dir).filter(i => needsYou(i, now)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const at = waiting.length ? skip % waiting.length : 0;
	const it = waiting[at];
	if (!it) return undefined;
	return { at: at + 1, id: it.id, title: it.title, why: it.why, action: it.action, source: it.source, ...(it.due ? { due: it.due } : {}), left: waiting.length - 1, choices: cardChoices(it, live).map(({ prompt, ...c }) => ({ ...c, task: choiceTask(it, { run: c.run, prompt }) })), sessions: sendTargets(it, live), task: choiceTask(it, { run: "here" }) };
}

/**
 * Record brook's answer and change the loop. `choice` is the index of the button he tapped.
 * Returns what to tell the For you session (`here`), or where to hand the loop (`into`, with
 * `prompt`); undefined when the card is gone or the answer is bad. Every answer is logged.
 */
export function answerCard(id: string, answer: CardAnswer, o: { choice?: number; to?: string; text?: string; by?: string; dir?: string; live?: LiveSession[]; now?: Date } = {}): { item: Item; here?: string; into?: string } | undefined {
	const at = o.now ?? new Date();
	const it = readAll(o.dir).find(i => i.id === id && needsYou(i, at.getTime()));
	const text = o.text?.replace(/\s+/g, " ").trim().slice(0, 2000);
	if (answer === "else") answer = quickAnswer(text) ?? "else";
	if (!it || !["choice", "send", "else", "later", "no", "done"].includes(answer) || (answer === "else" && !text)) return undefined;
	const c = answer === "choice" ? cardChoices(it, o.live ?? []).at(o.choice ?? -1) : undefined;
	if (answer === "send" && !(o.to && /^[\w.-]{1,80}$/.test(o.to) && (o.to !== "new" || it.project))) return undefined;
	if (answer === "choice" && (!c || !Number.isInteger(o.choice) || o.choice! < 0)) return undefined;
	appendFileSync(paths(o.dir).judgments, JSON.stringify({ at: at.toISOString(), kind: "card", id, title: it.title, answer, ...(c ? { label: c.label, run: c.run } : {}), ...(answer === "send" ? { to: o.to } : {}), ...(text ? { text } : {}), by: o.by }) + "\n");
	if (c?.run === "later" || c?.run === "no") answer = c.run;
	if (answer === "later") { const wake = new Date(at.getTime() + cardLaterDays * 86_400_000); wake.setHours(9, 0, 0, 0); write(o.dir, { id, status: "later", wakeAt: wake.toISOString() }); return { item: it }; }
	if (answer === "no") { write(o.dir, { id, status: "dismissed" }); return { item: it }; }
	if (answer === "done") { write(o.dir, { id, status: "done" }); return { item: it }; }
	if (answer === "send") return { item: it, into: o.to };
	// His own words on a loop a work session already owns go back to that session, with the loop's context.
	if (answer === "else" && it.session && it.session !== forYouSession.id) { write(o.dir, { id, action: text }); return { item: it, into: it.session }; }
	if (c && c.run !== "here" && c.run !== "discuss" && c.run !== "later" && c.run !== "no") {
		if (c.prompt) write(o.dir, { id, action: c.prompt });
		return { item: it, into: c.run };
	}
	takeItem(id, forYouSession.id, o.dir, forYouFolder());
	const base = actPrompt({ ...it, ...(c?.prompt ? { action: c.prompt } : {}), session: undefined }, paths(o.dir).dir);
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

export const expandHome = (p: string, home = homedir()) => resolve(p.replace(/^~(?=\/|$)/, home));
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
		return dir ? { session: `loop-${it.id}`, name: shortName(it), cwd: expandHome(dir, home), coordinator: false } : here;
	}
	const s = live.find(x => x.id === into);
	return { session: into, name: s?.name ?? shortName(it), cwd: s?.cwd ?? (cwd ? expandHome(cwd, home) : it.session === into && it.sessionCwd ? it.sessionCwd : it.project ? expandHome(it.project, home) : forYouFolder(home)), coordinator: false };
}

/**
 * Hand a loop to a session. The main button (phone, pill) sends it to the coordinator, which reads the
 * loop and decides; the coordinator's `loops` tool calls this with `into` to route it elsewhere.
 * A live session gets the task queued (via `send`); otherwise a tab starts or resumes that session id.
 */
export async function actItem(id: string, options: { dir?: string; mode?: RemoteMode; launch?: typeof launchPi; focus?: boolean; focusTab?: (name: string) => Promise<boolean>; send?: (session: string, text: string) => boolean; live?: LiveSession[]; into?: string; cwd?: string; home?: string } = {}): Promise<Item | undefined> {
	const before = readAll(options.dir).find(i => i.id === id && isOpen(i));
	if (!before) return undefined;
	const route = routeFor(before, options.live ?? [], options.into, options.cwd, options.home);
	const it: Item = { ...takeItem(id, route.session, options.dir, route.cwd)!, status: "onit", session: route.session, sessionCwd: route.cwd };
	// "Picked up again" only when this same session already had the loop.
	const prompt = route.coordinator ? coordinatorTask(before, options.dir) : actPrompt(before.session === route.session ? it : { ...it, session: undefined }, paths(options.dir).dir);
	if (options.send?.(route.session, prompt)) {
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
export function coordinatorContext(dir?: string, live: LiveSession[] = [], now = Date.now()): string {
	const P = paths(dir);
	const memory = existsSync(memoryDir(P.dir)) ? memoryAll(P.dir) : existsSync(P.memory) ? readFileSync(P.memory, "utf8").trim() : "(empty)";
	const open = readOpen(dir, now);
	const loop = (i: Item) => [
		`- id=${i.id} [${needsYou(i, now) ? "needs brook" : i.status === "onit" ? "Pi is on it" : i.status}${i.due ? `, due ${i.due}` : ""}] ${i.title} (${i.source})`,
		i.project ? `  project: ${i.project}` : "",
		i.session ? `  session: ${i.session}${i.session === forYouSession.id ? " (this one)" : ""}` : "",
		i.note ? i.note.split("\n").map(l => `  ${l}`).join("\n") : "",
	].filter(Boolean).join("\n");
	return `## Proactive coordinator
You are brook's coordinator for his open loops (things unfinished between him and others). Below is what you know;
use the loops tool to act on loops. How to do each one is your call. Nothing outbound without his confirmation.
Only change a loop (drop, later, handoff) when brook asks or a loop was just tapped; a question is not a request to act.
Routing: prefer the session already on a loop, then an open session in the same project or whose recent work matches
(see the list below); start a new session only when none fits. Never push work into an unrelated session. A busy session
gets the task queued after its current turn; that is fine, do not wait for it.
Decisions: when a loop needs brook to choose, do not ask with a blocking question. Use the loops tool action "choices" to
put 1-3 buttons on his card (labels and routes that fit this loop, your call) and end your turn. He can always type his
own answer or pick Later instead; his answer comes back to you or goes to the session the button names.
Do not start expensive or risky work, or send or submit anything outward, beyond what he already allowed.
He can also just chat with you about a card ("why this?", "send it to pix", "merge with the other one"): answer, and use
the loops tool when he asks for a change.

### Memory
${memory}

### Open loops
${open.map(loop).join("\n") || "(none)"}

### The card on brook's screen now
${(() => { const c = currentCard(dir, live, now); return c ? `id=${c.id} "${c.title}" (${c.left} more after it). When he talks about "this" or "the card", he means this loop.
Its buttons: ${c.choices.map(x => `"${x.label}" -> ${x.run}`).join(", ")}; plus Later, No, Something else.` : "(none)"; })()}

### Pi sessions open now
${live.map(s => `- ${s.name} (${s.id}) in ${s.cwd}${s.busy ? ", busy" : ""}`).join("\n") || "(none known)"}`;
}
