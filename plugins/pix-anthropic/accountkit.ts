/**
 * accountkit: several Claude accounts, one active per request.
 *
 * Accounts are Claude Code logins on this Mac, one config dir each (like cc-switch profiles):
 * "minarabench" (~/.claude-minarabench) and "own" (Claude Code's default). More in ~/.pix/accounts.json. Choice (~/.pix/claude-route): an account id pins it; "auto" picks the
 * account in the highest band of % left (band width knob "band", default 25; unknown % = lowest band) that is not
 * cooling down after a quota/429; unknown % counts as usable. Usage is cached in ~/.pix/accounts-usage.json
 * so every session and the footer read the same numbers.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import crypto from "node:crypto";
import { join } from "node:path";

export interface Account { id: string; label: string; configDir?: string }
export interface Usage { left?: number; resetsAt?: string; coolUntil?: number; checkedAt?: number }

const dir = () => process.env.PIX_HOME ?? join(homedir(), ".pix");
const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(join(dir(), f), "utf8")); } catch { return d; } };
// A unique temporary file avoids concurrent Pi processes overwriting each other's pending rename.
const atomicWrite = (f: string, content: string) => {
	mkdirSync(dir(), { recursive: true });
	const p = join(dir(), f), tmp = `${p}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try { writeFileSync(tmp, content, { mode: 0o600, flag: "wx" }); renameSync(tmp, p); }
	finally { try { unlinkSync(tmp); } catch { /* renamed or never created */ } }
};
const write = (f: string, v: unknown) => atomicWrite(f, JSON.stringify(v, null, 2));

const DEFAULTS: Account[] = [
	{ id: "minarabench", label: "minarabench", configDir: join(homedir(), ".claude-minarabench") },
	{ id: "own", label: "brook" },
];
export const accounts = (): Account[] => read<{ accounts?: Account[] }>("accounts.json", {}).accounts ?? DEFAULTS;
export const bandWidth = (): number => Number(process.env.PIX_ACCOUNT_BAND ?? read<{ band?: number }>("accounts.json", {}).band ?? 25);
const band = (left?: number) => left === undefined ? -1 : Math.floor(left / bandWidth());

export function choice(): string {
	const v = (process.env.PIX_CLAUDE_ROUTE ?? (() => { try { return readFileSync(join(dir(), "claude-route"), "utf8"); } catch { return ""; } })()).trim();
	return accounts().some(a => a.id === v) ? v : "auto";
}
export function setChoice(v: string): void { atomicWrite("claude-route", v + "\n"); }

export const usage = (): Record<string, Usage> & { _active?: { id: string } } => read("accounts-usage.json", {});
export function recordUsage(id: string, u: Usage): void { const all = usage(); all[id] = { ...all[id], ...u, checkedAt: Date.now() }; write("accounts-usage.json", all); }

/** A profile is ready once its Claude Code login exists (own always is). */
export function ready(a: Account): boolean {
	return !a.configDir || existsSync(join(a.configDir, ".claude.json")) || existsSync(join(a.configDir, ".credentials.json"));
}

const resting = (a: Account, now: number) => { const u = usage()[a.id]; return !!(u?.coolUntil && now < u.coolUntil); };

/**
 * Accounts to try for one request, best first. A pinned account is tried alone.
 * Band rule (auto): keep the current account unless another ready, not-resting one is in a strictly
 * higher band of % left; ties stay. Resting (after quota/429) accounts go last.
 */
export function plan(now = Date.now()): Account[] {
	const all = accounts().filter(ready), c = choice();
	if (c !== "auto") return accounts().filter(a => a.id === c);
	const u = usage(), b = (a: Account) => band(u[a.id]?.left);
	const awake = all.filter(a => !resting(a, now)), tired = all.filter(a => resting(a, now));
	let pick = awake.find(a => a.id === u._active?.id) ?? awake[0];
	for (const a of awake) if (pick && b(a) > b(pick)) pick = a;
	if (pick && pick.id !== u._active?.id) recordActive(pick.id);
	const rest = awake.filter(a => a !== pick).sort((x, y) => b(y) - b(x));
	return [...(pick ? [pick] : []), ...rest, ...tired];
}

/** Make an account the current one in auto mode (it stays until another is in a strictly higher band). */
export function setActive(id: string): void { recordActive(id); }
function recordActive(id: string): void { const all = usage(); (all as Record<string, unknown>)._active = { id }; write("accounts-usage.json", all); }

/** Quota / rate-limit answers another account can fix. Not overload (529), not fast-mode rejections. */
export function isQuota(status: number, body: string): boolean {
	if (status === 429) return !/fast mode/i.test(body);
	return (status === 400 || status === 403) && /usage limit|quota|rate.?limit|credit balance/i.test(body);
}

/** After a quota answer: cool this account until the reset header (else 30 min), within 1 min to 6 h. */
export function coolDown(id: string, headers: Headers | Record<string, string>, now = Date.now()): number {
	const get = (k: string) => headers instanceof Headers ? headers.get(k) : headers[k];
	const reset = get("anthropic-ratelimit-unified-reset") ?? get("retry-after");
	let t = now + 30 * 60_000;
	if (reset) { const n = Number(reset); if (Number.isFinite(n)) t = n > 1e9 ? n * 1000 : now + n * 1000; else if (Date.parse(reset)) t = Date.parse(reset); }
	const until = Math.min(Math.max(t, now + 60_000), now + 6 * 3600_000);
	recordUsage(id, { coolUntil: until });
	return until;
}

/** % left from Anthropic's /api/oauth/usage: the tighter of the 5-hour and weekly windows. */
export function leftFromUsage(d: Record<string, { utilization?: number | null; resets_at?: string } | unknown>): Usage {
	let left: number | undefined, resetsAt: string | undefined;
	for (const k of ["five_hour", "seven_day"]) {
		const w = d[k] as { utilization?: number | null; resets_at?: string } | null;
		if (w && typeof w.utilization === "number") { const l = Math.max(0, 100 - w.utilization); if (left === undefined || l < left) { left = l; resetsAt = w.resets_at; } }
	}
	return { left, resetsAt };
}

/** Footer text: active account and % left, e.g. "minarabench" or "brook 37%". */
export function footerLabel(now = Date.now()): string {
	const a = plan(now)[0];
	if (!a) return "";
	const u = usage()[a.id];
	return a.label + (u?.left !== undefined ? ` ${Math.round(u.left)}%` : "") + (choice() === "auto" ? "" : " (pinned)");
}
