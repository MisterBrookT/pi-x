/**
 * Codex-style script surface for computer use.
 *
 * The model writes one JavaScript program against a `cua` API instead of
 * emitting one tool call per UI step. Loops, branches, and extraction run
 * inside a single call; only the script's return value and its log come back.
 *
 * This module is deliberately free of any Pi or backend imports so the whole
 * contract can be tested against fake operations.
 */

export interface ToolResultLike {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

/** The subset of the computer-use backend this surface needs. */
export interface ComputerOperations {
	find(params: { text?: string; app?: string; bundleId?: string; pid?: number; kind?: string }): Promise<ToolResultLike>;
	observe(params: { root?: string; mode?: string }): Promise<ToolResultLike>;
	search(params: { stateId?: string; text?: string; role?: string; capability?: string }): Promise<ToolResultLike>;
	expand(params: { stateId?: string; ref: string; depth?: number }): Promise<ToolResultLike>;
	inspect(params: { stateId?: string; ref: string }): Promise<ToolResultLike>;
	act(params: { stateId?: string; actions: UiAction[]; expect?: UiCondition }): Promise<ToolResultLike>;
	readText(params: { stateId?: string; ref: string; offset?: number }): Promise<ToolResultLike>;
	waitFor(params: Record<string, unknown>): Promise<ToolResultLike>;
	launchBrowser(params: { url?: string }): Promise<ToolResultLike>;
	navigateBrowser(params: { stateId?: string; url: string }): Promise<ToolResultLike>;
	evaluateBrowser(params: { stateId: string; expression: string }): Promise<ToolResultLike>;
}

export interface UiAction {
	action: "press" | "click" | "setText" | "typeText" | "keypress" | "scroll" | "drag" | "moveMouse";
	ref?: string;
	x?: number;
	y?: number;
	text?: string;
	keys?: string[];
	scrollX?: number;
	scrollY?: number;
	path?: Array<{ x: number; y: number }>;
	button?: "left" | "right" | "middle";
	clickCount?: number;
}

export interface UiCondition {
	ref?: string;
	scopeRef?: string;
	text?: string;
	role?: string;
	value?: string;
	until?: "present" | "absent";
	timeoutMs?: number;
}

/** Actions that change the world. Everything else is a read. */
const MUTATING = new Set(["press", "click", "setText", "typeText", "keypress", "drag"]);

/**
 * Labels whose activation causes an external side effect the user cannot take
 * back. Grouped after the categories in Codex's Computer Use confirmations
 * policy: deletion, third-party communication, financial action, permission and
 * credential changes, subscription changes, and software installation.
 *
 * This is a backstop, not the primary control. The judgement of when an action
 * is risky lives in the skill's policy, because a label alone cannot tell a
 * draft "Send" from a real one. The regex exists so a model that ignores the
 * policy still cannot silently transmit or destroy something.
 */
const IRREVERSIBLE =
	/\b(send|reply|submit|post|publish|share|tweet|delet\w*|remove|discard|trash|erase|archive|unsend|revoke|cancel|pay|paying|payment|purchase|buy|checkout|order|transfer|withdraw|subscribe|unsubscribe|install\w*|uninstall\w*|sign\s?up|log\s?out|allow|grant|deny)\b/i;

export interface ScriptBudget {
	/** Hard cap on mutating actions per script run. */
	maxActions: number;
	/** Hard cap on backend calls of any kind per script run. */
	maxCalls: number;
	/**
	 * Wall-clock limit for one script.
	 *
	 * UI actions take over the pointer, the keyboard, and window focus, so a
	 * script that waits or loops for a long time makes the machine unusable and
	 * looks like a hang. Backend calls are cheap to count but say nothing about
	 * elapsed time: a single `waitFor` can block for a minute on its own.
	 */
	maxDurationMs?: number;
}

export const DEFAULT_BUDGET: ScriptBudget = { maxActions: 40, maxCalls: 200, maxDurationMs: 120_000 };

/** Raised when a script runs past its wall-clock budget or is cancelled. */
export class ScriptHaltedError extends Error {}

/**
 * Cap on managed browsers a single script may start.
 *
 * Each `launchBrowser` spawns a real Chrome with a fresh throwaway profile in
 * the temp directory. The backend only kills the browser it launched *last*, so
 * repeated launches leave orphaned windows behind and pile up profile
 * directories on disk. One browser per script is almost always what is meant;
 * a script that needs to revisit a page should navigate instead of relaunching.
 */
const MAX_BROWSER_LAUNCHES = 1;

export interface ScriptEvent {
	kind: "call" | "action" | "log";
	name: string;
	detail?: string;
}

export class BudgetExceededError extends Error {}
export class ConfirmationRequiredError extends Error {}

/**
 * Turn a backend occlusion error into one actionable line.
 *
 * The backend refuses to press an element that something else covers on screen,
 * which is the right call: the click would otherwise land on the overlay. It
 * reports the blocker as a serialized property dictionary, so the useful part —
 * what is actually in the way — is buried in a few hundred characters of noise.
 * Observed blockers include macOS permission dialogs and open menus.
 */
export const describeOcclusion = (message: string): string | undefined => {
	if (!/Target is occluded/i.test(message)) return undefined;
	const value = /"value":\s*"([^"]+)"/.exec(message)?.[1]?.trim();
	const role = /"role":\s*"([^"]+)"/.exec(message)?.[1]?.trim();
	const title = /"title":\s*"([^"]+)"/.exec(message)?.[1]?.trim();
	const text = value || title;
	const blocker = text ? `"${text.length > 160 ? `${text.slice(0, 157)}...` : text}"` : role ? `a ${role}` : "another element";
	return [
		`Blocked: the target is covered on screen by ${blocker}.`,
		"Dismiss or handle what is on top, then observe again and retry.",
		"A dialog, menu, or permission prompt is the usual cause; scrolling the target into view helps when it is merely out of the visible area.",
	].join("\n");
};

