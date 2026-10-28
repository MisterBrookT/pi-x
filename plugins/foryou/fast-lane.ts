// Fast lane: every ~1 min, look only for asks to brook (Feishu @mentions and DMs via one messages-search,
// WeChat private chats and groups that @ him, Gmail from people For you knows). The full sweep stays every
// ~10 min. Both use the same cursors, so a batch judged here is never judged again by the sweep.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultMeAliases, type Msg, type Source } from "./proactive.ts";

const run = promisify(execFile);

/** Feishu messages-search result -> one feishu source per chat with an ask newer than its cursor time. */
export function feishuAskChats(json: unknown, cursorTime: (key: string) => string | undefined): Source[] {
	const out = new Map<string, Source>();
	for (const m of (json as { data?: { messages?: any[] } })?.data?.messages ?? []) {
		if (!m?.chat_id || m.deleted) continue;
		const key = `feishu:${m.chat_id}`, t = String(m.create_time ?? "");
		const seen = cursorTime(key);
		if (seen && t && t <= seen) continue;
		if (!out.has(key)) out.set(key, { kind: "feishu", id: String(m.chat_id), name: String(m.chat_name || m.chat_partner?.name || m.sender?.name || m.chat_id).trim(), ...(m.chat_type === "p2p" ? { chat: "private" } : {}) });
	}
	return [...out.values()];
}

/** A WeChat group preview that @s brook ("@布 brook", "[有人@我]"). */
const atMe = (summary: string, aliases: string[]) => /\[有人@我\]|\[@me\]/i.test(summary) || aliases.some(a => summary.includes(`@${a}`));

/** WeChat chat list -> private chats and @-me groups whose last message is newer than the cursor and not his own. */
export function wechatAskChats(json: unknown, cursorUnix: (key: string) => number, aliases = defaultMeAliases, exclude: string[] = []): Source[] {
	const skip = new Set(exclude);
	return ((json as { data?: { sessions?: any[] } })?.data?.sessions ?? [])
		.filter(s => s?.username && !/^gh_|holder$|^@|^notifymessage$/.test(String(s.username)) && !skip.has(s.chat) && !skip.has(s.username))
		.filter(s => s.chat_type === "private" || (s.chat_type === "group" && atMe(String(s.summary ?? ""), aliases)))
		.filter(s => Number(s.timestamp ?? 0) > cursorUnix(`wechat:${s.username}`))
		.filter(s => !aliases.includes(String(s.last_sender ?? "").trim()))
		.map(s => ({ kind: "wechat", id: String(s.username), name: `WeChat: ${String(s.chat ?? s.username).trim()}`, chat: s.chat_type }));
}

/** Gmail: only messages from a person For you has a memory card for count as an ask in the fast lane. */
export const fromKnown = (msgs: Msg[], people: string[]) => msgs.filter(m => people.some(p => p.length >= 2 && m.sender.toLowerCase().includes(p.toLowerCase())));
export const knownPeople = (memoryDir: string): string[] => { const d = join(memoryDir, "people"); return existsSync(d) ? readdirSync(d).filter(f => f.endsWith(".md")).map(f => f.slice(0, -3)) : []; };

/** "2026-10-28 16:17" (local, as the chat tools print it) or ISO -> unix seconds; 0 when unknown. */
export const toUnix = (t: string | undefined, tzHours = 8) => {
	if (!t) return 0;
	const m = t.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/);
	if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) / 1000 - tzHours * 3600;
	return Date.parse(t) / 1000 || 0;
};

/** Judge budget for the fast lane: at most `perHour` batches in any rolling hour. */
export function underBudget(log: number[], now: number, perHour: number): boolean {
	while (log.length && now - log[0] > 3_600_000) log.shift();
	return log.length < perHour;
}

/** The ask sources for one fast tick. Errors in one app do not stop the others. */
export async function fastSources(cfg: { sources: Source[] }, state: Record<string, string>, onError: (what: string, e: Error) => void): Promise<Source[]> {
	const out: Source[] = [];
	const tz = -new Date().getTimezoneOffset() / 60;
	const since = new Date(Date.now() - 30 * 60_000 + tz * 3_600_000).toISOString().slice(0, 19) + `${tz >= 0 ? "+" : "-"}${String(Math.abs(tz)).padStart(2, "0")}:00`;
	if (cfg.sources.some(s => s.kind === "feishu-all" || s.kind === "feishu")) {
		const cur = (k: string) => state[`${k}@t`];
		for (const extra of [["--is-at-me"], ["--chat-type", "p2p"]]) {
			try {
				const { stdout } = await run("lark-cli", ["im", "+messages-search", "--as", "user", ...extra, "--start", since, "--page-size", "50", "--no-reactions"], { maxBuffer: 1 << 23, timeout: 30_000 });
				for (const s of feishuAskChats(JSON.parse(stdout), cur)) if (!out.some(o => o.kind === s.kind && o.id === s.id)) out.push(s);
			} catch (e) { onError("Feishu", e as Error); }
		}
	}
	const wx = cfg.sources.find(s => s.kind === "wechat-all");
	if (wx) {
		try {
			const { stdout } = await run("wechat-cli", ["msg", "get_msg_chat_list", "{}"], { maxBuffer: 1 << 23, timeout: 20_000 });
			out.push(...wechatAskChats(JSON.parse(stdout), k => toUnix(state[`${k}@t`], tz), [...defaultMeAliases, String(wx.me ?? "")].filter(Boolean), (wx.exclude as string[]) ?? []).map(s => ({ ...s, ...(wx.me ? { me: wx.me } : {}) })));
		} catch (e) { onError("WeChat", e as Error); }
	}
	for (const g of cfg.sources.filter(s => s.kind === "gmail")) out.push({ ...g, fastKnownOnly: true });
	// Unfiltered local sources (website review comments) are cheap to read: every fast tick.
	out.push(...cfg.sources.filter(s => s.always));
	return out;
}
