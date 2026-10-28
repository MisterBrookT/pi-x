// Session artifacts: docs, links and files a session made for brook, pinned to that session.
// Footer shows "Docs 2 · Links 3 · Files 1"; the phone lists them per session. One JSON file per session id
// in ~/.pix/artifacts/<id>.json so the footer, the remote hub and other sessions can all read it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pinLabel } from "./pin-label.ts";

export type ArtifactKind = "doc" | "link" | "file";
export type Artifact = { title: string; url: string; kind: ArtifactKind; at: number; /** Open loops the session held when it pinned this; when all are closed the pin's job has ended. */ loops?: string[]; /** A cached semantic label (core/pin-label.ts). */ label?: string; /** Retired when a newer pin pushed it past the 3 live ones; it stays in the full list. */ retired?: boolean; /** The line (lines.json id) of the session that pinned it. */ line?: string };

export const artifactsDir = () => process.env.PIX_ARTIFACTS_DIR ?? join(homedir(), ".pix", "artifacts");
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
export const artifactsPath = (session: string, dir = artifactsDir()) => join(dir, `${safe(session)}.json`);

/** Feishu/Lark/Google/Notion documents are docs; local paths are files; everything else is a link. */
export function artifactKind(url: string): ArtifactKind {
	if (/^(~|\/)/.test(url)) return "file";
	if (/^https?:\/\/[^/]*(feishu\.cn|larksuite\.com|larkoffice\.com)\/(docx|docs|wiki|sheets|base|file)\//.test(url)) return "doc";
	if (/^https?:\/\/(docs\.google\.com|[^/]*notion\.(so|site))\//.test(url)) return "doc";
	return "link";
}

export function loadArtifacts(session: string, dir = artifactsDir()): Artifact[] {
	try { const a = JSON.parse(readFileSync(artifactsPath(session, dir), "utf8")); return Array.isArray(a) ? a.filter(x => x && typeof x.url === "string") : []; } catch { return []; }
}

function save(session: string, items: Artifact[], dir: string) {
	mkdirSync(dir, { recursive: true });
	const f = artifactsPath(session, dir), tmp = `${f}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(items, null, 1)); renameSync(tmp, f);
}

/** Pin (or retitle) an item; the same URL is kept once. Newest last. Returns the list. */
export function pinArtifact(session: string, item: { title?: string; url: string; kind?: ArtifactKind; loops?: string[]; line?: string }, dir = artifactsDir(), now = Date.now()): Artifact[] {
	const url = item.url.trim();
	if (!url) return loadArtifacts(session, dir);
	const old = loadArtifacts(session, dir);
	const prev = old.find(x => x.url === url);
	const title = (item.title?.trim() || prev?.title || url.split(/[/?#]/).filter(Boolean).pop() || url).slice(0, 120);
	const all = [...old.filter(x => x.url !== url), { title, url, kind: item.kind ?? artifactKind(url), at: prev?.at ?? now, ...((item.line ?? prev?.line) ? { line: item.line ?? prev?.line } : {}), ...((item.loops ?? prev?.loops)?.length ? { loops: item.loops ?? prev?.loops } : {}) }].slice(-50);
	// At most 3 live pins per session: a 4th retires the oldest live one.
	const live = all.filter(x => !x.retired), items = all.map(x => x.retired || live.indexOf(x) >= live.length - 3 ? x : { ...x, retired: true });
	save(session, items, dir);
	return items;
}

export function unpinArtifact(session: string, url: string, dir = artifactsDir()): Artifact[] {
	const items = loadArtifacts(session, dir).filter(x => x.url !== url && x.title !== url);
	save(session, items, dir);
	return items;
}

/** "Docs 2 · Links 3 · Files 1", or "" when nothing is pinned. */
export function artifactsLabel(items: Artifact[]): string {
	const n = (k: ArtifactKind) => items.filter(x => x.kind === k).length;
	return ([["Docs", n("doc")], ["Links", n("link")], ["Files", n("file")]] as const).filter(([, c]) => c).map(([l, c]) => `${l} ${c}`).join(" · ");
}

/** A short semantic footer label (core/pin-label.ts): never a hash or a random host part. */
export function artifactShort(a: Pick<Artifact, "title" | "url"> & Partial<Artifact>): string { return pinLabel({ kind: artifactKind(a.url), at: 0, ...a } as Artifact); }

/** Pins whose job ended (all their loops closed, or a PR merged/closed) drop behind "+N". `isOpen(loopId)` and `prDone(url)` are injected. */
export function artifactEnded(a: Artifact, o: { isOpen?: (loop: string) => boolean; prDone?: (url: string) => boolean } = {}): boolean {
	if (a.loops?.length && o.isOpen && !a.loops.some(o.isOpen)) return true;
	return /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(a.url) && !!o.prDone?.(a.url);
}

/** Footer: the newest 3 live pins, then "+N" for the rest (older or ended). Items are oldest first. */
export function footerPins<T extends Artifact>(items: T[], ended: (a: T) => boolean = () => false, show = 3, main?: string): { shown: T[]; more: number } {
	const ok = items.filter(a => !a.retired && !ended(a)), rev = ok.slice().reverse();
	// The main line's pins first (newest first), then the newest others.
	const live = [...rev.filter(a => main && a.line === main), ...rev.filter(a => !main || a.line !== main)].slice(0, show);
	return { shown: live, more: items.length - live.length };
}

/** Terminal links straight to the targets: the newest 3 live pins by short label, then "+N". Files open as file:// URLs. */
export function artifactLinks(items: Artifact[], home = homedir(), ended: (a: Artifact) => boolean = () => false, main?: string): { label: string; url: string }[] {
	const target = (a: Artifact) => a.kind === "file" ? "file://" + encodeURI(a.url.replace(/^~(?=\/|$)/, home)) : a.url;
	const { shown, more } = footerPins(items, ended, 3, main);
	return [...shown.map(a => ({ label: artifactShort(a), url: target(a) })), ...(more ? [{ label: `+${more}`, url: "" }] : [])];
}

/** Hide secrets in text that may reach logs or the agent: query tokens/keys become "…". */
export const redactUrl = (url: string) => url.replace(/([?&](token|key|secret|sig|signature|access_token|auth)=)[^&#\s]+/gi, "$1…");

/**
 * Obvious artifacts in a tool's output: a doc URL from a "docs +create"/lark-cli run, or a deploy URL
 * ("live at …", "Deployed to …", wrangler/Vercel/Pages URLs) from a deploy command.
 */
export function detectArtifacts(command: string, output: string): { title?: string; url: string }[] {
	const found = new Map<string, { title?: string; url: string }>();
	const urls = (s: string) => [...s.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map(m => m[0].replace(/[.,;:]+$/, ""));
	if (/lark-cli|\bdocs?\s+\+create|feishu/i.test(command)) {
		for (const u of urls(output)) if (artifactKind(u) === "doc") {
			const t = output.match(/"title"\s*:\s*"([^"]{1,120})"/)?.[1] ?? command.match(/--title[= ]["']?([^"'\n]{1,120})/)?.[1];
			found.set(u, { url: u, ...(t ? { title: t } : {}) });
		}
	}
	if (/deploy|wrangler|vercel|netlify|firebase|fly\b|pages/i.test(command)) {
		for (const line of output.split("\n")) {
			if (!/(live at|deployed (to|at)|published (to|at)|production:|preview:|available at|url:)/i.test(line) && !/\.(workers|pages)\.dev|\.vercel\.app|\.netlify\.app|\.web\.app|\.fly\.dev/.test(line)) continue;
			for (const u of urls(line)) if (!/dash\.cloudflare|vercel\.com\/|\/inspect/.test(u)) found.set(u, { url: u });
		}
	}
	return [...found.values()].slice(0, 5);
}
