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

import {
	COMMIT_KEYS,
	type ScreenCapture,
	type ScreenOperations,
	lineForRef,
	normalizeName,
	pointFor,
	screenOutline,
	titleMatches,
} from "./computer-screen.ts";

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

/**
 * What an irreversible action must be aimed at. Checked right before the
 * action runs, in every mode: the window or chat title (AX outline or OCR
 * header) or the page URL must match, otherwise the action is refused.
 */
export interface ActTarget {
	title?: string;
	url?: string;
}

export class TargetMismatchError extends Error {}

export interface CuaApiOptions {
	operations: ComputerOperations;
	/** Screen mode (OCR + real input) for apps without an accessibility tree. */
	screen?: ScreenOperations;
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
/** Options for `state.look`: one read call that replaces search / expand / inspect / read. */
export interface LookOptions {
	/** Find elements by text (was `search`). */
	query?: string;
	role?: string;
	capability?: string;
	/** Expand under a ref (was `expand`), or with `inspect: true` show its details (was `inspect`). */
	ref?: string;
	depth?: number;
	inspect?: boolean;
	/** Read the full text of a ref (was `read`). */
	read?: boolean;
	offset?: number;
	/** Wait for a condition first (was `waitFor`). */
	wait?: UiCondition;
}

/** Where `cua.look` points. */
export interface LookTarget {
	app?: string;
	root?: string;
	url?: string;
	/** Re-bind a state id from an earlier call (was `cua.state`). */
	state?: string;
	mode?: "semantic" | "visual" | "fused" | "screen";
}

export interface CuaState {
	readonly id: string;
	readonly text: string;
	/** Read more from this state without a new capture. No options: the outline itself. */
	look(options?: LookOptions): Promise<string>;
	search(query: { text?: string; role?: string; capability?: string }): Promise<string>;
	expand(ref: string, depth?: number): Promise<string>;
	inspect(ref: string): Promise<string>;
	read(ref: string, offset?: number): Promise<string>;
	act(actions: UiAction | UiAction[], expect?: UiCondition, options?: { target?: ActTarget }): Promise<CuaState>;
	waitFor(condition: UiCondition): Promise<string>;
	navigate(url: string): Promise<CuaState>;
	eval(expression: string): Promise<unknown>;
}

export interface CuaApi {
	/** One entry point: an app, a window root, a URL (launches the browser), or an earlier state id. */
	look(target?: LookTarget): Promise<CuaState>;
	roots(query?: { text?: string; app?: string; bundleId?: string; pid?: number; kind?: string }): Promise<string>;
	observe(target?: { root?: string; app?: string; mode?: "semantic" | "visual" | "fused" | "screen" }): Promise<CuaState>;
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

	const fullOutline = new WeakMap<CuaState, string>();
	const gate = async (summary: string) => {
		if (approved.has(summary)) return;
		if (!options.confirm) {
			throw new ConfirmationRequiredError(`Refusing an irreversible action without a confirmation gate: ${summary}`);
		}
		const ok = await options.confirm(summary);
		if (!ok) throw new ConfirmationRequiredError(`User declined: ${summary}`);
		approved.add(summary);
	};

