/** How a card names a session: its unique board name (minara-2, not "minara" twice) plus a short "what it's doing" hint. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { boardNameFor, readBoard, type BoardEntry } from "./chat-board.ts";

const statusPath = () => join(process.env.PIX_PROACTIVE_DIR ?? join(homedir(), ".pix/proactive"), "status.json");
export const shortHint = (s: string, n = 30) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

export function sessionLabeler(board: BoardEntry[] = readBoard(), status?: Record<string, { line?: string }>) {
	if (!status) { try { status = JSON.parse(readFileSync(statusPath(), "utf8")); } catch { status = {}; } }
	return (s: { id: string; name: string; cwd: string }): { name: string; hint?: string } => {
		const name = board.find(b => b.session === s.id)?.name ?? (() => { try { return boardNameFor(s); } catch { return undefined; } })() ?? s.name;
		const line = status?.[s.id]?.line;
		return { name, ...(line ? { hint: shortHint(line) } : {}) };
	};
}
