// Has a pin's job ended? Its loops are all closed, or its GitHub PR is merged or closed.
// Synchronous for the footers: loop state is read from inbox.jsonl (cached 5 s), PR state is fetched with `gh`
// in the background and cached 10 min (unknown counts as not ended).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { artifactEnded, type Artifact } from "./artifacts.ts";

const OPEN = new Set(["pending", "onit", "later", "waiting"]);
const proactiveDir = () => process.env.PIX_PROACTIVE_DIR || join(homedir(), ".pix", "proactive");
let loops: { at: number; dir: string; byId: Map<string, any> } = { at: 0, dir: "", byId: new Map() };
function loopMap(dir: string) {
	if (loops.dir !== dir || Date.now() - loops.at > 5000) {
		const byId = new Map<string, any>(), f = join(dir, "inbox.jsonl");
		if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n")) { try { const e = JSON.parse(l); if (e?.id) byId.set(e.id, { ...byId.get(e.id), ...e }); } catch {} }
		loops = { at: Date.now(), dir, byId };
	}
	return loops.byId;
}
/** Open loop ids a session holds now (recorded on a pin so the pin can retire with them). */
export function openLoopIdsHeldBy(session: string, dir = proactiveDir()): string[] {
	return [...loopMap(dir).values()].filter(i => OPEN.has(i.status) && i.session === session).map(i => String(i.id));
}
const prs = new Map<string, { at: number; done: boolean }>();
type Gh = (url: string, done: (state: string | undefined) => void) => void;
const ghState: Gh = (url, done) => execFile("gh", ["pr", "view", url, "--json", "state", "-q", ".state"], { timeout: 15_000 }, (e, out) => done(e ? undefined : String(out).trim()));
export function prDone(url: string, gh: Gh = ghState): boolean {
	const c = prs.get(url);
	if (!c || Date.now() - c.at > 600_000) { prs.set(url, { at: Date.now(), done: c?.done ?? false }); gh(url, s => { if (s) prs.set(url, { at: Date.now(), done: s === "MERGED" || s === "CLOSED" }); }); }
	return prs.get(url)!.done;
}
export const pinEnded = (dir = proactiveDir(), gh?: Gh) => (a: Artifact) => artifactEnded(a, { isOpen: id => { const i = loopMap(dir).get(id); return !i || OPEN.has(i.status); }, prDone: u => prDone(u, gh) });
