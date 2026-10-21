/**
 * Check schedules for delegated work (chat handoffs, subagent runs), like a background job's reminder:
 * fixed = every N min; exponential = N, 2N, 4N… capped at 1 h.
 */
export type CheckMode = "fixed" | "exponential";
export type Check = { mode: CheckMode; every: number; n: number; next: number };
export const CHECK_DEFAULT_MIN = 15;
export const CHECK_MAX_MS = 60 * 60_000;
export const checkDelay = (c: Pick<Check, "mode" | "every">, n: number) => c.mode === "fixed" ? c.every : Math.min(c.every * 2 ** n, Math.max(c.every, CHECK_MAX_MS));
/** A schedule, or undefined for "off". `minutes` defaults to 15. */
export function makeCheck(mode: string | undefined, minutes?: number, at = Date.now()): Check | undefined {
	if (mode !== "fixed" && mode !== "exponential") return undefined;
	const every = Math.max(1, Math.min(minutes ?? CHECK_DEFAULT_MIN, 24 * 60)) * 60_000;
	return { mode, every, n: 0, next: at + every };
}
/** After a check fired at `now`: the next one. */
export const advance = (c: Check, now: number): Check => ({ ...c, n: c.n + 1, next: now + checkDelay(c, c.n + 1) });
export const clock = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
