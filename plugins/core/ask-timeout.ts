import { behavior } from "./behavior.ts";

/** How long a question waits before taking the first option, in ms; 0 = wait forever.
 *  Settings > Behavior (~/.pix/behavior.json), else PIX_QUESTION_TIMEOUT_MIN, else 5 min. */
export function questionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const min = behavior("questionTimeoutMin", env);
	return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}
