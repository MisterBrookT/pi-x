// Filtered: every batch the cheap filter judged, so brook can see what was dropped, bring one back to For you,
// and set a per-chat rule (always show / always mute). Data: judgments.jsonl (kind "filter") + rules.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./proactive.ts";

export type ChatRule = "show" | "mute";
export interface FilteredMsg { id: string; sender: string; time?: string; text?: string }
export interface FilteredBatch { at: string; source: string; sourceKey: string; count: number; pass: boolean; why: string; msgs: FilteredMsg[]; rule?: ChatRule; broughtBack?: boolean }

const rulesFile = (dir?: string) => join(paths(dir).dir, "rules.json");
const backFile = (dir?: string) => join(paths(dir).dir, "brought-back.json");
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f: string, v: unknown) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v, null, 2)); renameSync(t, f); };

export const readRules = (dir?: string): Record<string, ChatRule> => readJson(rulesFile(dir), {});
export function setRule(sourceKey: string, rule: ChatRule | "none", dir?: string): Record<string, ChatRule> {
	const r = readRules(dir);
	if (rule === "none") delete r[sourceKey]; else r[sourceKey] = rule;
	writeJson(rulesFile(dir), r);
	return r;
}
export const isRule = (v: unknown): v is ChatRule | "none" => v === "show" || v === "mute" || v === "none";

/** The id of one batch in the list: its time and chat (stable, no index). */
export const batchId = (b: { at: string; sourceKey: string }) => Buffer.from(`${b.at}|${b.sourceKey}`).toString("base64url");

/** Newest first. Only judged batches (errors and skips are not shown). */
export function filteredView(dir?: string, limit = 200): { batches: (FilteredBatch & { id: string })[]; rules: Record<string, ChatRule> } {
	const file = paths(dir).judgments;
	const rules = readRules(dir), back = new Set(readJson<string[]>(backFile(dir), []));
	const out: (FilteredBatch & { id: string })[] = [];
	const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
	for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
		let j: any; try { j = JSON.parse(lines[i]); } catch { continue; }
		if (j?.kind !== "filter" || !j.verdict || !Array.isArray(j.fresh)) continue;
		const b = { at: String(j.at), source: String(j.source ?? ""), sourceKey: String(j.sourceKey ?? ""), count: j.fresh.length, pass: !!j.verdict.pass, why: String(j.verdict.why ?? "").slice(0, 200), msgs: j.fresh.map((m: any) => ({ id: String(m.id), sender: String(m.sender ?? ""), ...(m.time ? { time: String(m.time) } : {}), ...(m.text ? { text: String(m.text).slice(0, 1500) } : {}) })) };
		const id = batchId(b);
		out.push({ ...b, id, ...(rules[b.sourceKey] ? { rule: rules[b.sourceKey] } : {}), ...(back.has(id) ? { broughtBack: true } : {}) });
	}
	return { batches: out, rules };
}

/** The text sent to For you when brook brings a dropped batch back (For you then decides, as for any pass). */
export function bringBackPrompt(b: FilteredBatch): string {
	const msgs = b.msgs.map(m => `  [${m.id}] ${m.time ?? ""} ${m.sender}: ${(m.text ?? "(text not kept; read it from the source)").replace(/\s+/g, " ")}`).join("\n");
	return `brook brought back a batch the filter dropped. Treat it as passed: decide what, if anything, he should see or do.

### ${b.source} (source key ${b.sourceKey})
Filter said (dropped): ${b.why}
New (${b.count}):
${msgs}`;
}

/** Mark a batch as brought back and return the prompt, or undefined when no such batch. */
export function bringBack(id: string, dir?: string): { prompt: string; batch: FilteredBatch } | undefined {
	const b = filteredView(dir, 2000).batches.find(x => x.id === id);
	if (!b) return undefined;
	const back = readJson<string[]>(backFile(dir), []);
	if (!back.includes(id)) writeJson(backFile(dir), [...back, id].slice(-500));
	return { prompt: bringBackPrompt(b), batch: b };
}

/** Daemon side: what a chat rule does to a batch before the cheap filter runs. */
export function ruleVerdict(rule: ChatRule | undefined, ids: string[]): { pass: boolean; why: string; ids: string[] } | undefined {
	if (rule === "show") return { pass: true, why: "brook: always show this chat", ids };
	if (rule === "mute") return { pass: false, why: "brook: always mute this chat", ids: [] };
	return undefined;
}
