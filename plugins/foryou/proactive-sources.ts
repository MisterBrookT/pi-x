// Source adapters for the proactive loop. Add a new channel (email, WeChat, ...) by
// writing one adapter and registering it below; the daemon, judge, and UI stay unchanged.
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Msg, Source } from "./proactive.ts";
import { fetchGmailImap } from "./imap.ts";
import type { DingChat } from "./dingtalk-local.ts";
// Same path as dingtalk-local.ts; not imported so this module never loads node:sqlite (the reader runs in a worker).
const dingRoot = join(homedir(), "Library/Containers/5ZSL2CJU2T.com.dingtalk.mac/Data/Library/Application Support/DingTalkMac");
import { readDingTalkIsolated } from "./dingtalk-worker.ts";
import { probeApp, reapWxDaemons, sealedReason } from "./access.ts";
import { isLocked } from "./unlock.ts";

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
	return list.filter(c => c?.chat_id).map(c => ({ kind: "feishu", id: String(c.chat_id), name: String(c.name ?? c.chat_id).trim(), ...(c.chat_mode === "p2p" ? { chat: "private" } : {}) }));
}

/** Feishu chat messages -> Msg[], oldest first. */
export function parseFeishu(json: unknown): Msg[] {
	const list = (json as { data?: { messages?: any[] } })?.data?.messages ?? [];
	return list
		.filter(m => m && !m.deleted && m.message_id)
		.map(m => ({ id: String(m.message_id), time: String(m.create_time ?? ""), sender: String(m.sender?.name ?? m.sender?.id ?? "?").trim(), text: String(m.content ?? "").replace(/!\[Image\]\([^)]*\)/g, "[image]").slice(0, 1500) }))
		.reverse();
}

/**
 * Thread replies, grouped by chat. Feishu's chat history only lists top-level messages, so replies inside
 * a thread ("话题") were never seen. One search per few minutes covers every chat; each chat takes its own.
 */
let threadCache: { at: number; byChat: Map<string, Msg[]> } | undefined;
export function parseFeishuThreads(json: unknown): Map<string, Msg[]> {
	const d = (json as { data?: Record<string, unknown> })?.data ?? {};
	const list = (Object.values(d).find(Array.isArray) ?? []) as any[];
	const by = new Map<string, Msg[]>();
	for (const m of list) {
		if (!m?.thread_id || m.deleted || !m.message_id || !m.chat_id) continue;
		const msg = { id: String(m.message_id), time: String(m.create_time ?? ""), sender: String(m.sender?.name ?? m.sender?.id ?? "?").trim(), text: "(in a thread) " + String(m.content ?? "").replace(/!\[Image\]\([^)]*\)/g, "[image]").slice(0, 1500) };
		by.set(m.chat_id, [...(by.get(m.chat_id) ?? []), msg]);
	}
	return by;
}
async function feishuThreads(now = Date.now()): Promise<Map<string, Msg[]>> {
	if (threadCache && now - threadCache.at < 4 * 60_000) return threadCache.byChat;
	const start = new Date(now - 2 * 86_400_000 + 8 * 3_600_000).toISOString().slice(0, 19) + "+08:00";
	try {
		const { stdout } = await run("lark-cli", ["im", "+messages-search", "--as", "user", "--start", start, "--page-size", "50", "--page-all", "--page-limit", "8", "--no-reactions"], { maxBuffer: 1 << 24, timeout: 90_000 });
		threadCache = { at: now, byChat: parseFeishuThreads(JSON.parse(stdout)) };
	} catch { threadCache = { at: now, byChat: threadCache?.byChat ?? new Map() }; }
	return threadCache.byChat;
}
/** Chat history plus its thread replies, oldest first by time (stable: same-minute order kept). */
export function withThreads(msgs: Msg[], threads: Msg[] = []): Msg[] {
	const have = new Set(msgs.map(m => m.id));
	const all = [...msgs, ...threads.filter(t => !have.has(t.id))];
	return all.map((m, i) => ({ m, i })).sort((a, b) => a.m.time.localeCompare(b.m.time) || a.i - b.i).map(x => x.m);
}

