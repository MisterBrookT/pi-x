/**
 * avatarkit: a person's real photo, cached on this Mac (~/.pix/avatars, never committed).
 *  - WeChat: head image URL from wx-cli's decrypted contact cache (~/.wx-cli/cache/*.db, table `contact`).
 *  - Feishu: lark-cli user search (search/v1/user) avatar_240 (needs a user login with contact scopes; else initials).
 *  - DingTalk, Gmail: no photo; the page falls back to initials.
 * Source app icons (the small badge) come from the installed Mac apps.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WhoSource = "wechat" | "feishu" | "dingtalk" | "gmail" | "pi";
export interface Who { name: string; source?: WhoSource; id?: string }

const home = () => process.env.PIX_HOME_OVERRIDE || homedir();
export const avatarDir = () => join(home(), ".pix", "avatars");
const WEEK = 7 * 86_400_000;

/** The source kind of a loop, from its kind/source/sourceKey. */
export function sourceOf(x: { kind?: string; source?: string; sourceKey?: string }): WhoSource {
	const k = `${x.kind ?? ""} ${x.sourceKey ?? ""} ${x.source ?? ""}`;
	return /gmail|mail/i.test(k) ? "gmail" : /wechat/i.test(k) ? "wechat" : /dingtalk/i.test(k) ? "dingtalk" : /feishu|lark/i.test(k) ? "feishu" : "pi";
}

export const avatarKey = (w0: Who) => { const w = resolveWho(w0); return createHash("sha1").update(`${w.source ?? ""}:${w.id || w.name}`).digest("hex").slice(0, 16); };

function sh(cmd: string, args: string[], timeout = 15_000): string {
	try { return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 << 20 }); } catch { return ""; }
}
const sqlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function wechatContactDb(): string | undefined {
	const dir = join(home(), ".wx-cli", "cache");
	try {
		for (const f of readdirSync(dir).filter(f => f.endsWith(".db"))) if (/\bcontact\b/.test(sh("sqlite3", [join(dir, f), ".tables"], 5000))) return join(dir, f);
	} catch {}
	return undefined;
}

/** WeChat: exact wxid, else remark/nickname match (exact first, then prefix). Returns the head image URL. */
export function wechatHead(w: Who): string | undefined {
	const db = wechatContactDb(); if (!db) return undefined;
	const exact = (w as any).exact, where = w.id ? `username=${sqlQuote(w.id)}` : exact ? `remark=${sqlQuote(w.name)} OR nick_name=${sqlQuote(w.name)}` : `remark=${sqlQuote(w.name)} OR nick_name=${sqlQuote(w.name)} OR remark LIKE ${sqlQuote(w.name + "%")}`;
	const row = sh("sqlite3", [db, `select coalesce(nullif(big_head_url,''),small_head_url) from contact where (${where}) and username not like '%@chatroom' and coalesce(small_head_url,'')<>'' limit 1`], 5000).trim();
	return /^https?:\/\//.test(row) ? row : undefined;
}

const wechatExact = (w: Who) => w.id ? wechatHead(w) : wechatHead({ ...w, exact: true } as Who);
function feishuExact(w: Who): string | undefined {
	try { const users: any[] = JSON.parse(sh("lark-cli", ["api", "GET", "/open-apis/search/v1/user", "--as", "user", "--params", JSON.stringify({ query: w.name })]) || "{}").data?.users ?? [];
		const hit = users.filter(u => u.name === w.name); return hit.length === 1 ? hit[0].avatar?.avatar_240 : undefined; } catch { return undefined; }
}

/** Feishu: user search (search/v1/user) returns the photo; match the open_id when known, else the first hit by name. */
export function feishuHead(w: Who): string | undefined {
	try {
		const users: any[] = JSON.parse(sh("lark-cli", ["api", "GET", "/open-apis/search/v1/user", "--as", "user", "--params", JSON.stringify({ query: w.name })]) || "{}").data?.users ?? [];
		const u = users.find(x => w.id && x.open_id === w.id) ?? users[0];
		return u?.avatar?.avatar_240 || u?.avatar?.avatar_72;
	} catch { return undefined; }
}

/**
 * Aliases: ~/.pix/avatars/aliases.json maps a name as loops say it to a real account, e.g.
 * {"陈老师": {"source": "wechat", "id": "wxid_..."}}. Needed when the name is ambiguous ("陈老师" = several contacts)
 * or the source has no photos (Gmail, DingTalk).
 */
export function resolveWho(w: Who): Who {
	try { const a = JSON.parse(readFileSync(join(avatarDir(), "aliases.json"), "utf8"))[w.name]; if (a?.source) return { name: a.name ?? w.name, source: a.source, id: a.id }; } catch {}
	return w;
}

/** Cached photo path for a person, fetching it at most weekly; undefined = use initials. A miss is cached too. */
export function avatarFile(w: Who, o: { fetchUrl?: (url: string) => Buffer | undefined; lookup?: (w: Who) => string | undefined } = {}): string | undefined {
	if (!w.name && !w.id) return undefined;
	const dir = avatarDir(); mkdirSync(dir, { recursive: true });
	const file = join(dir, avatarKey(w) + ".jpg"), miss = file + ".miss";
	const fresh = (f: string) => existsSync(f) && Date.now() - statSync(f).mtimeMs < WEEK;
	if (fresh(file)) return file;
	if (fresh(miss)) return existsSync(file) ? file : undefined;
	// The loop's own app first; then the other app, by exact name only (a guess must not show a stranger's face).
	const lookup = o.lookup ?? ((x: Who) => { const r = resolveWho(x);
		return r.source === "wechat" ? wechatHead(r) ?? feishuExact(r) : r.source === "feishu" ? feishuHead(r) ?? wechatExact(r) : wechatExact(r) ?? feishuExact(r); });
	const url = lookup(w);
	const data = url ? (o.fetchUrl ?? curl)(url) : undefined;
	if (data && data.length > 200) { writeFileSync(file, data); return file; }
	writeFileSync(miss, "");
	return existsSync(file) ? file : undefined;
}

function curl(url: string): Buffer | undefined {
	try { return execFileSync("curl", ["-fsSL", "--max-time", "10", url], { timeout: 12_000, maxBuffer: 4 << 20 }); } catch { return undefined; }
}

/** Source app icons from the installed Mac apps, as 96px PNGs (cached). */
const APPS: Record<string, [string, string]> = {
	wechat: ["/Applications/WeChat.app", "AppIcon"], feishu: ["/Applications/Lark.app", "app"], dingtalk: ["/Applications/DingTalk.app", "AppIcon"],
	gmail: ["/System/Applications/Mail.app", "ApplicationIcon"], pi: ["/Applications/Otty.app", ""], minara: ["/Applications/Minara.app", ""],
};
export function sourceIconFile(source: string): string | undefined {
	const app = APPS[source]; if (!app) return undefined;
	const dir = join(avatarDir(), "apps"); mkdirSync(dir, { recursive: true });
	const out = join(dir, source + ".png");
	if (existsSync(out)) return out;
	try {
		const r = join(app[0], "Contents/Resources"), f = readdirSync(r).find(x => x.endsWith(".icns") && x.startsWith(app[1]));
		if (f) execFileSync("sips", ["-s", "format", "png", "-Z", "96", join(r, f), "--out", out], { stdio: "ignore" });
	} catch {}
	return existsSync(out) ? out : undefined;
}

export const readFileOrUndefined = (f?: string) => { try { return f ? readFileSync(f) : undefined; } catch { return undefined; } };