	/**
	 * Screen-mode state for an app without an accessibility tree. Every act
	 * re-captures the window, so refs always belong to what is on screen now.
	 */
	const makeScreenState = (capture: ScreenCapture, serial: number, previousOutline?: string): CuaState => {
		const screen = options.screen;
		if (!screen) throw new Error("Screen mode is not available on this host.");
		const id = `screen:${capture.app}:${serial}`;
		const full = screenOutline(capture);
		const text = previousOutline === undefined ? full : diffOutline(previousOutline, full, id);
		const recapture = async (why: string) => {
			spend("screen_capture", why);
			return screen.capture(capture.app);
		};
		const unsupported = (name: string) => async () => {
			throw new Error(`${name} is not available in screen mode; read state.text (OCR lines) instead.`);
		};
		const state: CuaState = {
			id,
			text,
			look: async () => text, // replaced by withLook
			async search(query) {
				const needle = (query.text ?? "").toLowerCase();
				return full.split("\n").slice(1).filter((row) => row.toLowerCase().includes(needle)).join("\n");
			},
			expand: unsupported("expand"),
			inspect: unsupported("inspect"),
			read: unsupported("read"),
			async waitFor(condition) {
				const until = condition.until ?? "present";
				const deadline = (options.now?.() ?? Date.now()) + (condition.timeoutMs ?? 3000);
				for (;;) {
					const next = await recapture(`wait ${JSON.stringify(condition.text)}`);
					const seen = next.lines.some((line) => line.text.includes(condition.text ?? ""));
					if (seen === (until === "present")) return screenOutline(next);
					if ((options.now?.() ?? Date.now()) > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(condition.text)} to be ${until}.`);
					await screen.sleep?.(400);
				}
			},
			async act(input, expect, actOptions) {
				const list = Array.isArray(input) ? input : [input];
				if (list.length === 0) throw new Error("act requires at least one action.");
				const mutations = list.filter((a) => MUTATING.has(a.action)).length;
				if (actions + mutations > budget.maxActions) {
					throw new BudgetExceededError(`Script exceeded ${budget.maxActions} UI actions. Report progress instead of continuing to act.`);
				}
				const summary = `${capture.app}: ${summarizeActions(list)}`;
				const risky = list.some(
					(a) =>
						(a.action === "keypress" && (a.keys ?? []).some((k) => COMMIT_KEYS.test(k)) && !(a.keys ?? []).some((k) => /^(cmd|command|ctrl|control|alt|option)$/i.test(k))) ||
						((a.action === "click" || a.action === "press") && a.ref !== undefined && IRREVERSIBLE.test(lineForRef(capture, a.ref)?.text ?? "")),
				);
				if (risky) {
					await checkTarget(actOptions?.target, summary, async (target) => {
						if (target.url !== undefined) return "a screen-mode app has no URL; aim it with target.title";
						await screen.activate(capture.app);
						const now = await recapture("target check");
						return target.title !== undefined && !titleMatches(now, target.title)
							? `the open title is ${JSON.stringify(now.lines.find((l) => l.y < 50 && l.x > now.window.w * 0.2)?.text ?? "")}, not ${JSON.stringify(normalizeName(target.title))}`
							: undefined;
					});
					await gate(summary);
				}
				spend("screen_act", summary);
				actions += mutations;
				record({ kind: "action", name: summary, detail: expect ? JSON.stringify(expect) : "no expect" });
				await screen.activate(capture.app);
				for (const action of list) {
					if (action.action === "click" || action.action === "press") {
						const point = pointFor(capture, action);
						await screen.click(point.x, point.y);
					} else if (action.action === "keypress") {
						await screen.keys(action.keys ?? []);
					} else if (action.action === "typeText" || action.action === "setText") {
						if (action.ref || action.x !== undefined) {
							const point = pointFor(capture, action);
							await screen.click(point.x, point.y);
						}
						if (action.action === "setText") {
							await screen.keys(["cmd", "a"]);
							await screen.keys(["backspace"]);
						}
						await screen.paste(action.text ?? "");
					} else {
						throw new Error(`${action.action} is not available in screen mode.`);
					}
					await screen.sleep?.(350);
				}
				serial += 1;
				const after = await recapture("after act");
				const next = makeScreenState(after, serial, full);
				if (expect?.text !== undefined) {
					const until = expect.until ?? "present";
					const seen = after.lines.some((line) => line.text.includes(expect.text ?? ""));
					if (seen !== (until === "present")) await next.waitFor(expect);
				}
				return next;
			},
			navigate: unsupported("navigate"),
			eval: unsupported("eval"),
		};
		for (const key of Object.keys(state)) {
			if (typeof state[key as keyof CuaState] === "function") Object.defineProperty(state, key, { enumerable: false });
		}
		fullOutline.set(state, full);
		return trackMethods(withLook(state));
	};
	let screenSerial = 0;

	/** `state.look(options)` dispatches to the narrower reads, which stay as aliases. */
	const lookOn = (state: CuaState) => async (opts: LookOptions = {}): Promise<string> => {
		const parts: string[] = [];
		if (opts.wait) parts.push(await state.waitFor(opts.wait));
		if (opts.query !== undefined || opts.role !== undefined || opts.capability !== undefined) {
			parts.push(await state.search({ text: opts.query, role: opts.role, capability: opts.capability }));
		} else if (opts.ref && opts.read) parts.push(await state.read(opts.ref, opts.offset));
		else if (opts.ref && opts.inspect) parts.push(await state.inspect(opts.ref));
		else if (opts.ref) parts.push(await state.expand(opts.ref, opts.depth));
		else if (!opts.wait) parts.push(fullOutline.get(state) ?? state.text);
		return parts.join("\n");
	};
	const withLook = (state: CuaState): CuaState => {
		Object.defineProperty(state, "look", { value: lookOn(state), enumerable: false, writable: true, configurable: true });
		return state;
	};

	const makeState = (result: ToolResultLike, previousId?: string, previousOutline?: string): CuaState => {
		const id = stateIdOf(result) ?? previousId;
		if (!id) throw new Error("Backend returned no stateId; the observation cannot be used.");
		const full = textOf(result);
		// After an act the model sees only what changed; the full outline stays for checks and look().
		const text = previousOutline === undefined ? full : diffOutline(previousOutline, full, id);
		// Advanced by operations that bump the backend's epoch for this resource.
		let current = id;

		const state: CuaState = {
			id,
			text,
			look: async () => text, // replaced by withLook
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
			async act(input, expect, actOptions) {
				const list = Array.isArray(input) ? input : [input];
				if (list.length === 0) throw new Error("act requires at least one action.");
				const mutations = list.filter((a) => MUTATING.has(a.action)).length;
				if (actions + mutations > budget.maxActions) {
					throw new BudgetExceededError(
						`Script exceeded ${budget.maxActions} UI actions. Report progress instead of continuing to act.`,
					);
				}
				const summary = summarizeActions(list);
				const risky = isIrreversible(list, full);
				if (risky) await checkTarget(actOptions?.target, summary, async (target) => {
					if (target.url !== undefined) {
						spend("evaluate_browser", "location.href (target check)");
						const result = await operations.evaluateBrowser({ stateId: current, expression: "location.href" });
						current = stateIdOf(result) ?? current;
						const href = String(extractEvaluationValue(textOf(result)) ?? "");
						if (!urlMatches(href, target.url)) return `page is ${href || "unknown"}, not ${target.url}`;
					}
					if (target.title !== undefined && !outlineHasTitle(full, target.title)) {
						return `no window, heading, or title in this state reads exactly ${JSON.stringify(normalizeName(target.title))}`;
					}
					return undefined;
				});
				if (risky) await gate(summary);
				spend("act_ui", summary);
				actions += mutations;
				record({ kind: "action", name: summary, detail: expect ? JSON.stringify(expect) : "no expect" });
				try {
					const result = await operations.act({ stateId: id, actions: list, expect });
					return makeState(result, id, full);
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
		fullOutline.set(state, full);
		return trackMethods(withLook(state));
	};

	const cua: CuaApi = {
		async look(target = {}) {
			if (target.state) return cua.state(target.state);
			if (target.url) return cua.launchBrowser(target.url);
			if (target.mode === "screen") return cua.observe({ app: target.app, mode: "screen" });
			if (target.app && !target.root) {
				const roots = await cua.roots({ app: target.app });
				// Prefer a real titled window: Finder lists its untitled desktop
				// backdrop first, and observing that fails ("not owned by a running app").
				const lines = roots.split("\n").filter((line) => /@r\d+/.test(line));
				const pick = lines.find((line) => /\bwindow\b/.test(line) && !/\(untitled\)/.test(line)) ?? lines[0];
				const root = pick ? /@r\d+/.exec(pick)?.[0] : undefined;
				if (!root) throw new Error(`No window found for ${target.app}. Is it open?`);
				return cua.observe({ root, mode: target.mode });
			}
			return cua.observe({ root: target.root, mode: target.mode });
		},
		async roots(query) {
			spend("find_roots", query ? JSON.stringify(query) : undefined);
			return textOf(await operations.find(query ?? {}));
		},
		async observe(target) {
			if (target?.mode === "screen") {
				if (!target.app) throw new Error('Screen mode needs an app name: cua.observe({ app: "WeChat", mode: "screen" }).');
				if (!options.screen) throw new Error("Screen mode is not available on this host.");
				spend("screen_capture", target.app);
				await options.screen.activate(target.app);
				screenSerial += 1;
				return makeScreenState(await options.screen.capture(target.app), screenSerial);
			}
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

/** Above this share of changed lines, a diff is no cheaper than the outline: send it whole. */
const DIFF_FULL_RATIO = 0.4;

/**
 * What changed between two outlines, Codex-style: `+` added, `-` removed,
 * `~` changed (same ref, new content). Lines are matched by ref first, then by
 * content, so a renumbered but identical element is not reported as a change.
 * Falls back to the full outline when most of it changed.
 */
export const diffOutline = (before: string, after: string, id = "", ratio = DIFF_FULL_RATIO): string => {
	const parse = (outline: string) =>
		outline.split("\n").filter((l) => l.trim()).map((line) => {
			const m = /^\s*(@[a-z]\d+)\b\s*(.*)$/.exec(line);
			return { line: line.trim(), ref: m?.[1], body: (m ? m[2] : line).trim().replace(/\s+/g, " ") };
		});
	const a = parse(before);
	const b = parse(after);
	const byRef = new Map(a.filter((x) => x.ref).map((x) => [x.ref, x]));
	const bodies = new Map<string, number>();
	for (const x of a) bodies.set(x.body, (bodies.get(x.body) ?? 0) + 1);
	const out: string[] = [];
	const kept = new Set<string>();
	for (const x of b) {
		const old = x.ref ? byRef.get(x.ref) : undefined;
		if (old && old.body === x.body) { kept.add(x.ref ?? x.body); bodies.set(x.body, (bodies.get(x.body) ?? 1) - 1); continue; }
		if ((bodies.get(x.body) ?? 0) > 0) { bodies.set(x.body, (bodies.get(x.body) ?? 1) - 1); if (old) kept.add(old.ref ?? ""); continue; }
		if (old) { kept.add(old.ref ?? ""); out.push(`~ ${x.line}`); } else out.push(`+ ${x.line}`);
	}
	const afterBodies = new Map<string, number>();
	for (const x of b) afterBodies.set(x.body, (afterBodies.get(x.body) ?? 0) + 1);
	for (const x of a) {
		if (x.ref && kept.has(x.ref)) continue;
		if (x.ref && b.some((y) => y.ref === x.ref)) continue;
		if ((afterBodies.get(x.body) ?? 0) > 0) { afterBodies.set(x.body, (afterBodies.get(x.body) ?? 1) - 1); continue; }
		out.push(`- ${x.line}`);
	}
	if (out.length === 0) return `No visible change${id ? ` (state ${id})` : ""}; look() for the full outline.`;
	if (out.length > Math.max(3, b.length * ratio)) return after;
	return [`Changes${id ? ` in ${id}` : ""} (${out.length} of ${b.length} lines; look() for the full outline):`, ...out].join("\n");
};

/** Run the target check for an irreversible action, or refuse when it has none. */
const checkTarget = async (
	target: ActTarget | undefined,
	summary: string,
	verify: (target: ActTarget) => Promise<string | undefined>,
): Promise<void> => {
	if (!target || (target.title === undefined && target.url === undefined)) {
		throw new TargetMismatchError(
			`Refusing an irreversible action without a target: ${summary}. Pass { target: { title } } (window or chat title) or { target: { url } } so the runtime can check what it acts on.`,
		);
	}
	const problem = await verify(target);
	if (problem) throw new TargetMismatchError(`Refused: ${problem}. Nothing was done: ${summary}`);
};

/** Exact title match against quoted labels of window, heading, or title-like rows in an AX outline. */
export const outlineHasTitle = (outline: string, title: string): boolean => {
	const want = normalizeName(title);
	return outline
		.split("\n")
		.filter((row) => /\b(window|heading|title|AXWindow|AXHeading|AXStaticText|statictext|webarea|AXWebArea)\b/i.test(row))
		.some((row) => [...row.matchAll(/"([^"]*)"/g)].some((m) => normalizeName(m[1]) === want));
};

/** Same page: exact match, or the page sits under the expected URL (path prefix, same origin). */
export const urlMatches = (href: string, want: string): boolean => {
	try {
		const a = new URL(href);
		const b = new URL(want);
		if (a.origin !== b.origin) return false;
		const base = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
		return a.pathname === b.pathname || a.pathname.startsWith(base);
	} catch {
		return href === want;
	}
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