export interface CuaApiOptions {
	operations: ComputerOperations;
	budget?: ScriptBudget;
	/** Called for every backend call and every log line, in order. */
	onEvent?: (event: ScriptEvent) => void;
	/**
	 * Gate for irreversible actions. Return true to allow. When omitted,
	 * irreversible actions are refused so a missing gate can never mean
	 * "allowed by default".
	 */
	confirm?: (summary: string) => Promise<boolean>;
	/** Set of already-approved summaries, so a loop asks once, not N times. */
	approved?: Set<string>;
	/** Cancellation from the host, checked before every backend call. */
	signal?: AbortSignal;
	/** Clock seam for tests. */
	now?: () => number;
}

const textOf = (result: ToolResultLike | undefined): string =>
	(result?.content ?? [])
		.filter((part) => part?.type !== "image")
		.map((part) => part?.text ?? "")
		.filter(Boolean)
		.join("\n");

/**
 * Locate the successor state id in a backend result.
 *
 * Desktop observations report it as `details.capture.stateId` while browser
 * observations use a top-level `details.stateId`. Both shapes are real and both
 * are checked; falling back to the previous id would silently act against a
 * stale state, so a missing id is an error at the call site instead.
 */
export const stateIdOf = (result: ToolResultLike | undefined): string | undefined => {
	const details = result?.details as { stateId?: unknown; capture?: { stateId?: unknown } } | undefined;
	if (typeof details?.stateId === "string") return details.stateId;
	if (typeof details?.capture?.stateId === "string") return details.capture.stateId;
	return undefined;
};

export const summarizeActions = (actions: UiAction[]): string =>
	actions
		.map((a) => {
			const target = a.ref ?? (a.x !== undefined ? `(${a.x},${a.y})` : "focus");
			const payload = a.text !== undefined ? ` ${JSON.stringify(a.text)}` : a.keys ? ` ${a.keys.join("+")}` : "";
			return `${a.action} ${target}${payload}`.trim();
		})
		.join("; ");

/** True when an action batch reads as irreversible from its own description. */
export const isIrreversible = (actions: UiAction[], stateText: string): boolean =>
	actions.some((action) => {
		if (!MUTATING.has(action.action)) return false;
		if (action.action !== "press" && action.action !== "click") return false;
		const label = labelForRef(stateText, action.ref);
		return label !== undefined && IRREVERSIBLE.test(label);
	});

/** The backend's "no controlled window" refusal, which a rebind can recover. */
const MISSING_TARGET_RE = /no current controlled window/i;

