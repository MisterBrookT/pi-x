// A semantic 1-3 word footer label for every pin, never a hash or a random host part.
// Order: a meaningful title (shortened) > what the URL says it is (PR #10, Docs preview, Arena, file name)
// > the real Feishu doc title (lark-cli) or a model's name for it, fetched once in the background and cached on the pin.
import { execFile } from "node:child_process";
import { basename, extname } from "node:path";
import { artifactsDir, loadArtifacts, type Artifact } from "./artifacts.ts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { artifactsPath } from "./artifacts.ts";

/** Looks like an id, token or hash rather than words. */
export function meaningless(t: string): boolean {
	const s = t.trim().replace(/\\+$/, "");
	if (s.length < 2 || /\$\{|`|token=|^https?:/i.test(s)) return true;
	if (/^[\w.-]+\.(com|fun|dev|app|io|cn|net|org)$/i.test(s)) return true; // a bare host
	if (/^[A-Za-z0-9_-]{12,}$/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return true; // mixed-case id
	if (/^[0-9a-f]{7,}$/i.test(s) || /^[\w]+_token$/i.test(s)) return true;
	return false;
}
const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const words = (s: string) => s.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().split(/\s+/).filter(w => w && !meaningless(w) && !/^\d+$/.test(w));
/** Cut to at most 3 words / ~20 chars at a word. CJK titles are cut to 8 characters. */
export function shorten(t: string): string {
	const s = t.replace(/\s+/g, " ").replace(/\s*[(（[].*$/, "").replace(/\s*([:：|｜—–]|\s-\s|\s\+\s).*$/, "").trim() || t.trim();
	if (/[\u3400-\u9fff]/.test(s) && !/\s/.test(s.slice(0, 10))) return s.length > 8 ? s.slice(0, 8) : s;
	let out = "";
	for (const w of s.split(" ").slice(0, 3)) { if ((out + " " + w).trim().length > 20) break; out = (out + " " + w).trim(); }
	return out || s.slice(0, 15) + "…";
}
/** What the URL itself says, or undefined when it says nothing meaningful. */
export function urlLabel(a: Pick<Artifact, "url" | "kind">): string | undefined {
	const u = a.url;
	const gh = u.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+)(?:\/(pull|issues)\/(\d+))?/);
	if (gh) return gh[2] ? `${gh[2] === "pull" ? "PR" : "Issue"} #${gh[3]}` : title(words(gh[1]).join(" ") || "Repo");
	if (a.kind === "file" || /^(~|\/)/.test(u)) { const w = words(basename(u, extname(u))); return w.length ? shorten(w.map((x, i) => i ? x : title(x)).join(" ")) : undefined; }
	let url: URL; try { url = new URL(u); } catch { return undefined; }
	const path = url.pathname.split("/").filter(Boolean).filter(p => !meaningless(p)).flatMap(words);
	if (/trycloudflare\.com$|\.pages\.dev$|\.workers\.dev$|\.vercel\.app$|ngrok/.test(url.hostname)) {
		const last = path.at(-1); return /^docs?$/i.test(last ?? "") ? "Docs preview" : last ? `${title(last)} preview` : "Preview";
	}
	if (/feishu|larksuite|larkoffice|docs\.google|notion/.test(url.hostname)) return undefined; // the token says nothing
	const sub = url.hostname.split(".").length > 2 ? url.hostname.split(".")[0] : "";
	const last = path.at(-1), hostWord = sub && !/^(www|app|rc|api)$/.test(sub) && !meaningless(sub) ? sub : "";
	if (last) return title(last);
	return hostWord ? title(hostWord) : undefined;
}

type Fetcher = (a: Artifact) => Promise<string | undefined>;
const feishuTitle: Fetcher = a => new Promise(res => {
	const tok = a.url.match(/\/(?:docx|docs|wiki|sheets|base)\/([A-Za-z0-9]+)/)?.[1];
	if (!tok || !/feishu|lark/.test(a.url)) return res(undefined);
	execFile("lark-cli", ["docs", "+fetch", "--doc", tok, "--scope", "outline", "--max-depth", "1", "-q", ".data.document.content"], { timeout: 30_000 }, (e, out) => {
		if (e) return res(undefined);
		res(String(out).match(/<title>([^<]+)<\/title>/)?.[1]);
	});
	// outline has no <title>; fall back to the first 300 chars of the full doc
}).then(t => t ?? new Promise<string | undefined>(res => {
	const tok = a.url.match(/\/(?:docx|docs|wiki|sheets|base)\/([A-Za-z0-9]+)/)?.[1];
	if (!tok) return res(undefined);
	execFile("lark-cli", ["docs", "+fetch", "--doc", tok, "-q", ".data.document.content"], { timeout: 30_000, maxBuffer: 1 << 24 }, (e, out) => res(e ? undefined : String(out).match(/<title>([^<]+)<\/title>/)?.[1]));
}));
const modelName: Fetcher = a => new Promise(res => {
	const child = execFile("pi", ["-p", "--no-session", "-nt", "-ne", "--model", "anthropic/claude-haiku-4-5", "--thinking", "off"], { timeout: 60_000 }, (e, out) => {
		const t = e ? "" : String(out).trim().split("\n").pop()!.replace(/^["'`]|["'`.]$/g, "");
		res(t && !meaningless(t) && t.split(/\s+/).length <= 4 ? t : undefined);
	});
	child.stdin?.end(`Name this pinned item for a footer in 1-3 plain English words (like "Docs preview", "Arena", "Q3 report"). Reply with only the name.\nTitle: ${a.title}\nURL: ${a.url.replace(/([?&](token|key|secret)=)[^&]+/gi, "$1…")}`);
});

const pending = new Set<string>();
/** Fill `label` in the background for pins that have no meaningful title or URL label; saved once, shown on the next read. */
export function resolveLabels(session: string, items: Artifact[], o: { dir?: string; feishu?: Fetcher; model?: Fetcher } = {}): Promise<void> {
	const dir = o.dir ?? artifactsDir();
	const need = items.filter(a => !a.label && meaningless(a.title) && !urlLabel(a) && !pending.has(session + a.url));
	if (!need.length) return Promise.resolve();
	for (const a of need) pending.add(session + a.url);
	return Promise.all(need.map(async a => [a.url, (await (o.feishu ?? feishuTitle)(a).catch(() => undefined)) ?? (await (o.model ?? modelName)(a).catch(() => undefined))] as const)).then(found => {
		const got = new Map(found.filter(([, t]) => t) as [string, string][]);
		if (!got.size) return;
		const now = loadArtifacts(session, dir).map(x => got.has(x.url) ? { ...x, label: shorten(got.get(x.url)!) } : x);
		mkdirSync(dir, { recursive: true });
		const f = artifactsPath(session, dir), t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(now, null, 1)); renameSync(t, f);
	}).finally(() => { for (const a of need) pending.delete(session + a.url); });
}

/** The label to show now (sync). A pin still being named shows its kind ("Doc", "Link", "File") until then. */
export function pinLabel(a: Artifact): string {
	if (a.label) return a.label;
	const fromUrl = urlLabel(a);
	if (/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(a.url) && fromUrl) return fromUrl;
	if ((a.kind === "file" || /^(~|\/)/.test(a.url)) && fromUrl && a.title.trim() === basename(a.url)) return fromUrl;
	if (!meaningless(a.title)) { const t = shorten(a.title); return t.charAt(0).toUpperCase() + t.slice(1); }
	return fromUrl ?? ({ doc: "Doc", link: "Link", file: "File" } as const)[a.kind];
}
