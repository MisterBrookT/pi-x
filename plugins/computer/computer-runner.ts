/**
 * Runs a model-authored script with only the cua surface in scope.
 *
 * This is a capability boundary, not a security sandbox: the script runs in
 * this process, so it can still reach globals it names explicitly. The point
 * is that the intended surface is small and every backend call is metered and
 * traced, so a runaway or unexpected script is bounded and visible.
 */

import { type CuaRuntime, DEFAULT_BUDGET, type ScriptOutcome, ScriptHaltedError, renderOutcome } from "./computer-script.ts";

/** Hard ceiling for one script: the action budget's time limit plus a margin for its last call to return. */
export const WALL_CLOCK_MS = (DEFAULT_BUDGET.maxDurationMs ?? 120_000) + 30_000;

export class ScriptCompileError extends Error {}

/**
 * Names shadowed inside the script so a stray reference reads as undefined
 * instead of silently reaching the host. `import` cannot be shadowed because it
 * is a reserved word, so dynamic `import()` stays reachable — one concrete
 * reason this is a capability boundary and not a security sandbox.
 */
const DENIED = ["require", "process", "globalThis", "eval", "Function", "fetch"];

export const compileScript = (source: string): ((runtime: CuaRuntime, signal?: AbortSignal) => Promise<unknown>) => {
	const body = source.trim();
	if (!body) throw new ScriptCompileError("script must be non-empty JavaScript.");
	const factory = `return async function __cuaScript(cua, log, signal) {\n${body}\n};`;
	let make: (...args: unknown[]) => unknown;
	try {
		// eslint-disable-next-line no-new-func
		make = new Function(...DENIED, factory) as (...args: unknown[]) => unknown;
	} catch (error) {
		throw new ScriptCompileError(`script failed to parse: ${(error as Error).message}`);
	}
	const fn = make(...DENIED.map(() => undefined)) as (
		cua: CuaRuntime["cua"],
		log: CuaRuntime["log"],
		signal?: AbortSignal,
	) => Promise<unknown>;
	return async (runtime, signal) => await fn(runtime.cua, runtime.log, signal);
};

export const runScript = async (
	source: string,
	runtime: CuaRuntime,
	signal?: AbortSignal,
	options?: { settleGraceMs?: number; wallClockMs?: number },
): Promise<ScriptOutcome> => {
	const fn = compileScript(source);
	// The budget only checks the clock at backend calls, so a script stuck on a promise that never
	// settles (`await new Promise(r => r)`) would hold the agent forever. Race it against a real
	// wall clock and the host's abort signal; the stuck promise is abandoned, not awaited.
	let stop: () => void = () => {};
	const halted = new Promise<never>((_, reject) => {
		const halt = (why: string) => reject(new ScriptHaltedError(why));
		if (signal?.aborted) return halt("Script was cancelled. The interface is left as-is; observe before acting again.");
		const onAbort = () => halt("Script was cancelled. The interface is left as-is; observe before acting again.");
		signal?.addEventListener("abort", onAbort, { once: true });
		const ms = options?.wallClockMs ?? WALL_CLOCK_MS;
		const timer = setTimeout(() => halt(`Script was still running after ${Math.round(ms / 1000)}s (likely awaiting something that never finishes) and was stopped. Observe before acting again.`), ms);
		stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
	});
	halted.catch(() => {});
	try {
		const value = await Promise.race([fn(runtime, signal), halted]);
		return { value, events: runtime.events, actions: runtime.actionCount() };
	} catch (error) {
		return {
			value: undefined,
			events: runtime.events,
			actions: runtime.actionCount(),
			error: error instanceof Error ? error : new Error(String(error)),
		};
	} finally {
		stop();
		// A script that forgot an `await` can leave a call in flight. Draining
		// here keeps its failure inside this run instead of surfacing later as
		// an unhandled rejection that would take the host process down.
		await runtime.settle(options?.settleGraceMs);
	}
};

export { renderOutcome };
