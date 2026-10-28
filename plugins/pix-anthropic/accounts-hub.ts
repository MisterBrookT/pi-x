// Accounts on the phone: Kaji's numbers (same files: ~/.pix/accounts.json, accounts-usage.json written by
// Kaji's quota.py and by pix-anthropic's poll; Codex from Kaji's ~/.helm/sessions cache), which account each
// session runs on, and moving a session to another account. Never any token: only ids, labels and percents.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubPlugin } from "../core/hub-plugin.ts";
import { accounts, choice, ready, sessionAccount, sessionAccounts, setSessionAccount, usage } from "./accountkit.ts";

const STALE_MS = 15 * 60_000; // Kaji's AccountRouting.staleAfterMs
const helm = () => process.env.PIX_HELM_SESSIONS ?? join(homedir(), ".helm", "sessions");
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

export interface AccountRow { id: string; label: string; provider: "claude" | "codex"; left?: number; resetsAt?: string; window?: "5h" | "week"; state: "ok" | "signedOut" | "unknown" | "stale"; resting?: boolean; canSwitch: boolean }

/** Binding window like Kaji: the tighter of 5-hour and weekly (% left = 100 - used), with its reset. */
function binding(l: any): { left?: number; resetsAt?: string; window?: "5h" | "week" } {
	let out: { left?: number; resetsAt?: string; window?: "5h" | "week" } = {};
	for (const [k, w] of [["five_hour", "5h"], ["seven_day", "week"]] as const) {
		const used = l?.[`${k}_used_percent`];
		if (typeof used !== "number") continue;
		const left = Math.max(0, 100 - used);
		if (out.left === undefined || left < out.left) {
			const r = l[`${k}_resets_at`];
			out = { left, window: w, ...(r !== undefined ? { resetsAt: typeof r === "number" ? new Date(r * 1000).toISOString() : String(r) } : {}) };
		}
	}
	return out;
}

export function accountRows(now = Date.now()): AccountRow[] {
	const u = usage();
	const rows: AccountRow[] = accounts().map(a => {
		const x = u[a.id], cache = readJson(join(helm(), a.configDir ? `claude-limits-${a.id}-cache.json` : "claude-limits-cache.json"));
		const b = binding(cache);
		const left = x?.left ?? b.left, isReady = ready(a);
		const state = !isReady ? "signedOut" : left === undefined ? "unknown" : x?.checkedAt && now - x.checkedAt > STALE_MS ? "stale" : "ok";
		return { id: a.id, label: a.label, provider: "claude", ...(left !== undefined ? { left } : {}), ...(x?.resetsAt ?? b.resetsAt ? { resetsAt: x?.resetsAt ?? b.resetsAt } : {}), ...(b.window ? { window: b.window } : {}), state, ...(x?.coolUntil && now < x.coolUntil ? { resting: true } : {}), canSwitch: isReady };
	});
	// Codex: shown, not switchable (Kaji treats Codex accounts as display-only too).
	const cx = binding(readJson(join(helm(), "codex-limits-cache.json")));
	rows.push({ id: "codex", label: "codex", provider: "codex", ...cx, state: cx.left === undefined ? "unknown" : "ok", canSwitch: false });
	return rows;
}

export const accountsRelayAllowed = (path: string, method: string) =>
	method === "GET" && path === "/api/accounts" || method === "POST" && /^\/api\/sessions\/[a-zA-Z0-9_-]+\/account$/.test(path);

export const accountsHub = (): HubPlugin => hub => ({
	route(method, path, body) {
		if (method === "GET" && path === "/api/accounts") return { status: 200, body: { accounts: accountRows(), route: choice() } };
		const m = method === "POST" ? /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/account$/.exec(path) : null;
		if (!m) return undefined;
		return (async () => {
			const v = String((await body())?.account ?? "");
			if (v !== "auto" && !accounts().some(a => a.id === v && ready(a))) return { status: 400, body: { error: "unknown account" } };
			// Takes effect on the session's next request; a running turn keeps its current request.
			setSessionAccount(m[1]!, v === "auto" ? { pin: undefined } : { pin: v, active: v });
			hub.refreshSession(m[1]!);
			return { status: 200, body: { account: sessionAccount(m[1]!) } };
		})();
	},
	summary(session) { const a = sessionAccount(session); return a.id ? { account: a.id, accountPinned: a.pinned } : undefined; },
	session(session) { const a = sessionAccount(session); return a.id ? { account: a.id, accountPinned: a.pinned } : undefined; },
});
export { sessionAccounts };
