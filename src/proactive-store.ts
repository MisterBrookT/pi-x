// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { actPrompt, parseInbox, paths, pendingItems, publicItem, type Item } from "./proactive.ts";
import { launchPi, type RemoteMode } from "./remote-mac.ts";
import { relayConfigPath } from "./remote-relay-agent.ts";

export function readPending(dir?: string): Item[] {
	const { inbox } = paths(dir);
	return existsSync(inbox) ? pendingItems(readFileSync(inbox, "utf8")) : [];
}

/** What the phone's For you page shows: pending items, what was handled in the last day, and how many sources are watched. */
export function forYouView(dir?: string, now = Date.now()) {
	const P = paths(dir);
	const all = existsSync(P.inbox) ? parseInbox(readFileSync(P.inbox, "utf8")) : [];
	const handled = all.filter(i => i.status !== "pending" && now - Date.parse((i as any).at_status ?? i.at) < 86_400_000).reverse().slice(0, 20);
	let watching = 0;
	try { watching = JSON.parse(readFileSync(P.config, "utf8")).sources?.length ?? 0; } catch {}
	const newest = (a: Item, b: Item) => Date.parse(b.at) - Date.parse(a.at);
	return { pending: all.filter(i => i.status === "pending").sort(newest).map(publicItem), handled: handled.map(publicItem), watching };
}

function mark(id: string, status: Item["status"], dir?: string) {
	appendFileSync(paths(dir).inbox, JSON.stringify({ id, status, at_status: new Date().toISOString() }) + "\n");
}

export function dismissItem(id: string, dir?: string): boolean {
	if (!readPending(dir).some(i => i.id === id)) return false;
	mark(id, "dismissed", dir);
	return true;
}

/** The one Pi session that works on all "Do it" items, so they never pile up as tabs. */
export const forYouSession = { id: "pix-foryou", name: "For you", model: "openai-codex/gpt-6-luna" };

/** Where the For you session runs: home, so it can reach every project by path. */
export const forYouFolder = (home = homedir()) => home;

/**
 * "Do it": hand the item to the For you session. If it is live (connected to Remote), the task is queued
 * into it via `send`; otherwise a new tab starts it (same fixed session id, so history continues).
 */
export async function actItem(id: string, options: { dir?: string; mode?: RemoteMode; launch?: typeof launchPi; send?: (session: string, text: string) => boolean } = {}): Promise<Item | undefined> {
	const it = readPending(options.dir).find(i => i.id === id);
	if (!it) return undefined;
	appendFileSync(paths(options.dir).inbox, JSON.stringify({ id, status: "done", session: forYouSession.id, at_status: new Date().toISOString() }) + "\n");
	const prompt = actPrompt(it);
	if (options.send?.(forYouSession.id, prompt)) return it;
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(forYouFolder(), mode, { prompt, sessionId: forYouSession.id, name: forYouSession.name, model: forYouSession.model });
	return it;
}
