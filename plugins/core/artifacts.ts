// Session artifacts: docs, links and files a session made for brook, pinned to that session.
// Footer shows "Docs 2 · Links 3 · Files 1"; the phone lists them per session. One JSON file per session id
// in ~/.pix/artifacts/<id>.json so the footer, the remote hub and other sessions can all read it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ArtifactKind = "doc" | "link" | "file";
export type Artifact = { title: string; url: string; kind: ArtifactKind; at: number };

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
export function pinArtifact(session: string, item: { title?: string; url: string; kind?: ArtifactKind }, dir = artifactsDir(), now = Date.now()): Artifact[] {
	const url = item.url.trim();
	if (!url) return loadArtifacts(session, dir);
	const old = loadArtifacts(session, dir);
	const prev = old.find(x => x.url === url);
	const title = (item.title?.trim() || prev?.title || url.split(/[/?#]/).filter(Boolean).pop() || url).slice(0, 120);
	const items = [...old.filter(x => x.url !== url), { title, url, kind: item.kind ?? artifactKind(url), at: prev?.at ?? now }].slice(-50);
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
