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

export interface Account { id: string; label: string; provider?: string; configDir?: string; dir?: string; disabled?: boolean; disabledReason?: string; disabledAt?: number }
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
export const inventory = (): Account[] => read<{ accounts?: Account[] }>("accounts.json", {}).accounts ?? DEFAULTS;
/** Existing Claude integration. Never route a Kaji Codex inventory entry as a Claude login. */
export const accounts = (): Account[] => inventory().filter(a => !a.provider || a.provider === "claude");
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
	if (a.disabled) return false;
	if (a.provider === "codex") return !!a.dir && existsSync(join(a.dir, "auth.json"));
	return !a.configDir || existsSync(join(a.configDir, ".claude.json")) || existsSync(join(a.configDir, ".credentials.json"));
}

const resting = (a: Account, now: number) => { const u = usage()[a.id]; return !!(u?.coolUntil && now < u.coolUntil); };

/**
 * Accounts to try for one request, best first. A pinned account is tried alone.
 * Band rule (auto): keep the current account unless another ready, not-resting one is in a strictly
 * higher band of % left; ties stay. Resting (after quota/429) accounts go last.
 */
export function plan(now = Date.now(), session?: string): Account[] {
	const all = accounts().filter(ready), c = choice();
	if (c !== "auto") return accounts().filter(a => a.id === c && !a.disabled);
	const u = usage(), b = (a: Account) => band(u[a.id]?.left);
	const awake = all.filter(a => !resting(a, now)), tired = all.filter(a => resting(a, now));
	// A session brook moved to an account runs there first (others stay as quota fallback).
	const mine = session ? sessionAccounts()[session] : undefined;
	const pinned = mine?.pin ? awake.find(a => a.id === mine.pin) : undefined;
	if (pinned) return [pinned, ...awake.filter(a => a !== pinned).sort((x, y) => b(y) - b(x)), ...tired];
	// Auto, per session: a new session starts on the account with the most % left, then keeps it (warm cache)
	// unless another is in a strictly higher band. Without a session id: the shared current account, as before.
	const current = session ? mine?.active : u._active?.id;
	let pick = current ? awake.find(a => a.id === current) : session ? [...awake].sort((x, y) => (u[y.id]?.left ?? -1) - (u[x.id]?.left ?? -1))[0] : undefined;
	pick ??= awake[0];
	for (const a of awake) if (pick && b(a) > b(pick)) pick = a;
	if (pick && pick.id !== current) session ? setSessionAccount(session, { active: pick.id }) : recordActive(pick.id);
	const rest = awake.filter(a => a !== pick).sort((x, y) => b(y) - b(x));
	return [...(pick ? [pick] : []), ...rest, ...tired];
}

/** Per-session account: pin = brook moved this session there; active = what auto picked for it. ~/.pix/session-accounts.json */
export interface SessionAccount { pin?: string; active?: string; at?: number }
export const sessionAccounts = (): Record<string, SessionAccount> => read("session-accounts.json", {});
export function setSessionAccount(session: string, v: SessionAccount): void {
	const all = sessionAccounts(), cur = { ...all[session], ...v, at: Date.now() };
	if (!cur.pin) delete cur.pin;
	all[session] = cur;
	// Keep the file small: newest 300 sessions.
	const keep = Object.entries(all).sort((x, y) => (y[1].at ?? 0) - (x[1].at ?? 0)).slice(0, 300);
	write("session-accounts.json", Object.fromEntries(keep));
}
/** The account a session's next request goes to (its pin, else auto's pick), without changing anything. */
export function sessionAccount(session: string, now = Date.now()): { id?: string; pinned: boolean } {
	const c = choice();
	const available = accounts().filter(a => !a.disabled), eligible = (id?: string) => available.some(a => a.id === id);
	if (c !== "auto") return { id: eligible(c) ? c : undefined, pinned: true };
	const m = sessionAccounts()[session];
	if (m?.pin && eligible(m.pin)) return { id: m.pin, pinned: true };
	const id = eligible(m?.active) ? m?.active : usage()._active?.id;
	return { id: eligible(id) ? id : undefined, pinned: false };
}

/** Make an account the current one in auto mode (it stays until another is in a strictly higher band). */
export function setActive(id: string): void { recordActive(id); }
function recordActive(id: string): void { const all = usage(); (all as Record<string, unknown>)._active = { id }; write("accounts-usage.json", all); }

/** Quota / rate-limit answers another account can fix. Not overload (529), not fast-mode rejections. */
export function isQuota(status: number, body: string): boolean {
	if (status === 429) return !/fast mode/i.test(body);
	return (status === 400 || status === 403) && /usage limit|quota|rate.?limit|credit balance/i.test(body);
}

/** An organization can reject OAuth while another logged-in account remains usable.
 * Deliberately separate from quota: unrelated permission 403s must not rotate. */
export function isOAuthOrganizationDenied(status: number, body: string): boolean {
	if (status !== 403) return false;
	try {
		const e = JSON.parse(body);
		return e?.error?.details?.error_code === "oauth_not_allowed_for_organization"
			|| e?.details?.error_code === "oauth_not_allowed_for_organization"
			|| (e?.error?.type === "permission_error" && e.error.message === "OAuth authentication is currently not allowed for this organization.");
	} catch { return false; }
}

export interface AccountOutcome { status: number; reason: "ok" | "quota" | "oauth_org_denied" | "unauthorized" | "other"; requestId?: string; at: number }
/** Last response per account, metadata only. No response bodies or credential material. */
export const outcomes = (): Record<string, AccountOutcome> => read("accounts-health.json", {});
function recordOutcome(id: string, response: Response, reason: AccountOutcome["reason"]): void {
	const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");
	const all = outcomes();
	all[id] = { status: response.status, reason, at: Date.now(), ...(requestId && /^[A-Za-z0-9_-]{1,200}$/.test(requestId) ? { requestId } : {}) };
	write("accounts-health.json", all);
}

/** Run the existing account order once, never retrying a denied account within this pass.
 * HTTP and credentials remain the caller's adapters. Organization denial is auth, not quota. */
export async function attemptAccounts(order: Account[], send: (account: Account) => Promise<Response>, options: { oauth: boolean; signal?: AbortSignal; unavailable?: Set<string>; onSuccess?: (account: Account) => void; onRotate?: (from: string, to: string, status: number) => void } ): Promise<Response> {
	const disabled = new Set(inventory().filter(a => a.disabled).map(a => a.id));
	const candidates = order.filter((a, i) => !a.disabled && !disabled.has(a.id) && !options.unavailable?.has(a.id) && order.findIndex(other => other.id === a.id) === i);
	if (!candidates.length) throw new Error("AccountKit: no account ready");
	let response!: Response;
	for (let n = 0; n < candidates.length; n++) {
		const account = candidates[n]!;
		response = await send(account);
		if (response.ok) { recordOutcome(account.id, response, "ok"); options.onSuccess?.(account); break; }
		if (options.signal?.aborted) break;
		const text = await response.clone().text().catch(() => "");
		const quota = isQuota(response.status, text);
		const denied = options.oauth && isOAuthOrganizationDenied(response.status, text);
		recordOutcome(account.id, response, denied ? "oauth_org_denied" : quota ? "quota" : response.status === 401 ? "unauthorized" : "other");
		if (quota) coolDown(account.id, response.headers);
		if (denied) options.unavailable?.add(account.id);
		if ((!quota && !denied && response.status !== 401) || n === candidates.length - 1) break;
		options.onRotate?.(account.id, candidates[n + 1]!.id, response.status);
		await response.body?.cancel().catch(() => undefined);
	}
	return response;
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
