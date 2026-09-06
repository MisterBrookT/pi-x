/**
 * Runs a model-authored script with only the cua surface in scope.
 *
 * This is a capability boundary, not a security sandbox: the script runs in
 * this process, so it can still reach globals it names explicitly. The point
 * is that the intended surface is small and every backend call is metered and
 * traced, so a runaway or unexpected script is bounded and visible.
 */

import { type CuaRuntime, type ScriptOutcome, renderOutcome } from "./computer-script.ts";

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
): Promise<ScriptOutcome> => {
	const fn = compileScript(source);
	try {
		const value = await fn(runtime, signal);
		return { value, events: runtime.events, actions: runtime.actionCount() };
	} catch (error) {
		return {
			value: undefined,
			events: runtime.events,
			actions: runtime.actionCount(),
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
};

export { renderOutcome };
