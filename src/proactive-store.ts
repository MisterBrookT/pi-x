// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { actPrompt, isOpen, needsYou, parseInbox, paths, pendingItems, publicItem, wakeTime, type Item } from "./proactive.ts";
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
export function takeItem(id: string, session: string, dir?: string): Item | undefined {
	const it = readAll(dir).find(i => i.id === id && isOpen(i));
	if (!it) return undefined;
	write(dir, { id, status: "onit", session, wakeAt: null });
	return it;
}

/** The one Pi session that works on all "Do it" items, so they never pile up as tabs. */
export const forYouSession = { id: "pix-foryou", name: "For you", model: "openai-codex/gpt-6-luna" };

/** Where the For you session runs: home, so it can reach every project by path. */
export const forYouFolder = (home = homedir()) => home;

/**
 * "Do it": hand the item to the For you session. If it is live (connected to Remote), the task is queued
 * into it via `send`; otherwise a new tab starts it (same fixed session id, so history continues).
 */
export async function actItem(id: string, options: { dir?: string; mode?: RemoteMode; launch?: typeof launchPi; focus?: boolean; focusTab?: (name: string) => Promise<boolean>; send?: (session: string, text: string) => boolean } = {}): Promise<Item | undefined> {
	const it = takeItem(id, forYouSession.id, options.dir);
	if (!it) return undefined;
	const prompt = actPrompt(it);
	if (options.send?.(forYouSession.id, prompt)) {
		if (options.focus) await (options.focusTab ?? focusOttyTab)(forYouSession.name);
		return it;
	}
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(forYouFolder(), mode, { prompt, sessionId: forYouSession.id, name: forYouSession.name, model: forYouSession.model, focus: options.focus });
	return it;
}
