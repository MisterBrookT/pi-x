// Source adapters for the proactive loop. Add a new channel (email, WeChat, ...) by
// writing one adapter and registering it below; the daemon, judge, and UI stay unchanged.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** WeChat session list -> one wechat source per recent group/private chat (no official accounts or folders). */
export function parseWechatChats(json: unknown, o: { sinceSec: number; exclude?: string[]; max?: number }): Source[] {
	const list = (json as { data?: { sessions?: any[] } })?.data?.sessions ?? [];
	const skip = new Set(o.exclude ?? []);
	return list
		.filter(s => s?.username && (s.chat_type === "group" || s.chat_type === "private") && !/^gh_|holder$|^@/.test(String(s.username)) && !/holder$/.test(String(s.chat ?? "")) && Number(s.timestamp ?? 0) >= o.sinceSec && !skip.has(s.chat) && !skip.has(s.username))
		.slice(0, o.max ?? 30)
		.map(s => ({ kind: "wechat", id: String(s.username), name: `WeChat: ${String(s.chat ?? s.username).trim()}` }));
}

/** WeChat history -> Msg[], oldest first. In private chats the other side has an empty sender. */
export function parseWechat(json: unknown): Msg[] {
	const d = (json as { data?: { chat?: string; messages?: any[] } })?.data ?? {};
	return (d.messages ?? [])
		.filter(m => m && m.local_id != null)
		.map(m => ({ id: String(m.local_id), time: String(m.time ?? ""), sender: String(m.sender || d.chat || "?").trim(), text: String(m.content ?? "").slice(0, 1500) }));
}

const wechatCli = async (args: string[]) => JSON.parse((await run("wechat-cli", args, { maxBuffer: 1 << 24, timeout: 60_000 })).stdout);

const wechat: Adapter = {
	fetch: async src => parseWechat(await wechatCli(["msg", "get_message", JSON.stringify({ talker: src.id, limit: 30 })])),
	howToRead: (src, refs) => `WeChat chat ${src.name} (${src.id}), read-only. Read with: wechat-cli msg get_message '{"talker":"${src.id}","limit":50}' (local_ids ${refs.join(",") || "n/a"}). Never send from the CLI; replies go through the desktop app after brook confirms.`,
};

/** Recently active WeChat chats. Options: days (default 2), max (30), exclude (chat names or ids), me. */
const wechatAll: Adapter = {
	fetch: async () => [],
	howToRead: () => "",
	async expand(src) {
		const days = Number(src.days ?? 2);
		const list = parseWechatChats(await wechatCli(["msg", "get_msg_chat_list", "{}"]), { sinceSec: Date.now() / 1000 - days * 86400, exclude: src.exclude as string[] | undefined, max: Number(src.max ?? 30) });
		return list.map(s => ({ ...s, ...(src.me ? { me: src.me } : {}) }));
	},
};

/** Gmail list+metadata responses -> Msg[], oldest first. */
export function parseGmail(msgs: any[]): Msg[] {
	return msgs
		.filter(m => m?.id)
		.map(m => {
			const h = (n: string) => String(m.payload?.headers?.find((x: any) => String(x.name).toLowerCase() === n)?.value ?? "");
			const sender = h("from").replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || h("from");
			return { id: String(m.id), time: new Date(Number(m.internalDate ?? 0)).toISOString(), sender, text: `Subject: ${h("subject")}\n${String(m.snippet ?? "")}`.slice(0, 1500), _t: Number(m.internalDate ?? 0) };
		})
		.sort((a, b) => a._t - b._t)
		.map(({ _t, ...m }) => m);
}

const GMAIL_DIR = process.env.PIX_GMAIL_DIR || join(homedir(), ".gmail-mcp");
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7890";
async function curl(args: string[]) {
	const { stdout } = await run("curl", ["-sS", "-m", "30", ...(proxy ? ["-x", proxy] : []), ...args], { maxBuffer: 1 << 24, timeout: 45_000 });
	const j = JSON.parse(stdout);
	if (j.error) throw new Error(`gmail: ${JSON.stringify(j.error).slice(0, 200)}`);
	return j;
}
async function gmailToken(): Promise<string> {
	const credPath = join(GMAIL_DIR, "credentials.json");
	const cred = JSON.parse(readFileSync(credPath, "utf8"));
	const t = cred.tokens ?? cred;
	if (t.access_token && Number(t.expiry_date ?? 0) > Date.now() + 60_000) return t.access_token;
	const keys = JSON.parse(readFileSync(join(GMAIL_DIR, "gcp-oauth.keys.json"), "utf8"));
	const k = keys.installed ?? keys.web;
	const r = await curl(["https://oauth2.googleapis.com/token", "-d", `client_id=${encodeURIComponent(k.client_id)}`, "-d", `client_secret=${encodeURIComponent(k.client_secret)}`, "-d", `refresh_token=${encodeURIComponent(t.refresh_token)}`, "-d", "grant_type=refresh_token"]);
	Object.assign(t, { access_token: r.access_token, expiry_date: Date.now() + Number(r.expires_in ?? 3600) * 1000 });
	writeFileSync(credPath, JSON.stringify(cred, null, 2), { mode: 0o600 });
	return r.access_token;
}

/** Gmail inbox (read-only). Options: query (default: recent primary/updates inbox mail). */
const gmail: Adapter = {
	async fetch(src) {
		const token = await gmailToken();
		const auth = ["-H", `Authorization: Bearer ${token}`];
		const q = String(src.query ?? "in:inbox newer_than:3d -category:promotions -category:social");
		const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
		const list = await curl([...auth, `${base}?maxResults=20&q=${encodeURIComponent(q)}`]);
		const full = await Promise.all((list.messages ?? []).map((m: any) => curl([...auth, `${base}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`])));
		return parseGmail(full);
	},
	howToRead: (_src, refs) => `Gmail message ids: ${refs.join(", ") || "n/a"}. Read with the gmail MCP tool read_email (load via tool_search "gmail").`,
};

export const adapters: Record<string, Adapter> = { feishu, "feishu-all": feishuAll, wechat, "wechat-all": wechatAll, gmail, command };

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
