/**
 * accountkit: several Claude accounts, one active per request.
 *
 * Accounts: "own" (brook's direct login) and "minara" (minarabench via cliproxy on dgx), more in
 * ~/.pix/accounts.json later. Choice (~/.pix/claude-route): an account id pins it; "auto" picks the
 * first account in order whose % left is at or above the threshold (default 20) and that is not
 * cooling down after a quota/429; unknown % counts as usable. Usage is cached in ~/.pix/accounts-usage.json
 * so every session and the footer read the same numbers.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Account { id: string; label: string; kind: "direct" | "proxy"; url?: string; keyFile?: string }
export interface Usage { left?: number; resetsAt?: string; coolUntil?: number; checkedAt?: number }

const dir = () => process.env.PIX_HOME ?? join(homedir(), ".pix");
const read = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(join(dir(), f), "utf8")); } catch { return d; } };
const write = (f: string, v: unknown) => { mkdirSync(dir(), { recursive: true }); const p = join(dir(), f); writeFileSync(p + ".tmp", JSON.stringify(v, null, 2)); renameSync(p + ".tmp", p); };

const DEFAULTS: Account[] = [
	{ id: "minara", label: "minarabench", kind: "proxy", url: "http://127.0.0.1:18317", keyFile: "cliproxy-key" },
	{ id: "own", label: "brook", kind: "direct" },
];
export const accounts = (): Account[] => read<{ accounts?: Account[] }>("accounts.json", {}).accounts ?? DEFAULTS;
export const threshold = (): number => Number(process.env.PIX_ACCOUNT_THRESHOLD ?? read<{ threshold?: number }>("accounts.json", {}).threshold ?? 20);

export function choice(): string {
	const v = (process.env.PIX_CLAUDE_ROUTE ?? (() => { try { return readFileSync(join(dir(), "claude-route"), "utf8"); } catch { return ""; } })()).trim();
	if (v === "proxy") return "minara"; // b910368 name
	return accounts().some(a => a.id === v) ? v : "auto";
}
export function setChoice(v: string): void { mkdirSync(dir(), { recursive: true }); writeFileSync(join(dir(), "claude-route"), v + "\n"); }

export const usage = (): Record<string, Usage> => read("accounts-usage.json", {});
export function recordUsage(id: string, u: Usage): void { const all = usage(); all[id] = { ...all[id], ...u, checkedAt: Date.now() }; write("accounts-usage.json", all); }

export function key(a: Account): string | undefined {
	if (!a.keyFile) return undefined;
	try { return readFileSync(join(dir(), a.keyFile), "utf8").trim() || undefined; } catch { return undefined; }
}
const ready = (a: Account) => a.kind === "direct" || !!key(a);

/** Usable now: not cooling down after quota, and % left (if known) at or above the threshold. */
export function healthy(a: Account, now = Date.now()): boolean {
	const u = usage()[a.id] ?? {};
	return ready(a) && !(u.coolUntil && now < u.coolUntil) && (u.left === undefined || u.left >= threshold());
}

/** Accounts to try for one request, best first. A pinned account is tried alone. */
export function plan(now = Date.now()): Account[] {
	const all = accounts(), c = choice();
	if (c !== "auto") return all.filter(a => a.id === c);
	const ok = all.filter(a => healthy(a, now)), rest = all.filter(a => ready(a) && !ok.includes(a));
	return [...ok, ...rest];
}

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
