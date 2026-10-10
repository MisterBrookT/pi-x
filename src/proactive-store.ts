// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { actPrompt, addNote, daemonScript, isOpen, needsYou, parseInbox, paths, pendingItems, publicItem, wakeTime, type Item } from "./proactive.ts";
import { focusOttyTab, launchPi, type RemoteMode } from "./remote-mac.ts";
import { relayConfigPath } from "./remote-relay-agent.ts";

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
	let watching = 0;
	try { watching = JSON.parse(readFileSync(P.config, "utf8")).sources?.length ?? 0; } catch {}
	return {
		pending: all.filter(i => needsYou(i, now)).sort(newest).map(publicItem),
		onit: parked.filter(i => i.status === "onit").sort(newest).map(publicItem),
		later: parked.filter(i => i.status !== "onit").sort((a, b) => Date.parse(a.wakeAt ?? "") - Date.parse(b.wakeAt ?? "")).map(publicItem),
		handled: handled.map(publicItem),
		watching,
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
	const memory = existsSync(P.memory) ? readFileSync(P.memory, "utf8").trim() : "(empty)";
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

### Memory
${memory}

### Open loops
${open.map(loop).join("\n") || "(none)"}

### Pi sessions open now
${live.map(s => `- ${s.name} (${s.id}) in ${s.cwd}${s.busy ? ", busy" : ""}`).join("\n") || "(none known)"}`;
}
