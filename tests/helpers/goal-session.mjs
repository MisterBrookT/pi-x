import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerGoal from "../../extensions/goal.ts";
import registerBackground from "../../extensions/background.ts";
import { GOAL_ENTRY, parseGoal } from "../../src/goal-state.ts";

/** Real Pi sessions, tools and lifecycle; only the provider's replies are scripted. */
export async function goalSession(t, script, { sessionManager, extensions = [], tools = ["goal", "background", "bash"], settings, goalExtensionPath } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pix-goal-runtime-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory(settings ?? { compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
	await runtime.setRuntimeApiKey("anthropic", "test-only");
	const model = runtime.getModels("anthropic")[0];
	assert.ok(model);
	const sm = sessionManager ?? SessionManager.inMemory(dir);
	const state = () => parseGoal(sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === GOAL_ENTRY).at(-1)?.data);
	const requests = [];
	const events = new EventEmitter();
	runtime.streamSimple = (_model, context, options) => {
		const index = requests.length;
		requests.push({ messages: structuredClone(context.messages), systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map((tool) => tool.name) });
		events.emit("changed");
		const stream = new AssistantMessageEventStream();
		(async () => {
			let abort;
			try {
				const aborted = new Promise((_, reject) => {
					abort = () => reject(new Error("aborted"));
					if (options.signal?.aborted) abort();
					else options.signal?.addEventListener("abort", abort, { once: true });
				});
				const reply = await Promise.race([script({ index, context, goal: state(), signal: options.signal }), aborted]);
				const message = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: reply.content, stopReason: reply.stopReason ?? (reply.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop"), timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				stream.push({ type: "done", reason: message.stopReason, message });
			} catch (error) {
				const reason = options.signal?.aborted ? "aborted" : "error";
				stream.push({ type: "error", reason, error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: reason, errorMessage: String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
			} finally {
				if (abort) options.signal?.removeEventListener("abort", abort);
				stream.end();
			}
		})();
		return stream;
	};
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: goalExtensionPath ? [goalExtensionPath] : [], extensionFactories: [registerBackground, ...(goalExtensionPath ? [] : [registerGoal]), ...extensions] });
	await loader.reload();
	const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: sm, tools });
	assert.deepEqual(extensionsResult.errors, []);
	const extensionErrors = [];
	let settledCount = 0;
	await session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
	session.subscribe((event) => {
		if (event.type === "agent_settled") settledCount += 1;
		events.emit("changed", event);
	});
	t.after(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session.abort();
		session.dispose();
	});
	return {
		session, state, requests, extensionErrors, dir, sm,
		settledCount: () => settledCount,
		async until(predicate) {
			const signal = AbortSignal.any([t.signal, AbortSignal.timeout(10000)]);
			while (!predicate()) await once(events, "changed", { signal });
		},
	};
}

export const say = (text) => ({ content: [{ type: "text", text }] });
export const call = (name, args, id = name) => ({ content: [{ type: "toolCall", id, name, arguments: args }] });
export const finish = (goal, status = "completed", evidence = "Regression tests passed; checked the acceptance criteria.") => call("goal", { id: goal.id, status, evidence });
