import { plan, usage, recordUsage, leftFromUsage } from "./accountkit.ts";
import { readClaudeToken } from "./claude-auth.ts";

/** Read the selected plan login's subscription usage, never the default login by accident. */
export async function pollAccountUsage(signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const account = plan()[0];
	if (!account || Date.now() - (usage()[account.id]?.checkedAt ?? 0) < 4 * 60_000) return;
	const token = await readClaudeToken(account.configDir);
	signal.throwIfAborted();
	const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal,
	});
	if (response.ok) recordUsage(account.id, leftFromUsage(await response.json()));
}
