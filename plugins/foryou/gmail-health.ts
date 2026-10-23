/**
 * Gmail MCP login check. The MCP stores an OAuth refresh token in ~/.gmail-mcp/credentials.json; if Google
 * revokes it (Testing-mode apps: after 7 days) every Gmail tool fails with invalid_grant. Checking once an hour
 * finds a dead login early; it cannot extend a Testing-mode token's 7-day life. A failure becomes one health problem (shown once on For you, logged
 * only when it changes), with the re-login command. Secrets never leave this function.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
type Problem = { text: string; since: string };

export const gmailDir = () => process.env.PIX_GMAIL_MCP_DIR ?? join(homedir(), ".gmail-mcp");
export const gmailRelogin = "cd ~/.gmail-mcp && node ~/.local/lib/pi-gmail-mcp/node_modules/@klodr/gmail-mcp/dist/index.js auth";

export type GmailAuth = "ok" | "revoked" | "missing" | "unknown";
type Post = (url: string, body: string) => Promise<{ status: number; body: string }>;

const curlPost: Post = (url, body) => new Promise(res => {
	// The body (with the token) goes through stdin, never the process list.
	const p = execFile("/usr/bin/curl", ["-sS", "-m", "15", "-w", "\n%{http_code}", "-X", "POST", "-H", "content-type: application/x-www-form-urlencoded", "--data-binary", "@-", url], { timeout: 20_000, env: { ...process.env, HTTPS_PROXY: process.env.HTTPS_PROXY ?? "http://127.0.0.1:7890" } }, (_e, stdout) => {
		const out = String(stdout ?? ""), i = out.lastIndexOf("\n");
		res({ status: Number(out.slice(i + 1)) || 0, body: out.slice(0, Math.max(0, i)) });
	});
	p.stdin?.end(body);
});

/** Try a refresh with the stored token. "unknown" = network trouble, not a login problem. */
export async function checkGmailAuth(dir = gmailDir(), post: Post = curlPost): Promise<GmailAuth> {
	const kf = join(dir, "gcp-oauth.keys.json"), cf = join(dir, "credentials.json");
	if (!existsSync(kf) || !existsSync(cf)) return "missing";
	try {
		const k = JSON.parse(readFileSync(kf, "utf8")), key = k.installed ?? k.web;
		const c = JSON.parse(readFileSync(cf, "utf8")), rt = c.tokens?.refresh_token ?? c.refresh_token;
		if (!key?.client_id || !rt) return "missing";
		const r = await post(key.token_uri ?? "https://oauth2.googleapis.com/token", new URLSearchParams({ client_id: key.client_id, client_secret: key.client_secret ?? "", refresh_token: rt, grant_type: "refresh_token" }).toString());
		if (r.status === 200) return "ok";
		if (r.status === 400 && /invalid_grant|unauthorized_client|invalid_client/.test(r.body)) return "revoked";
		return "unknown";
	} catch { return "unknown"; }
}

/** The health problem for a state (none when fine or unsure). `since` keeps the first failure time so it is one stable entry. */
export function gmailProblem(a: GmailAuth, since: string): Problem[] {
	if (a !== "revoked" && a !== "missing") return [];
	return [{ text: `Gmail login expired: Gmail tools fail (invalid_grant). Re-login: ${gmailRelogin}`, since }];
}