/** How long a finished script waits for calls it forgot to await. */
const SETTLE_GRACE_MS = 2_000;

/** Find the outline label for a ref, e.g. `@e9 button "Send"` -> `button "Send"`. */
export const labelForRef = (stateText: string, ref: string | undefined): string | undefined => {
	if (!ref) return undefined;
	const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`${escaped}\\b([^\\n]*)`).exec(stateText);
	return match ? match[1].trim() : undefined;
};

/** A saved UI state. Every read is answered from the cached outline. */
export interface CuaState {
	readonly id: string;
	readonly text: string;
	search(query: { text?: string; role?: string; capability?: string }): Promise<string>;
	expand(ref: string, depth?: number): Promise<string>;
	inspect(ref: string): Promise<string>;
	read(ref: string, offset?: number): Promise<string>;
	act(actions: UiAction | UiAction[], expect?: UiCondition): Promise<CuaState>;
	waitFor(condition: UiCondition): Promise<string>;
	navigate(url: string): Promise<CuaState>;
	eval(expression: string): Promise<unknown>;
}

export interface CuaApi {
	roots(query?: { text?: string; app?: string; bundleId?: string; pid?: number; kind?: string }): Promise<string>;
	observe(target?: { root?: string; mode?: "semantic" | "visual" | "fused" }): Promise<CuaState>;
	launchBrowser(url?: string): Promise<CuaState>;
	/**
	 * Rebind a stateId seen in an earlier call. The backend keeps saved states
	 * across tool calls, so a later script can continue from one without paying
	 * for a fresh observation.
	 */
	state(stateId: string): Promise<CuaState>;
}

export interface CuaRuntime {
	cua: CuaApi;
	log: (...values: unknown[]) => void;
	/** Ordered record of everything the script did. */
	events: ScriptEvent[];
	/** Mutating actions performed so far. */
	actionCount: () => number;
	/** Briefly wait for backend calls the script left un-awaited. */
	settle: (graceMs?: number) => Promise<void>;
}