const feishu: Adapter = {
	async fetch(src) {
		// lark-cli sometimes fails with "token_invalid" while it refreshes the token: retry once.
		const args = ["im", "+chat-messages-list", "--as", "user", "--chat-id", src.id, "--order", "desc", "--page-size", "30", "--no-reactions"];
		const { stdout } = await run("lark-cli", args, { maxBuffer: 1 << 24, timeout: 60_000 }).catch(async () => { await new Promise(r => setTimeout(r, 3000)); return run("lark-cli", args, { maxBuffer: 1 << 24, timeout: 60_000 }); });
		return withThreads(parseFeishu(JSON.parse(stdout)), (await feishuThreads()).get(src.id));
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
		.filter(s => s?.username && (s.chat_type === "group" || s.chat_type === "private") && !/^gh_|holder$|^@|^notifymessage$/.test(String(s.username)) && !/holder$/.test(String(s.chat ?? "")) && Number(s.timestamp ?? 0) >= o.sinceSec && !skip.has(s.chat) && !skip.has(s.username))
		.slice(0, o.max ?? 30)
		.map(s => ({ kind: "wechat", id: String(s.username), name: `WeChat: ${String(s.chat ?? s.username).trim()}`, chat: s.chat_type }));
}

/** WeChat history -> Msg[], oldest first. In private chats the other side has an empty sender. */
export function parseWechat(json: unknown): Msg[] {
	const d = (json as { data?: { chat?: string; messages?: any[] } })?.data ?? {};
	return (d.messages ?? [])
		.filter(m => m && m.local_id != null)
		.map(m => ({ id: String(m.local_id), time: String(m.time ?? ""), sender: String(m.sender || d.chat || "?").trim(), text: String(m.content ?? "").slice(0, 1500) }));
}

/**
 * Read WeChat. When a read fails or hangs, stop the wx daemon so the next check starts a fresh one
 * (a stuck daemon otherwise fails every check). Locked Macs read fine with Full Disk Access.
 */
/**
 * One wechat-cli read. Sporadic failures (one chat at a time, about once a day) come from the wx daemon rebuilding its
 * decrypted message cache mid-read; a second try a moment later works. So: retry twice with backoff, then restart
 * the daemon and try once more. The thrown error keeps wechat-cli's own stderr, not just "Command failed".
 */
export async function wechatRead(args: string[], deps: { exec?: (cmd: string, a: string[], o: object) => Promise<{ stdout: string }>; sleep?: (ms: number) => Promise<void> } = {}) {
	const exec = deps.exec ?? run, sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
	const once = async () => JSON.parse((await exec("wechat-cli", args, { maxBuffer: 1 << 24, timeout: 45_000 })).stdout);
	let last: unknown;
	for (const wait of [0, 1500, 4000]) {
		if (wait) await sleep(wait);
		try { return await once(); } catch (e) { last = e; }
	}
	await exec("wx", ["daemon", "stop"], { timeout: 10_000 }).catch(() => {});
	try { return await once(); } catch (e) { last = e; }
	const e = last as Error & { stderr?: string };
	const why = String(e.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
	throw new Error(why ? `${e.message.split("\n")[0]}: ${why.slice(0, 200)}` : e.message);
}
const wechatCli = (args: string[]) => wechatRead(args);

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

/** App password from macOS Keychain (service pix-gmail). Never expires like OAuth testing tokens do. */
async function keychainPassword(account: string): Promise<string | undefined> {
	try { return (await run("security", ["find-generic-password", "-s", "pix-gmail", "-a", account, "-w"], { timeout: 10_000 })).stdout.trim(); } catch { return undefined; }
}

/**
 * IMAP through Clash drops often (TLS disconnect, closed, timeout; about 15 times in 4 days). Try the proxy twice with
 * backoff, then a direct connection. On final failure the cursor does not move (the daemon only marks after a good read),
 * so mail from a failed window is read on the next tick, never skipped.
 */
export async function gmailImapRetry<T>(read: (o: { proxy?: string; timeoutMs: number }) => Promise<T>, proxy: string | undefined, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<T> {
	const tries: (string | undefined)[] = proxy ? [proxy, proxy, undefined] : [undefined, undefined];
	let last: unknown;
	for (const [i, p] of tries.entries()) {
		if (i) await sleep(2000 * i);
		try { return await read({ proxy: p, timeoutMs: 40_000 }); } catch (e) { last = e; }
	}
	throw last;
}

/** Gmail inbox, read-only. Prefers IMAP + app password (Keychain); falls back to the Gmail MCP OAuth token.
 * Options: account (Gmail address), query (Gmail search; default: recent inbox, no promotions/social). */
const gmail: Adapter = {
	async fetch(src) {
		const q = String(src.query ?? "in:inbox newer_than:3d -category:promotions -category:social");
		const account = String(src.account ?? "yinghaotang2001@gmail.com");
		const pass = await keychainPassword(account);
		if (pass) return gmailImapRetry(o => fetchGmailImap({ user: account, pass, query: q, max: 20, ...o }), proxy || undefined);
		const token = await gmailToken();
		const auth = ["-H", `Authorization: Bearer ${token}`];
		const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
		const list = await curl([...auth, `${base}?maxResults=20&q=${encodeURIComponent(q)}`]);
		const full = await Promise.all((list.messages ?? []).map((m: any) => curl([...auth, `${base}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`])));
		return parseGmail(full);
	},
	howToRead: (src, refs) => `Gmail ${String(src.account ?? "yinghaotang2001@gmail.com")}, item ids ${refs.join(", ") || "n/a"} (IMAP UIDs in INBOX if numeric, else Gmail API ids). Easiest: search with the gmail MCP tool search_emails using the subject, then read_email.`,
};

/** One immutable local snapshot per expansion; each chat reads from the same batch. */
/**
 * DingTalk only writes its local DB while the app runs. Closed for days (10-19 to 10-22), the collector read a stale
 * snapshot that looked healthy, and a 学年小结 deadline was missed. So before each read: if DingTalk is not running,
 * start it hidden (open -ga) and say so. Returns true when it launched it.
 */
export async function ensureDingTalk(exec: (cmd: string, a: string[], o: object) => Promise<{ stdout: string }> = run): Promise<boolean> {
	try { await exec("pgrep", ["-x", "DingTalk"], { timeout: 5_000 }); return false; } catch { /* not running */ }
	await exec("open", ["-ga", "DingTalk"], { timeout: 15_000 });
	return true;
}
/** Newest message time in a snapshot (ISO), or undefined. */
export const newestTime = (chats: { messages: { time: string }[] }[]) => chats.flatMap(c => c.messages.map(m => m.time)).filter(t => !Number.isNaN(Date.parse(t))).sort().at(-1);
export const dingNewest: { at?: string; launched?: boolean } = {};
/**
 * When the DingTalk app last wrote its message database (newest of dingtalk.db and its -wal), in ms.
 * A quiet account (school groups silent for days) still syncs: the app keeps writing. Only a database
 * that stopped changing means DingTalk is closed, logged out or stuck.
 */
export function dingSyncedAt(root = dingRoot): number {
	try {
		const prof = readdirSync(root).filter(n => n.endsWith("_v3"))[0]; if (!prof) return 0;
		const db = join(root, prof, "DBFiles/dingtalk.db");
		return Math.max(...[db, db + "-wal"].map(f => { try { return statSync(f).mtimeMs; } catch { return 0; } }));
	} catch { return 0; }
}
/**
 * Apps that MagicQuit is set to quit after idling. A quit DingTalk/WeChat/Feishu stops syncing, so For you misses
 * messages: DingTalk was on that list and got quit every hour. Returns the watched apps on the list.
 */
export function autoQuitApps(json: string | undefined, watched = ["DingTalk", "WeChat", "微信", "Feishu", "Lark", "飞书"]): string[] {
	try { const t = JSON.parse(json ?? "{}"); return watched.filter(a => t[a] === true); } catch { return []; }
}
export async function magicQuitList(): Promise<string | undefined> {
	try {
		const { stdout } = await exec("defaults", ["export", "com.MagicQuit", "-"], { timeout: 5_000 });
		const m = String(stdout).match(/<key>com\.MagicQuit\.toggleStatus<\/key>\s*<data>([\s\S]*?)<\/data>/);
		return m ? Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8") : undefined;
	} catch { return undefined; }
}
/** Warn only when there are no new messages for 24 h AND the app has not synced for 24 h. Silence alone is not a fault. */
export function dingLooksStale(newestAt: string | undefined, syncedAtMs: number, now = Date.now()): boolean {
	const day = 24 * 3_600_000;
	return !!newestAt && now - Date.parse(newestAt) > day && now - syncedAtMs > day;
}

export function dingAdapters(load: (root?: string, account?: string) => DingChat[] | Promise<DingChat[]> = readDingTalkIsolated, ensure: () => Promise<boolean> = ensureDingTalk): { all: Adapter; chat: Adapter } {
	let snapshot: DingChat[] = [];
	const inFlight = new Map<string, Promise<DingChat[]>>();
	const howToRead = (_src: Source, _refs: string[]) => "DingTalk local Mac cache. Read with readDingTalk from src/dingtalk-local.ts; open DingTalk to sync. Attachments are not downloaded.";
	return {
		all: { fetch: async () => [], howToRead, expand: async src => {
			const root = typeof src.root === "string" ? src.root : undefined, account = typeof src.account === "string" ? src.account : undefined;
			const key = JSON.stringify([root, account]);
			let pending = inFlight.get(key);
			if (!pending) {
				pending = ensure().catch(() => false).then(l => { dingNewest.launched = l; if (l) return new Promise(r => setTimeout(r, 20_000)); }).then(() => load(root, account)).finally(() => inFlight.delete(key));
				inFlight.set(key, pending);
			}
			snapshot = await pending;
			dingNewest.at = newestTime(snapshot);
			return snapshot.map(c => ({ kind: "dingtalk", id: c.id, name: `DingTalk: ${c.name}`, me: c.me }));
		} },
		chat: { howToRead, fetch: async src => {
			const chat = snapshot.find(c => c.id === src.id);
			if (!chat) throw new Error("DingTalk chat snapshot unavailable; expand dingtalk-all first");
			return chat.messages;
		} },
	};
}
/** A Feishu AI meeting note (docs +fetch XML-ish content) as plain text: title, 参会人, 总结, 待办 (with who asked). */
export function meetingNoteText(content: string): string {
	const strip = (x: string) => x.replace(/<cite[^>]*user-name="([^"]*)"[^>]*><\/cite>/g, " $1 ").replace(/<(whiteboard|img|readonly-block)[^>]*>(<\/\1>)?/g, "").replace(/<li>/g, "\n- ").replace(/<\/(p|h1|li|ul|blockquote)>/g, "\n").replace(/<[^>]+>/g, "").replace(/&#xA;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
	const title = content.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
	const people = content.match(/参会人：([\s\S]*?)<\/p>/)?.[1] ?? "";
	const sec = (h: string) => content.match(new RegExp(`<h1>${h}</h1>([\\s\\S]*?)(?=<h1>|$)`))?.[1] ?? "";
	// Todos that name brook get a ⭐ so For you sees at once what is his.
	const todos = [...sec("待办").matchAll(/<checkbox done="(\w+)">([\s\S]*?)<\/checkbox>/g)].map(m => `- [${m[1] === "true" ? "x" : " "}] ${mine(m[2]) ? "⭐ " : ""}${strip(m[2])}`);
	return [title, people && `参会人：${strip(people)}`, sec("总结") && `总结：\n${strip(sec("总结"))}`, todos.length ? `待办：\n${todos.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
/** A todo is brook's when it names him outside the "（来自 …）" credit. */
const mine = (t: string) => /唐英豪|brook/i.test(t.replace(/（来自[^）]*）/g, ""));
/** Summary and todos from `minutes +detail --summary --todo` (shape varies by version: read loosely). */
export function minutesText(topic: string | undefined, data: any): string {
	const m = data?.minutes?.[0] ?? data?.items?.[0] ?? data ?? {};
	const summary = String(m.summary?.content ?? m.summary ?? "").trim();
	const todos = (m.todos ?? m.todo ?? []).map((t: any) => String(t.content ?? t.text ?? t)).filter(Boolean).map((t: string) => `- [ ] ${mine(t) ? "⭐ " : ""}${t}`);
	return summary || todos.length ? [topic, summary && `总结：\n${summary}`, todos.length ? `待办：\n${todos.join("\n")}` : ""].filter(Boolean).join("\n\n") : "";
}
/**
 * Feishu meetings brook attended: one message per meeting that has AI notes (id = meeting_id, so the daemon's
 * cursor dedupes). Ordered by note time: notes arrive minutes after the meeting, so a late note still lands after the cursor.
 * Meetings without notes are skipped (and retried next round).
 */
const feishuMeetings: Adapter = {
	async fetch(src) {
		const lark = async (args: string[]) => JSON.parse((await run("lark-cli", [...args, "--as", "user"], { maxBuffer: 1 << 24, timeout: 60_000 })).stdout);
		const days = Number(src.days ?? 2), start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10), end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		const found = (await lark(["vc", "+search", "--start", start, "--end", end, "--page-size", "30"])).data?.items ?? [];
		if (!found.length) return [];
		const meetings = (await lark(["vc", "+detail", "--meeting-ids", found.map((m: any) => m.id).join(",")])).data?.meetings ?? [];
		const out: Msg[] = [];
		for (const m of meetings) {
			if (!m.note_id && !m.minute_token) continue;
			try {
				const note = m.note_id ? (await lark(["note", "+detail", "--note-id", m.note_id])).data?.note : undefined, token = note?.note_doc_token;
				let text = token ? meetingNoteText((await lark(["docs", "+fetch", "--doc", token])).data?.document?.content ?? "") : "";
				// No AI notes doc: fall back to the minutes' own summary and todos (minute_token).
				if (!text && m.minute_token) text = minutesText(m.topic, (await lark(["minutes", "+detail", "--minute-tokens", m.minute_token, "--summary", "--todo"])).data);
				if (!text) continue;
				const link = token ? `https://byterum.feishu.cn/docx/${token}` : m.minute_token ? `https://byterum.feishu.cn/minutes/${m.minute_token}` : "";
				const when = m.start_time ? `${m.start_time}–${String(m.end_time ?? "").slice(11)}` : "";
				out.push({ id: String(m.meeting_id), time: String(note?.create_time || m.end_time || ""), sender: "Feishu meeting notes", text: [when, text, link && `文档：${link}`].filter(Boolean).join("\n\n").slice(0, 6000) });
			} catch { /* note not ready yet: next round */ }
		}
		return out.sort((a, b) => a.time.localeCompare(b.time));
	},
	howToRead: (_src, refs) => `Feishu meeting ${refs.join(", ") || "<meeting_id>"}. Read the AI notes with: lark-cli vc +detail --as user --meeting-ids <id> -> note +detail --note-id <note_id> -> docs +fetch --doc <note_doc_token> (all --as user).`,
};
const dingtalk = dingAdapters();
export const adapters: Record<string, Adapter> = { feishu, "feishu-all": feishuAll, wechat, "wechat-all": wechatAll, gmail, command, "dingtalk-all": dingtalk.all, dingtalk: dingtalk.chat, "feishu-meeting": feishuMeetings };

