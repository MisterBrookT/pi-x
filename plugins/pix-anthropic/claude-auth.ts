import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdir, open, stat, unlink } from "node:fs/promises";
import { accounts, plan, routable } from "./accountkit.ts";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";


const execFile = promisify(execFileCallback);

const EXPIRY_SKEW = 120_000;
const fresh = (token: { expires: number }) => token.expires > Date.now() + EXPIRY_SKEW;

/** Recheck live inventory before reading/renewing, including callers holding a stale route. */
function profileAccountId(configDir?: string): string {
	const target = resolve(configDir || join(homedir(), ".claude"));
	const matching = accounts().filter(a => resolve(a.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")) === target);
	const account = matching.find(a => routable(a));
	if (matching.length && !account) throw new Error("pix-anthropic: Claude account is not routable; enable a ready login without a recent organization denial.");
	return account?.id ?? `profile-${createHash("sha256").update(target).digest("hex").slice(0, 16)}`;
}

/** The official CLI owns token rotation. Serialize it across every Pi process. */
async function withRenewalLock(configDir: string | undefined, renew: () => Promise<void>): Promise<void> {
	const id = profileAccountId(configDir);
	const directory = process.env.PIX_HOME || join(homedir(), ".pix");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `claude-renew-${encodeURIComponent(id)}.lock`), owner = randomUUID();
	const deadline = Date.now() + 65_000;
	let acquired = false;
	try {
		while (!acquired) {
			profileAccountId(configDir);
			try {
				const file = await open(path, "wx", 0o600);
				acquired = true;
				try { await file.writeFile(owner); } finally { await file.close(); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A winner may have rotated already. Never launch another CLI for its fresh token.
				if (fresh(await readCredentialToken(configDir))) return;
				try {
					const before = await stat(path);
					if (Date.now() - before.mtimeMs >= 60_000) {
						const current = await stat(path);
						if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) await unlink(path);
						continue;
					}
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				if (Date.now() >= deadline) throw new Error("pix-anthropic: Claude login renewal is busy; retry after the other process finishes.");
				await new Promise(r => setTimeout(r, 100));
			}
		}
		profileAccountId(configDir);
		if (!fresh(await readCredentialToken(configDir))) await renew();
	} finally {
		// Never remove a replacement owner's lock after a stale-lock takeover.
		if (acquired && await readFile(path, "utf8").catch(() => "") === owner) await unlink(path).catch(() => {});
	}
}

const renewals = new Map<string, Promise<void>>();
async function renewWithClaude(configDir?: string): Promise<void> {
	let renewal = renewals.get(configDir ?? "");
	if (!renewal) {
		renewal = withRenewalLock(configDir, async () => {
			const env = { ...process.env };
			delete env.CLAUDECODE; // Permit the CLI to run outside an inherited Claude Code session.
			delete env.ANTHROPIC_API_KEY;
			delete env.ANTHROPIC_AUTH_TOKEN;
			delete env.CLAUDE_CODE_OAUTH_TOKEN;
			delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE;
			if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
			profileAccountId(configDir);
			try {
				await execFile("claude", ["-p", "Reply only AUTH_OK", "--model", "haiku", "--max-turns", "1", "--tools", ""], {
					env, timeout: 30000, maxBuffer: 1024 * 1024,
				});
			} catch {
				throw new Error("pix-anthropic: Claude Code token expired and Claude CLI renewal failed. Run Claude Code to renew your login.");
			}
		});
		renewals.set(configDir ?? "", renewal);
		void renewal.finally(() => { renewals.delete(configDir ?? ""); }).catch(() => {});
	}
	return renewal;
}

export function claudeKeychainService(configDir = process.env.CLAUDE_CONFIG_DIR): string {
	return configDir
		? `Claude Code-credentials-${createHash("sha256").update(resolve(configDir)).digest("hex").slice(0, 8)}`
		: "Claude Code-credentials";
}

/** configDir: a profile's Claude Code dir (accountkit); default = Claude Code's own. */
export async function readClaudeToken(configDir = process.env.CLAUDE_CONFIG_DIR): Promise<string> {
	profileAccountId(configDir);
	let token = await readCredentialToken(configDir);
	profileAccountId(configDir);
	if (fresh(token)) return token.value;
	await renewWithClaude(configDir);
	token = await readCredentialToken(configDir);
	profileAccountId(configDir);
	if (!fresh(token)) throw new Error("pix-anthropic: Claude Code token remains expired after CLI renewal. Run Claude Code to renew your login.");
	return token.value;
}

async function readCredentialToken(configDir = process.env.CLAUDE_CONFIG_DIR): Promise<{ value: string; expires: number }> {
	let raw: string;
	try {
		if (platform() === "darwin") {
			const result = await execFile("security", ["find-generic-password", "-s", claudeKeychainService(configDir), "-w"], { maxBuffer: 1024 * 1024, timeout: 5000 });
			raw = result.stdout;
		} else {
			raw = await readFile(join(configDir || join(homedir(), ".claude"), ".credentials.json"), "utf8");
		}
	} catch {
		throw new Error("pix-anthropic: Claude Code credentials unavailable. Sign in with Claude Code, or set PIX_ANTHROPIC_API_KEY.");
	}
	let credential: unknown;
	try { credential = JSON.parse(raw); } catch {
		throw new Error("pix-anthropic: Claude Code credentials are malformed. Sign in again with Claude Code.");
	}
	const oauth = (credential as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
	const token = (oauth as { accessToken?: unknown } | null)?.accessToken;
	const expires = (oauth as { expiresAt?: unknown } | null)?.expiresAt;
	if (typeof token !== "string" || !token.startsWith("sk-ant-oat") || typeof expires !== "number" || !Number.isFinite(expires)) {
		throw new Error("pix-anthropic: Claude Code OAuth credential is malformed. Sign in again with Claude Code.");
	}
	return { value: token, expires };
}

/** Native provider auth runs in Pi's runtime, including globally installed Pi. */
export const claudeAuth = {
	name: "Claude Code",
	async check({ signal }: { signal: AbortSignal }) {
		signal.throwIfAborted();
		if (process.env.PIX_ANTHROPIC_API_KEY) return { type: "api_key" as const, source: "configured API key" };
		// Only confirm a Claude Code login exists. An expired token is still "configured":
		// renewal (a slow `claude -p`) belongs to resolve() at request time. Renewing here made
		// model switches fail when several sessions checked at once after the token expired.
		try {
			const account = plan()[0];
			if (!account) return undefined;
			try { await readCredentialToken(account.configDir); }
			catch { await new Promise(r => setTimeout(r, 300)); await readCredentialToken(account.configDir); } // keychain hiccup
			signal.throwIfAborted();
			return { type: "api_key" as const, source: "Claude Code" };
		} catch {
			signal.throwIfAborted();
			return undefined;
		}
	},
	async resolve({ signal }: { signal: AbortSignal }) {
		signal.throwIfAborted();
		const explicit = process.env.PIX_ANTHROPIC_API_KEY;
		const account = explicit ? undefined : plan()[0];
		if (!explicit && !account) throw new Error("pix-anthropic: no routable Claude account ready. Sign in or enable an account.");
		const apiKey = explicit || await readClaudeToken(account?.configDir);
		signal.throwIfAborted();
		return { auth: { apiKey }, source: explicit ? "configured API key" : "Claude Code" };
	},
};

