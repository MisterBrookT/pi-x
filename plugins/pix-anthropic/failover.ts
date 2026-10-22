/**
 * Second Claude account: cliproxy on dgx (minarabench login), reached through the
 * dev.brook.cliproxy-tunnel SSH forward on 127.0.0.1:18317.
 *
 * Route (file ~/.pix/claude-route, or PIX_CLAUDE_ROUTE): "auto" (default) uses brook's
 * own login and switches to the proxy when it hits quota / 429, staying there until the
 * reset time (or 30 min); "proxy" always uses the proxy; "own" never does.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Route = "auto" | "proxy" | "own";
const dir = () => process.env.PIX_HOME ?? join(homedir(), ".pix");
export const proxyUrl = () => process.env.PIX_CLIPROXY_URL ?? "http://127.0.0.1:18317";

export function route(): Route {
	const v = (process.env.PIX_CLAUDE_ROUTE ?? (() => { try { return readFileSync(join(dir(), "claude-route"), "utf8"); } catch { return ""; } })()).trim();
	return v === "proxy" || v === "own" ? v : "auto";
}

export function setRoute(r: Route): void {
	mkdirSync(dir(), { recursive: true });
	writeFileSync(join(dir(), "claude-route"), r + "\n");
}

export function proxyKey(): string | undefined {
	try { return readFileSync(process.env.PIX_CLIPROXY_KEY_FILE ?? join(dir(), "cliproxy-key"), "utf8").trim() || undefined; } catch { return undefined; }
}

/** Quota / rate-limit answers that a second account can fix. Not overloaded (529) or bad requests. */
export function isQuota(status: number, body: string): boolean {
	if (status === 429) return !/fast mode/i.test(body);
	return (status === 400 || status === 403) && /usage limit|quota|rate.?limit|credit balance/i.test(body);
}

let until = 0;
/** When the own login is out: remember until the reset header, else 30 min. */
export function markExhausted(headers: Headers | Record<string, string>, now = Date.now()): number {
	const get = (k: string) => headers instanceof Headers ? headers.get(k) : headers[k];
	const reset = get("anthropic-ratelimit-unified-reset") ?? get("retry-after");
	let t = now + 30 * 60_000;
	if (reset) {
		const n = Number(reset);
		if (Number.isFinite(n)) t = n > 1e9 ? n * 1000 : now + n * 1000;
		else if (Date.parse(reset)) t = Date.parse(reset);
	}
	until = Math.min(Math.max(t, now + 60_000), now + 6 * 3600_000);
	return until;
}
export const exhausted = (now = Date.now()) => now < until;
export const resetExhausted = () => { until = 0; };

/** Whether this request should go to the proxy before trying the own login. */
export const useProxyFirst = (now = Date.now()) => route() === "proxy" || (route() === "auto" && exhausted(now));
export const mayFailOver = () => route() === "auto" && !!proxyKey();

/** Headers for the proxy: same Anthropic headers, the proxy key instead of brook's token. */
export function proxyHeaders(h: Record<string, string>, key: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) if (!/^(authorization|x-api-key)$/i.test(k)) out[k] = v;
	out.authorization = `Bearer ${key}`;
	return out;
}

/** cliproxy only knows dated ids for some older models. */
const DATED: Record<string, string> = {
	"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	"claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
	"claude-opus-4-5": "claude-opus-4-5-20251101",
	"claude-opus-4-1": "claude-opus-4-1-20250805",
	"claude-sonnet-4": "claude-sonnet-4-20250514",
	"claude-opus-4": "claude-opus-4-20250514",
};
export function proxyBody(serialized: string): string {
	const m = serialized.match(/"model":"([^"]+)"/);
	return m && DATED[m[1]] ? serialized.replace(m[0], `"model":"${DATED[m[1]]}"`) : serialized;
}