export interface ExpandHooks { onError?: (src: Source, error: Error) => void; onSuccess?: (src: Source) => void; guard?: (app: string) => Promise<string | undefined> }
/**
 * Config sources with any "many chats" entries expanded. Explicit entries win (they may carry a project).
 * One failing expansion (e.g. DingTalk without Mac permission) is reported via `onError` and skipped; the rest still run.
 */
export async function expandSources(sources: Source[], hooks: ExpandHooks = {}): Promise<Source[]> {
	const out: Source[] = [];
	const access = new Map<string, Promise<string | undefined>>();
	const guard = hooks.guard ?? guardApp;
	if (sources.some(x => /^wechat/.test(x.kind))) await reapWxDaemons().catch(() => 0);
	for (const src of sources) {
		const a = adapterFor(src);
		const app = /^wechat/.test(src.kind) ? "wechat" : /^dingtalk/.test(src.kind) ? "dingtalk" : undefined;
		if (app) {
			if (!access.has(app)) access.set(app, guard(app));
			const why = await access.get(app);
			if (why) { const err = new Error(why); if (!hooks.onError) throw err; hooks.onError(src, err); continue; }
		}
		if (!a.expand) { out.push(src); continue; }
		try { out.push(...await a.expand(src)); hooks.onSuccess?.(src); }
		catch (e) { const err = e instanceof Error ? e : new Error(String(e)); if (!hooks.onError) throw err; hooks.onError(src, err); }
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

/** Undefined when the app's data can be read; otherwise why not (sealed by a lock or a pending macOS prompt). */
export async function guardApp(app: string): Promise<string | undefined> {
	const a = await probeApp(app);
	return a === "sealed" ? sealedReason(app, await isLocked()) : undefined;
}
