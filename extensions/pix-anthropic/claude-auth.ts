import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";


const execFile = promisify(execFileCallback);

export function claudeKeychainService(configDir = process.env.CLAUDE_CONFIG_DIR): string {
	return configDir
		? `Claude Code-credentials-${createHash("sha256").update(resolve(configDir)).digest("hex").slice(0, 8)}`
		: "Claude Code-credentials";
}

export async function readClaudeToken(): Promise<string> {
	let raw: string;
	try {
		if (platform() === "darwin") {
			const result = await execFile("security", ["find-generic-password", "-s", claudeKeychainService(), "-w"], { maxBuffer: 1024 * 1024, timeout: 5000 });
			raw = result.stdout;
		} else {
			raw = await readFile(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"), "utf8");
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
	if (expires <= Date.now()) throw new Error("pix-anthropic: Claude Code token expired. Open Claude Code to renew your login.");
	return token;
}

/** Native provider auth runs in Pi's runtime, including globally installed Pi. */
export const claudeAuth = {
	name: "Claude Code",
	async check({ signal }: { signal: AbortSignal }) {
		signal.throwIfAborted();
		if (process.env.PIX_ANTHROPIC_API_KEY) return { type: "api_key" as const, source: "configured API key" };
		try {
			await readClaudeToken();
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
		const apiKey = explicit || await readClaudeToken();
		signal.throwIfAborted();
		return { auth: { apiKey }, source: explicit ? "configured API key" : "Claude Code" };
	},
};

