/**
 * Autonomy ("preferences"): how much may happen on a loop without brook.
 *   do       For you or the owner does it and reports after
 *   prepare  does the work, puts the result on the card, waits for OK
 *   discuss  asks brook before any work
 * Each new loop gets a level (For you guesses; rules and the safety floor apply). brook's rules live in
 * ~/.pix/proactive/autonomy-rules.json, scoped by line, person, or work type.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTONOMY, isAutonomy, type Autonomy } from "./proactive-lines.ts";
export { AUTONOMY, isAutonomy, type Autonomy };

export interface Rule { scope: "line" | "person" | "type"; match: string; level: Autonomy; at: string }
const file = (dir: string) => join(dir, "autonomy-rules.json");
export const readRules = (dir: string): Rule[] => { try { const v = JSON.parse(readFileSync(file(dir), "utf8")); return Array.isArray(v) ? v.filter(r => r && isAutonomy(r.level) && typeof r.match === "string") : []; } catch { return []; } };
const norm = (s: string) => s.trim().toLowerCase();

/** Add (or replace) a rule; a rule with the same scope and match is overwritten. */
export function addRule(dir: string, r: Omit<Rule, "at">, now = new Date()): Rule[] {
	if (!r.match.trim() || !isAutonomy(r.level) || !["line", "person", "type"].includes(r.scope)) return readRules(dir);
	const rules = readRules(dir).filter(x => !(x.scope === r.scope && norm(x.match) === norm(r.match)));
	rules.push({ scope: r.scope, match: r.match.trim().slice(0, 80), level: r.level, at: now.toISOString() });
	writeFileSync(file(dir), JSON.stringify(rules, null, 2) + "\n");
	return rules;
}
export function removeRule(dir: string, match: string, scope?: string): boolean {
	const rules = readRules(dir), keep = rules.filter(x => !(norm(x.match) === norm(match) && (!scope || x.scope === scope)));
	if (keep.length === rules.length) return false;
	writeFileSync(file(dir), JSON.stringify(keep, null, 2) + "\n");
	return true;
}

/** Money, public posts, credentials, new contacts: never "do", whatever the guess or rule. Routine replies in an existing chat are allowed (brook, 2026-10-28). */
const RISKY = /(pay|payment|transfer|invoice|refund|purchase|buy|subscri|\$\d|¥|付款|转账|报销|购买|充值|post to|publish|发布|password|credential|token|api key|login|2fa|密码|验证码|登录|new contact|add friend|加好友|新联系人)/i;
export const risky = (text: string) => RISKY.test(text);

/**
 * The level a loop gets: the most specific matching rule (line > person > type), else For you's guess,
 * else discuss. Risky loops are capped at prepare.
 */
export function levelFor(loop: { title: string; why?: string; action?: string; line?: string; source?: string; people?: string[] }, guess: Autonomy | undefined, rules: Rule[]): { level: Autonomy; why: string } {
	const text = [loop.title, loop.why, loop.action].filter(Boolean).join(" ");
	const who = [loop.source ?? "", ...(loop.people ?? [])].map(norm).join(" ");
	const hit = rules.find(r => r.scope === "line" && loop.line && norm(r.match) === norm(loop.line))
		?? rules.find(r => r.scope === "person" && who.includes(norm(r.match)))
		?? rules.find(r => r.scope === "type" && norm(text).includes(norm(r.match)));
	let level: Autonomy = hit?.level ?? guess ?? "discuss", why = hit ? `rule: ${hit.scope} "${hit.match}"` : guess ? "For you's guess" : "default";
	if (level === "do" && risky(text)) { level = "prepare"; why += "; capped (money/outbound/credentials/new contact)"; }
	return { level, why };
}

export const rulesForPrompt = (rules: Rule[]) => rules.length ? rules.map(r => `- ${r.scope} "${r.match}" -> ${r.level}`).join("\n") : "(none yet)";
