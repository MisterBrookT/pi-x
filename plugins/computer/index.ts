/**
 * `computer` — a Codex-style script surface over @injaneity/pi-computer-use.
 *
 * The model writes one JavaScript program instead of one tool call per UI step,
 * so loops and extraction cost a single round trip. Every backend call is
 * metered and traced, and irreversible actions are gated, so the speed of code
 * execution does not cost the reviewability of structured tool calls.
 *
 * The backend is an optional peer: when it is absent the tool is not registered
 * and the rest of pix loads normally.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { callTitle, resultLines, scriptSummary } from "./computer-render.ts";
import { CHROME_CANDIDATES, installWrapper } from "./chrome-wrapper.ts";
import { createCuaRuntime, type ComputerOperations, DEFAULT_BUDGET } from "./computer-script.ts";
import { macScreenOperations } from "./computer-screen.ts";
import { renderOutcome, runScript } from "./computer-runner.ts";
import { registerCapabilityAction } from "../core/capability-actions.ts";
import { withSpecialistExposure } from "../core/tool-discovery.ts";
import { checkPermissions, renderReport } from "./computer-permissions.ts";

const BACKEND = "@injaneity/pi-computer-use";

const API_DOC = `
Write JavaScript with \`cua\`, \`log(...)\`, \`signal\`; \`return\` the result. One browser launch per script. Keep scripts short: they hold pointer, keyboard, and focus, and stop after two minutes.

Three calls:
  const s = await cua.look({ app: "Notes" });        // or { url }, { root: "@r1" }, { state: "S3" }, { app: "WeChat", mode: "screen" }
  await s.look({ query: "Send" })                     // read more without a new capture: { ref, depth } | { ref, inspect: true } | { ref, read: true } | { wait: { text, until } }
  const next = await s.act(action | action[], expect, { target })   // -> next state
  await page.eval("document.title")                   // browser pages; page.navigate(url) to move
  await cua.recipe("wechat-send", { to, text })     // saved, tested scripts (same guards); unknown name lists them

Actions: press | click | setText | typeText | keypress | scroll | drag | moveMouse, e.g. { action: "setText", ref: "@e7", text: "hi" }. Prefer refs; x/y only without an element. Always pass expect, e.g. { text: "Sent", until: "present" }.

Irreversible acts (Send/Pay/Delete, Enter in screen mode) need { target: { title } } (exact window/chat title) or { target: { url } }; re-checked before running, refused on mismatch, then confirmed by the user once.

After the first look, act results show only what changed. Screen mode (no AX tree, e.g. WeChat): OCR lines as @t refs. Old names still work: cua.roots/observe/state/launchBrowser, state.search/expand/inspect/read/waitFor, cua.observe, act(action | action[], expect), eval(expression).
`.trim();

const Params = Type.Object({
	script: Type.String({
		description: "JavaScript body executed against the cua API. Use return for the result.",
		maxLength: 20000,
	}),
	maxActions: Type.Optional(
		Type.Number({ description: "Cap on mutating UI actions (default 40)", minimum: 1, maximum: 200 }),
	),
});

interface BackendModule {
	executeFind: BackendExecutor;
	executeObserve: BackendExecutor;
	executeSearchUi: BackendExecutor;
	executeExpandUi: BackendExecutor;
	executeInspectUi: BackendExecutor;
	executeAct: BackendExecutor;
	executeReadText: BackendExecutor;
	executeWaitFor: BackendExecutor;
	executeLaunchBrowser: BackendExecutor;
	executeNavigateBrowser: BackendExecutor;
	executeEvaluateBrowser: BackendExecutor;
	ensureComputerUseSetup: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<void>;
	/** Kills the managed browser and clears cached state; absent in older backends. */
	shutdownComputerUseSession?: () => Promise<void>;
}

type BackendExecutor = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<{ content?: Array<{ type?: string; text?: string }>; details?: unknown }>;

const BRIDGE = `${BACKEND}/src/bridge.ts`;

