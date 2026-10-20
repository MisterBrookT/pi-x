/** Read-only view of the session chat board (~/.pi/agent/chat/<name>/me.json), for plugins that only need to look. */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BoardEntry { name: string; cwd: string; pid: number; session?: string; doing?: string; status?: string; claims?: string[]; at: number }
const alive = (pid: number) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

export function readBoard(root = process.env.PIX_CHAT_DIR ?? join(homedir(), ".pi/agent/chat")): BoardEntry[] {
	let names: string[] = [];
	try { names = readdirSync(root); } catch { return []; }
	return names.flatMap(n => { try { const p = JSON.parse(readFileSync(join(root, n, "me.json"), "utf8")); return p?.name && alive(p.pid) ? [p as BoardEntry] : []; } catch { return []; } })
		.sort((a, b) => a.name.localeCompare(b.name));
}

const chatRootDir = () => process.env.PIX_CHAT_DIR ?? join(homedir(), ".pi/agent/chat");
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pi";

/** The board name of a live session: same folder, and its name (or name-2, name-3…) matches. */
export function boardNameFor(s: { id?: string; name: string; cwd: string }, root = chatRootDir()): string | undefined {
	const board = readBoard(root);
	// The board entry that IS this session wins: several sessions in one folder share a name (minara, minara-2, …).
	const own = s.id ? board.find(b => b.session === s.id) : undefined;
	if (own) return own.name;
	const base = slugOf(s.name);
	const hits = board.filter(b => b.cwd === s.cwd && (b.name === base || b.name.startsWith(`${base}-`)));
	return hits.length === 1 ? hits[0].name : hits.find(b => b.name === base)?.name;
}

/**
 * Drop a chat message in a session's inbox (same file format as the chat plugin), so For you can hand work out
 * and get the reply back on the same thread. Returns the thread id.
 */
export function sendChat(from: string, to: string, kind: "note" | "ask" | "handoff", text: string, root = chatRootDir()): string {
	const id = randomUUID().slice(0, 8), at = Date.now();
	const note = { id, from, kind, text, thread: id, hop: 0, at, logged: true };
	const dir = join(root, to, "inbox");
	mkdirSync(dir, { recursive: true });
	try { appendFileSync(join(root, "log.md"), `\n### ${new Date(at).toLocaleString("sv-SE")} · ${from} → ${to} · ${kind} · thread ${id}\n\n${text}\n`); } catch {}
	const f = join(dir, `${at}-${id}.json`), t = `${f}.${process.pid}.tmp`;
	writeFileSync(t, JSON.stringify(note)); renameSync(t, f);
	return id;
}
