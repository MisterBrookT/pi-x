// Source adapters for the proactive loop. Add a new channel (email, WeChat, ...) by
// writing one adapter and registering it below; the daemon, judge, and UI stay unchanged.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Msg, Source } from "./proactive.ts";

const run = promisify(execFile);

export interface Adapter {
	/** Fetch recent messages, oldest first. Cursoring is handled by the daemon. */
	fetch(src: Source): Promise<Msg[]>;
	/** How an agent can read the original items when acting on an alert. */
	howToRead(src: Source, refs: string[]): string;
	/** Optional: turn one config entry into many real sources (e.g. "all my Feishu chats"). */
	expand?(src: Source): Promise<Source[]>;
}

/** Feishu chat list -> one feishu source per chat. */
export function parseFeishuChats(json: unknown): Source[] {
	const list = (json as { data?: { chats?: any[] } })?.data?.chats ?? [];
	return list.filter(c => c?.chat_id).map(c => ({ kind: "feishu", id: String(c.chat_id), name: String(c.name ?? c.chat_id).trim() }));
}

/** Feishu chat messages -> Msg[], oldest first. */
export function parseFeishu(json: unknown): Msg[] {
	const list = (json as { data?: { messages?: any[] } })?.data?.messages ?? [];
	return list
		.filter(m => m && !m.deleted && m.message_id)
		.map(m => ({ id: String(m.message_id), time: String(m.create_time ?? ""), sender: String(m.sender?.name ?? m.sender?.id ?? "?").trim(), text: String(m.content ?? "").replace(/!\[Image\]\([^)]*\)/g, "[image]").slice(0, 1500) }))
		.reverse();
}

const feishu: Adapter = {
	async fetch(src) {
		const { stdout } = await run("lark-cli", ["im", "+chat-messages-list", "--as", "user", "--chat-id", src.id, "--order", "desc", "--page-size", "30", "--no-reactions"], { maxBuffer: 1 << 24, timeout: 60_000 });
		return parseFeishu(JSON.parse(stdout));
	},
	howToRead: (src, refs) => `Feishu chat ${src.id}. Read with: lark-cli im +messages-mget --as user --message-ids ${refs.join(",") || "<ids>"} (or +chat-messages-list --chat-id ${src.id}).`,
};

/** Generic adapter: any command that prints JSON [{id,time,sender,text}] oldest first. */
const command: Adapter = {
	async fetch(src) {
		const cmd = String(src.command ?? "");
		if (!cmd) throw new Error("command source needs a `command`");
		const { stdout } = await run("/bin/sh", ["-c", cmd], { maxBuffer: 1 << 24, timeout: 60_000 });
		const list = JSON.parse(stdout);
		if (!Array.isArray(list)) throw new Error("command must print a JSON array");
		return list.map((m: any) => ({ id: String(m.id), time: String(m.time ?? ""), sender: String(m.sender ?? "?").trim(), text: String(m.text ?? "").slice(0, 1500) }));
	},
	howToRead: (src, refs) => `Source command: ${src.command}. Item ids: ${refs.join(", ") || "n/a"}.`,
};

/** Every unmuted Feishu chat (groups and direct messages). Muted chats are skipped: mute = not important. */
const feishuAll: Adapter = {
	fetch: async () => [],
	howToRead: () => "",
	async expand() {
		const { stdout } = await run("lark-cli", ["im", "+chat-list", "--as", "user", "--types", "p2p,group", "--exclude-muted", "--sort", "active_time", "--page-size", "100"], { maxBuffer: 1 << 24, timeout: 60_000 });
		return parseFeishuChats(JSON.parse(stdout));
	},
};

export const adapters: Record<string, Adapter> = { feishu, "feishu-all": feishuAll, command };

/** Config sources with any "many chats" entries expanded. Explicit entries win (they may carry a project). */
export async function expandSources(sources: Source[]): Promise<Source[]> {
	const out: Source[] = [];
	for (const src of sources) {
		const a = adapterFor(src);
		out.push(...(a.expand ? await a.expand(src) : [src]));
	}
	const explicit = new Map(sources.filter(s => !adapterFor(s).expand).map(s => [`${s.kind}:${s.id}`, s]));
	const seen = new Set<string>();
	return out.map(s => explicit.get(`${s.kind}:${s.id}`) ?? s).filter(s => { const k = `${s.kind}:${s.id}`; return !seen.has(k) && !!seen.add(k); });
}

export function adapterFor(src: Source): Adapter {
	const a = adapters[src.kind];
	if (!a) throw new Error(`unknown source kind "${src.kind}" (known: ${Object.keys(adapters).join(", ")})`);
	return a;
}