/**
 * Roots to search when the bare specifier does not resolve.
 *
 * pix may be loaded from a working copy outside the tree that holds the
 * backend, in which case the bare specifier fails even though the backend is
 * installed. Node also refuses to type-strip files under `node_modules`, so
 * this import only succeeds inside pi's loader, which is the only place it runs.
 */
const candidateRoots = (): string[] => {
	const roots = [
		join(homedir(), ".pi", "agent", "npm", "node_modules"),
		join(process.cwd(), "node_modules"),
	];
	const extra = process.env.PI_AGENT_DIR;
	if (extra) roots.unshift(join(extra, "npm", "node_modules"));
	return roots;
};

const loadBackend = async (): Promise<BackendModule | undefined> => {
	try {
		return (await import(BRIDGE)) as unknown as BackendModule;
	} catch {
		// fall through to explicit roots
	}
	for (const root of candidateRoots()) {
		const path = join(root, BACKEND, "src", "bridge.ts");
		if (!existsSync(path)) continue;
		try {
			return (await import(pathToFileURL(path).href)) as unknown as BackendModule;
		} catch {
			// try the next root
		}
	}
	return undefined;
};

/** Bind the backend's executors to one tool call's id, signal, and context. */
const bindOperations = (
	backend: BackendModule,
	toolCallId: string,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): ComputerOperations => {
	const call = (executor: BackendExecutor) => (params: unknown) =>
		executor(toolCallId, params, signal, undefined, ctx);
	return {
		find: call(backend.executeFind),
		observe: call(backend.executeObserve),
		search: call(backend.executeSearchUi),
		expand: call(backend.executeExpandUi),
		inspect: call(backend.executeInspectUi),
		act: call(backend.executeAct),
		readText: call(backend.executeReadText),
		waitFor: call(backend.executeWaitFor),
		launchBrowser: call(backend.executeLaunchBrowser),
		navigateBrowser: call(backend.executeNavigateBrowser),
		evaluateBrowser: call(backend.executeEvaluateBrowser),
	} as ComputerOperations;
};

const helperPath = () => join(homedir(), "Applications", "pi-computer-use.app");