export const createCuaRuntime = (options: CuaApiOptions): CuaRuntime => {
	const pending = new Set<Promise<unknown>>();
	/**
	 * A script that forgets an `await` leaves a backend call in flight. Once
	 * the script returns, its rejection has nobody to catch it and reaches the
	 * host as an unhandled rejection, which terminates the whole agent. Track
	 * every call so `settle()` can drain them, and neutralise the rejection
	 * here: a forgotten promise must degrade to a trace line, never a crash.
	 */
	const track = <T>(promise: Promise<T>): Promise<T> => {
		pending.add(promise);
		const done = () => pending.delete(promise);
		promise.then(done, done);
		promise.catch(() => {});
		return promise;
	};
	/**
	 * Replace every async method in place with a tracked version. Tracking the
	 * backend call alone is not enough: the promise the script drops is the one
	 * returned by `state.search(...)`, one layer above it. Rewriting in place
	 * rather than proxying keeps these objects structured-cloneable, which the
	 * host requires for anything a script returns.
	 */
	const trackMethods = <T extends object>(subject: T): T => {
		for (const key of Reflect.ownKeys(subject)) {
			const descriptor = Object.getOwnPropertyDescriptor(subject, key);
			if (!descriptor || typeof descriptor.value !== "function" || !descriptor.writable) continue;
			const original = descriptor.value as (...a: unknown[]) => unknown;
			Object.defineProperty(subject, key, {
				...descriptor,
				value: (...args: unknown[]) => {
					const result = original.apply(subject, args);
					return result instanceof Promise ? track(result) : result;
				},
			});
		}
		return subject;
	};
	const operations = trackMethods({ ...options.operations });
	const budget = options.budget ?? DEFAULT_BUDGET;
	const approved = options.approved ?? new Set<string>();
	const events: ScriptEvent[] = [];
	const startedAt = options.now?.() ?? Date.now();
	let calls = 0;
	let actions = 0;
	let launches = 0;

	const record = (event: ScriptEvent) => {
		events.push(event);
		options.onEvent?.(event);
	};

	const spend = (name: string, detail?: string) => {
		// Checked before every backend call, so cancelling or running out of time
		// stops the script at the next boundary instead of after all its work.
		if (options.signal?.aborted) {
			throw new ScriptHaltedError("Script was cancelled. The interface is left as-is; observe before acting again.");
		}
		const limit = budget.maxDurationMs;
		if (limit !== undefined && (options.now?.() ?? Date.now()) - startedAt > limit) {
			throw new ScriptHaltedError(
				`Script ran longer than ${Math.round(limit / 1000)}s and was stopped so it could not hold the pointer and keyboard. ` +
					"Do less per call: observe, return what you found, and continue in the next call.",
			);
		}
		calls += 1;
		if (calls > budget.maxCalls) {
			throw new BudgetExceededError(`Script exceeded ${budget.maxCalls} backend calls. Narrow the script and run it again.`);
		}
		record({ kind: "call", name, detail });
	};

	const makeState = (result: ToolResultLike, previousId?: string): CuaState => {
		const id = stateIdOf(result) ?? previousId;
		if (!id) throw new Error("Backend returned no stateId; the observation cannot be used.");
		const text = textOf(result);
		// Advanced by operations that bump the backend's epoch for this resource.
		let current = id;

		const state: CuaState = {
			id,
			text,
			async search(query) {
				spend("search_ui", JSON.stringify(query));
				return textOf(await operations.search({ stateId: id, ...query }));
			},
			async expand(ref, depth) {
				spend("expand_ui", ref);
				return textOf(await operations.expand({ stateId: id, ref, depth }));
			},
			async inspect(ref) {
				spend("inspect_ui", ref);
				return textOf(await operations.inspect({ stateId: id, ref }));
			},
			async read(ref, offset) {
				spend("read_text", ref);
				return textOf(await operations.readText({ stateId: id, ref, offset }));
			},
			async waitFor(condition) {
				spend("wait_for", JSON.stringify(condition));
				return textOf(await operations.waitFor({ stateId: id, ...condition }));
			},
			async act(input, expect) {
				const list = Array.isArray(input) ? input : [input];
				if (list.length === 0) throw new Error("act requires at least one action.");
				const mutations = list.filter((a) => MUTATING.has(a.action)).length;
				if (actions + mutations > budget.maxActions) {
					throw new BudgetExceededError(
						`Script exceeded ${budget.maxActions} UI actions. Report progress instead of continuing to act.`,
					);
				}
				const summary = summarizeActions(list);
				if (isIrreversible(list, text) && !approved.has(summary)) {
					if (!options.confirm) {
						throw new ConfirmationRequiredError(
							`Refusing an irreversible action without a confirmation gate: ${summary}`,
						);
					}
					const ok = await options.confirm(summary);
					if (!ok) throw new ConfirmationRequiredError(`User declined: ${summary}`);
					approved.add(summary);
				}
				spend("act_ui", summary);
				actions += mutations;
				record({ kind: "action", name: summary, detail: expect ? JSON.stringify(expect) : "no expect" });
				try {
					const result = await operations.act({ stateId: id, actions: list, expect });
					return makeState(result, id);
				} catch (error) {
					const raw = error instanceof Error ? error.message : String(error);
					const explained = describeOcclusion(raw);
					if (!explained) throw error;
					throw new Error(explained);
				}
			},
			async navigate(url) {
				spend("navigate_browser", url);
				const result = await operations.navigateBrowser({ stateId: current, url });
				current = stateIdOf(result) ?? current;
				return makeState(result, current);
			},
			/**
			 * Evaluating in a page advances the backend's epoch for that page, so the
			 * state this was called on becomes stale. Track the successor internally
			 * and use it for the next call, so a script can evaluate repeatedly
			 * against the same binding without a stale-state error.
			 */
			async eval(expression) {
				spend("evaluate_browser", expression.slice(0, 120));
				const result = await operations.evaluateBrowser({ stateId: current, expression });
				current = stateIdOf(result) ?? current;
				return extractEvaluationValue(textOf(result));
			},
		};
		// Scripts may return states directly or nested in other results. Tool
		// metadata is structured-cloned by the host: expose only the snapshot
		// data to serialization while keeping methods callable in the script.
		for (const key of Object.keys(state)) {
			if (typeof state[key as keyof CuaState] === "function") {
				Object.defineProperty(state, key, { enumerable: false });
			}
		}
		return trackMethods(state);
	};

	const cua: CuaApi = {
		async roots(query) {
			spend("find_roots", query ? JSON.stringify(query) : undefined);
			return textOf(await operations.find(query ?? {}));
		},
		async observe(target) {
			spend("observe_ui", target?.root);
			return makeState(await operations.observe(target ?? {}));
		},
		async launchBrowser(url) {
			if (launches >= MAX_BROWSER_LAUNCHES) {
				throw new Error(
					[
						"This script already launched a browser, and each launch starts another Chrome window that is left running.",
						"Reuse the page you have: keep the state returned by the first launch and call state.navigate(url) to go elsewhere,",
						"or cua.state(id) to pick it up again in a later call.",
					].join(" "),
				);
			}
			launches += 1;
			spend("launch_browser", url);
			return makeState(await operations.launchBrowser({ url }));
		},
		async state(stateId) {
			if (!stateId) throw new Error("cua.state requires a stateId from an earlier call.");
			// A scoped query is the cheapest way to prove the state is still live and
			// recover its outline; the backend rejects an evicted id.
			spend("search_ui", `rebind ${stateId}`);
			try {
				const result = await operations.search({ stateId, capability: "actionable" });
				return makeState({ ...result, details: { ...(result.details as object), stateId } }, stateId);
			} catch (error) {
				// The backend forgets which window it controls between tool calls, so
				// a rebind in a later call can fail even though the state is fine.
				// That is ordinary, not an error the script should have to handle:
				// re-observe to re-establish the target, then rebind once more.
				if (!MISSING_TARGET_RE.test(error instanceof Error ? error.message : String(error))) throw error;
				spend("observe_ui", "rebind recovery");
				await operations.observe({});
				const result = await operations.search({ stateId, capability: "actionable" });
				return makeState({ ...result, details: { ...(result.details as object), stateId } }, stateId);
			}
		},
	};

	return {
		cua: trackMethods(cua),
		log: (...values) => record({ kind: "log", name: values.map(stringify).join(" ") }),
		events,
		actionCount: () => actions,
		settle: async (graceMs = SETTLE_GRACE_MS) => {
			// Rejections are already neutralised by `track`, so a straggler can no
			// longer crash the host. This only gives in-flight calls a brief chance
			// to finish inside the run; a hung one must not hold the agent, so the
			// wait is bounded rather than unbounded.
			const deadline = (options.now?.() ?? Date.now()) + graceMs;
			while (pending.size > 0 && (options.now?.() ?? Date.now()) < deadline) {
				await Promise.race([
					Promise.allSettled([...pending]),
					new Promise((resolve) => setTimeout(resolve, graceMs)),
				]);
			}
		},
	};
};

