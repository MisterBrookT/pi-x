import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Load the real provider entry through Pi's file loader; keep the transitive auth
// module next to it so edits exercise the loader's dependency cache.
test("file-based Pi session reload refreshes pix-anthropic's changed auth module", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "pix-anthropic-reload-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = join(dir, "index.ts");
	const auth = join(dir, "claude-auth.ts");
	const stream = fileURLToPath(new URL("../extensions/pix-anthropic/stream.ts", import.meta.url));
	const source = (await readFile(new URL("../extensions/pix-anthropic/index.ts", import.meta.url), "utf8"))
		.replace('"./stream.ts"', JSON.stringify(stream));
	await writeFile(entry, source);
	const writeAuth = marker => writeFile(auth, `export const claudeAuth = { name: "Claude Code", async resolve() { return { auth: { apiKey: "${marker}" }, source: "test" }; }, async check() { return { type: "api_key", source: "test" }; } };\n`);
	await writeAuth("before-reload");
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
	await loader.reload();
	const model = runtime.getModels("anthropic")[0];
	assert.ok(model);
	const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(dir) });
	assert.deepEqual(extensionsResult.errors, []);
	await session.bindExtensions({ mode: "rpc" });
	t.after(async () => { await session.abort(); session.dispose(); });
	assert.equal((await runtime.getAuth("pix-anthropic")).auth.apiKey, "before-reload");
	await writeAuth("after-reload");
	await session.reload();
	assert.equal((await runtime.getAuth("pix-anthropic")).auth.apiKey, "after-reload");
});
