/** How long a question waits before taking the first option. PIX_QUESTION_TIMEOUT_MIN (minutes; 0 = wait forever), default 15. */
export function questionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIX_QUESTION_TIMEOUT_MIN;
	const min = raw === undefined || raw.trim() === "" ? 15 : Number(raw);
	return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}