/** Reads the SIP-protected system TCC database. Read-only by construction. */
const tccOperations = (pi: ExtensionAPI) => ({
	platform: process.platform,
	async query(sql: string) {
		const result = await pi.exec("sqlite3", ["/Library/Application Support/com.apple.TCC/TCC.db", sql], {
			timeout: 5000,
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || `sqlite3 exited ${result.code}`);
		return result.stdout;
	},
});

/**
 * Point the backend at a Chrome shim that adds `--use-mock-keychain`.
 *
 * Without it, the managed browser's throwaway profile makes macOS show a
 * "Keychain Not Found" dialog over whatever the user is doing. Done once per
 * process, and never overrides an executable the user set themselves.
 */
let chromeWrapperInstalled = false;
const suppressChromeKeychainPrompt = () => {
	if (chromeWrapperInstalled || process.platform !== "darwin") return;
	chromeWrapperInstalled = true;
	if (process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE) return;
	try {
		const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
		if (!executable) return;
		process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = installWrapper({ executable });
	} catch {
		// A missing temp directory or read-only filesystem only means the prompt
		// may appear; it must never stop the tool from running.
	}
};

/** A JSON-safe copy of a script result; anything not serializable becomes its string form. */
export function plainValue(v: unknown): unknown {
	if (v === undefined) return undefined;
	try { const s = JSON.stringify(v, (_k, x) => x instanceof Promise ? "[Promise: not awaited]" : typeof x === "function" ? undefined : typeof x === "bigint" ? String(x) : x); return s === undefined ? String(v) : JSON.parse(s); } catch { return String(v); }
}

export default function computer(pi: ExtensionAPI, options?: { backend?: BackendModule }) {
	let backendPromise: Promise<BackendModule | undefined> | undefined;
	const backendOnce = () => {
		backendPromise ??= options?.backend ? Promise.resolve(options.backend) : loadBackend();
		return backendPromise;
	};

	/**
	 * Shut the backend down when the session ends.
	 *
	 * A managed browser is spawned detached, and the backend only tracks the most
	 * recent one, so without this a quit leaves Chrome windows and their
	 * throwaway profile directories behind.
	 */
	pi.on("session_shutdown", async () => {
		const backend = await backendOnce().catch(() => undefined);
		await backend?.shutdownComputerUseSession?.().catch(() => {});
	});

	const stop = async (ctx: ExtensionContext) => {
		const backend = await backendOnce().catch(() => undefined);
		if (!backend?.shutdownComputerUseSession) {
			ctx.ui.notify("No computer-use session to stop.", "info");
			return;
		}
		await backend.shutdownComputerUseSession();
		ctx.ui.notify("Stopped: managed browser closed and cached UI state cleared.", "info");
	};

	const check = async (ctx: ExtensionContext) => {
		const report = await checkPermissions(tccOperations(pi));
		const backend = await backendOnce();
		const text = [
			backend ? `\u2713 Backend ${BACKEND} loaded` : `\u2717 Backend ${BACKEND} not found`,
			renderReport(report, helperPath()),
		].join("\n");
		ctx.ui.notify(text, report.ready && backend ? "info" : "warn");
	};

	/**
	 * Computer use is a `/tool` capability, so its maintenance actions belong to
	 * that row rather than to a top-level command of their own.
	 */
	registerCapabilityAction(pi, "computer", {
		verb: "check",
		description: "Check backend and permission state",
		run: check,
	});
	registerCapabilityAction(pi, "computer", {
		verb: "stop",
		description: "Close the managed browser and release resources",
		run: stop,
	});

	pi.registerTool(withSpecialistExposure({
		name: "computer",
		label: "Computer",
		description:
			"Operate a GUI by writing one JavaScript program against the cua API. " +
			"Covers native desktop apps and browser pages. Prefer a CLI, an API, or osascript first; " +
			"use computer only when the app on screen is the only interface.\n\n" +
			API_DOC,
		promptSnippet: "Drive desktop apps and browser pages with one cua script",
		promptGuidelines: [
			"Use computer only after a CLI, API, or osascript path has been ruled out, and say in one line why.",
			"Attach expect to computer actions that have an observable result; a delivered click is not a completed action.",
		],
		parameters: Params,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const backend = await backendOnce();
			if (!backend) {
				return {
					content: [
						{
							type: "text",
							text: `${BACKEND} is not installed. Run: pi install npm:${BACKEND}`,
						},
					],
					isError: true,
				};
			}

			const report = await checkPermissions(tccOperations(pi));
			if (!report.ready) {
				return {
					content: [{ type: "text", text: renderReport(report, helperPath()) }],
					isError: true,
				};
			}

			suppressChromeKeychainPrompt();
			await backend.ensureComputerUseSetup(ctx, signal);

			const runtime = createCuaRuntime({
				operations: bindOperations(backend, toolCallId, signal, ctx),
				screen: process.platform === "darwin" ? macScreenOperations() : undefined,
				signal,
				budget: { ...DEFAULT_BUDGET, maxActions: params.maxActions ?? DEFAULT_BUDGET.maxActions },
				confirm:
					ctx.mode === "tui"
						? async (summary) =>
								await ctx.ui.confirm("Irreversible action", `Allow: ${summary}?`)
						: undefined,
			});

			const outcome = await runScript(params.script, runtime, signal);
			return {
				content: [{ type: "text", text: renderOutcome(outcome) }],
				details: {
					// Plain data only: a script can return live objects (an un-awaited Promise), which break session cloning.
					value: plainValue(outcome.value),
					actions: outcome.actions,
					events: outcome.events,
					error: outcome.error?.message,
				},
				isError: outcome.error !== undefined,
			};
		},

		renderCall(args, theme) {
			const lines = [
				theme.fg("toolTitle", theme.bold(callTitle(args.script ?? ""))),
				...scriptSummary(args.script ?? "").map((line) => theme.fg("muted", `  ${line}`)),
			];
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const { title, body } = resultLines(text, result.details, context.isError);
			const lines = [
				theme.fg(context.isError ? "error" : "muted", title),
				...body.map((line) => theme.fg(context.isError ? "error" : "text", `  ${line}`)),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	}));
}
