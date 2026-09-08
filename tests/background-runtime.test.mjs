import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import registerBackground from "../extensions/background.ts";

// Real Pi extension binding, message queue and agent loop; only model responses are scripted.
for (const finishWhileBusy of [false, true]) {
	test(`background completion ${finishWhileBusy ? "queues behind an active turn" : "wakes an idle Pi session"}`, { timeout: 20000 }, async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "pix-background-runtime-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		t.after(() => { server.closeAllConnections(); server.close(); });
		const request = once(server, "request");
		const command = `${JSON.stringify(process.execPath)} -e "require('node:http').get('http://127.0.0.1:${server.address().port}', r => r.pipe(process.stdout))"`;
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
		await runtime.setRuntimeApiKey("anthropic", "test-only");
		const model = runtime.getModels("anthropic")[0];
		assert.ok(model);
		const contexts = [];
		let releaseBusy;
		const busy = new Promise((resolve) => { releaseBusy = resolve; });
		let enteredBusy;
		const busyEntered = new Promise((resolve) => { enteredBusy = resolve; });
		runtime.streamSimple = (_model, context) => {
			const index = contexts.length;
			contexts.push({ messages: structuredClone(context.messages) });
			const stream = new AssistantMessageEventStream();
			(async () => {
				if (index === 1 && finishWhileBusy) { enteredBusy(); await busy; }
				const message = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: index === 0
						? [{ type: "toolCall", id: "start-job", name: "background", arguments: { action: "start", command } }]
						: [{ type: "text", text: index === 1 ? "Waiting for completion." : "Continued automatically." }],
					stopReason: index === 0 ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			})();
			return stream;
		};
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [registerBackground] });
		await loader.reload();
		const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["background"] });
		assert.deepEqual(extensionsResult.errors, []);
		await session.bindExtensions({ mode: "rpc" });
		t.after(async () => { releaseBusy(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
		let continued;
		const continuation = new Promise((resolve) => { continued = resolve; });
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((part) => part.text === "Continued automatically.")) continued();
		});
		const prompting = session.prompt("Run the command and continue when it finishes.");
		const [, response] = await request;
		if (finishWhileBusy) await busyEntered;
		else await prompting;
		assert.equal(contexts.length, 2);
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		const completionQueued = new Promise((resolve) => {
			session.sendCustomMessage = async (message, options) => {
				await sendCustomMessage(message, options);
				resolve();
			};
		});
		response.end("job-result-marker");
		if (finishWhileBusy) {
			await completionQueued;
			assert.equal(contexts.length, 2, "no competing model request while the current turn is active");
			releaseBusy();
		}
		await continuation;
		await prompting;
		await session.agent.waitForIdle();
		assert.equal(contexts.length, 3, "exactly one automatic continuation");
		assert.ok(JSON.stringify(contexts[2].messages).includes("job-result-marker"));
	});
}
