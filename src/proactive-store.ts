// The one list, with IO. Every view (Mac pill via the daemon CLI, iPhone via the Remote hub)
// reads and changes items only through here, so they always agree.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { actPrompt, paths, pendingItems, type Item } from "./proactive.ts";
import { launchPi, type RemoteMode } from "./remote-mac.ts";
import { relayConfigPath } from "./remote-relay-agent.ts";

export function readPending(dir?: string): Item[] {
	const { inbox } = paths(dir);
	return existsSync(inbox) ? pendingItems(readFileSync(inbox, "utf8")) : [];
}

function mark(id: string, status: Item["status"], dir?: string) {
	appendFileSync(paths(dir).inbox, JSON.stringify({ id, status, at_status: new Date().toISOString() }) + "\n");
}

export function dismissItem(id: string, dir?: string): boolean {
	if (!readPending(dir).some(i => i.id === id)) return false;
	mark(id, "dismissed", dir);
	return true;
}

/** Folder an item's session starts in: its project if it exists, else home. */
export function itemFolder(it: Item, home = homedir()): string {
	const dir = (it.project ?? "").replace(/^~(?=\/|$)/, home);
	return dir && existsSync(dir) ? dir : home;
}

/** "Do it": start a normal Pi session (remote on, so it shows on the phone too) with the next step. */
export async function actItem(id: string, options: { dir?: string; mode?: RemoteMode; launch?: typeof launchPi } = {}): Promise<Item | undefined> {
	const it = readPending(options.dir).find(i => i.id === id);
	if (!it) return undefined;
	mark(id, "done", options.dir);
	const mode = options.mode ?? (existsSync(relayConfigPath) ? "relay" : "tailnet");
	await (options.launch ?? launchPi)(itemFolder(it), mode, { prompt: actPrompt(it) });
	return it;
}
