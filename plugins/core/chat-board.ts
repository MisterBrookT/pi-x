/** Read-only view of the session chat board (~/.pi/agent/chat/<name>/me.json), for plugins that only need to look. */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BoardEntry { name: string; cwd: string; pid: number; doing?: string; status?: string; claims?: string[]; at: number }
const alive = (pid: number) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

export function readBoard(root = process.env.PIX_CHAT_DIR ?? join(homedir(), ".pi/agent/chat")): BoardEntry[] {
	let names: string[] = [];
	try { names = readdirSync(root); } catch { return []; }
	return names.flatMap(n => { try { const p = JSON.parse(readFileSync(join(root, n, "me.json"), "utf8")); return p?.name && alive(p.pid) ? [p as BoardEntry] : []; } catch { return []; } })
		.sort((a, b) => a.name.localeCompare(b.name));
}
