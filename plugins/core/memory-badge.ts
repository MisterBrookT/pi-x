// For you's memory, as the footer and phone see it: how many lines were added since brook last looked.
// Shared so the footer can show "Memory +1" without importing the For you plugin.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const proactiveDir = () => process.env.PIX_PROACTIVE_DIR ?? join(homedir(), ".pix/proactive");
export const memorySeenAt = (dir = proactiveDir()): string => { try { return String(JSON.parse(readFileSync(join(dir, "memory-seen.json"), "utf8")).at ?? ""); } catch { return ""; } };
export const markMemorySeen = (dir = proactiveDir(), now = new Date()) => writeFileSync(join(dir, "memory-seen.json"), JSON.stringify({ at: now.toISOString() }));
/** Lines added to memory.log after the last look. */
export function memoryUnseen(dir = proactiveDir()): number {
	let text = ""; try { text = readFileSync(join(dir, "memory.log"), "utf8"); } catch { return 0; }
	const seen = memorySeenAt(dir);
	return text.split("\n").filter(l => / \S+ \+ /.test(l) && l.slice(0, l.indexOf(" ")) > seen).length;
}