const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

/** The backend appends `Evaluation value: <json>`; recover the value. */
export const extractEvaluationValue = (text: string): unknown => {
	const marker = "Evaluation value: ";
	const index = text.lastIndexOf(marker);
	if (index === -1) return undefined;
	const raw = text.slice(index + marker.length).trim();
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

export interface ScriptOutcome {
	value: unknown;
	events: ScriptEvent[];
	actions: number;
	error?: Error;
}

/**
 * Render a script run for the model: the returned value, the log, and a
 * compact trace so a failure is diagnosable without a second round trip.
 */
export const renderOutcome = (outcome: ScriptOutcome): string => {
	const lines: string[] = [];
	const logs = outcome.events.filter((event) => event.kind === "log");
	if (logs.length > 0) {
		lines.push("Log:");
		for (const entry of logs) lines.push(`  ${entry.name}`);
	}
	const trace = outcome.events.filter((event) => event.kind === "call");
	if (trace.length > 0) {
		lines.push(`Trace (${trace.length} calls, ${outcome.actions} actions):`);
		for (const entry of trace) lines.push(`  ${entry.name}${entry.detail ? ` ${entry.detail}` : ""}`);
	}
	if (outcome.error) {
		lines.push(`Error: ${outcome.error.message}`);
	} else {
		lines.push(`Result: ${outcome.value === undefined ? "undefined" : stringify(outcome.value)}`);
	}
	return lines.join("\n");
};
