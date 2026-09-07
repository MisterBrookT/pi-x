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
import { callTitle, resultLines, scriptSummary } from "../src/computer-render.ts";
import { CHROME_CANDIDATES, installWrapper } from "../src/chrome-wrapper.ts";
import { createCuaRuntime, type ComputerOperations, DEFAULT_BUDGET } from "../src/computer-script.ts";
import { renderOutcome, runScript } from "../src/computer-runner.ts";
import { registerCapabilityAction } from "../src/capability-actions.ts";
import { checkPermissions, renderReport } from "../src/computer-permissions.ts";

const BACKEND = "@injaneity/pi-computer-use";

const API_DOC = `
Write JavaScript. Available: \`cua\`, \`log(...)\`, \`signal\`. Use \`return\` for the result.

  const roots = await cua.roots({ app: "Notes" });   // text listing of @r refs
  const state = await cua.observe({ root: "@r1" });  // -> CuaState
  const page  = await cua.launchBrowser("https://example.com");

Launch at most one browser per script; each launch opens another Chrome window
that stays open. To visit another page, reuse the one you have with
\`page.navigate(url)\`, or \`cua.state(id)\` in a later call.

Keep a script short. It holds the pointer, the keyboard, and window focus while
it runs, so long waits and long loops make the machine unusable. Observe, return
what you found, and continue in the next call. Scripts are stopped after two
minutes.

State persists across calls: a stateId returned by an earlier call can be picked
up with \`await cua.state("S3")\` instead of observing the root again.

CuaState:
  state.id                          // stateId owning its @e refs
  state.text                        // the folded outline
  await state.search({ text, role, capability })
  await state.expand(ref, depth)
  await state.inspect(ref)
  await state.read(ref, offset)
  await state.waitFor({ text, ref, until, timeoutMs })
  await state.act(action | action[], expect)   // -> successor CuaState
  await state.navigate(url)                    // browser pages only
  await state.eval(expression)                 // browser pages only; returns the value

Actions: press | click | setText | typeText | keypress | scroll | drag | moveMouse.
  { action: "press", ref: "@e9" }
  { action: "setText", ref: "@e7", text: "hello" }
  { action: "keypress", ref: "@e7", keys: ["cmd", "s"] }
  { action: "click", x: 420, y: 300 }           // only when a ref does not exist

\`keypress\` and \`typeText\` need a ref, coordinates, or a click earlier in the
same \`act\` array that established focus. A bare \`{ action: "keypress", keys }\`
is rejected:

  await state.act([
    { action: "click", ref: "@e7" },
    { action: "typeText", text: "hello" },      // follows the click's focus
    { action: "keypress", keys: ["Return"] },
  ]);

Rules:
- \`act\` returns the next state. Use it directly; do not observe again unless
  something changed outside your control.
- Batch deterministic actions into one \`act\` call, then read the returned state.
  Send a step alone only when it can change the meaning of later refs or when
  you need its result to decide what to do next.
- Prefer ref-based actions over coordinates. Use x/y only when no accessibility
  element exists for the target.
- Attempting an action is not completing it. Finish only when the returned state
  visibly shows the requested result, or report a concrete blocker.
- Attach \`expect\` to any action with an observable result. A delivered click is
  not a completed action.
- Use \`eval\` for extraction on browser pages and \`act\` for anything the user
  must be able to see happen.
- Irreversible actions (send, delete, pay, publish) prompt the user once per
  distinct action.
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

	pi.registerTool({
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
					value: outcome.value,
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
	});
}
