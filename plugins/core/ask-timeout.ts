import { behavior } from "./behavior.ts";

/** Questions about these never auto-pick: they wait for brook however long it takes. */
const RISKY = /\b(pay|payment|paid|price|cost|money|budget|invoice|refund|purchase|buy|subscri|billing|\$\d|¥|usd|rmb|send|sent|sending|email|message|post|publish|reply to|wechat|feishu|slack|tweet|credential|password|token|api key|secret|login|log in|sign in|ssh key|delete|remove|rm -|drop|wipe|erase|destroy|overwrite|force[- ]push|reset --hard|revert|uninstall|deploy|production|prod\b|release|global|everyone|all users|all sessions|permission|sudo|chmod)/i;

/** True when a question touches money, sending, credentials, or destructive or global changes. */
export function riskyQuestion(...texts: (string | undefined)[]): boolean {
	return RISKY.test(texts.filter(Boolean).join("\n"));
}

/** How long a question waits before taking the first option, in ms; 0 = wait forever.
 *  Settings > Behavior (~/.pix/behavior.json), else PIX_QUESTION_TIMEOUT_MIN, else 5 min.
 *  Pass the question text: risky questions always wait (0). */
export function questionTimeoutMs(env: NodeJS.ProcessEnv = process.env, ...texts: (string | undefined)[]): number {
	if (texts.length && riskyQuestion(...texts)) return 0;
	const min = behavior("questionTimeoutMin", env);
	return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}
