// Runs inside the real bundled CLI with a temporary agent directory and fake
// tokens. Verifies the extension patches the running runtime, not a second copy
// of ModelRuntime loaded from node_modules by the extension loader.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	globalThis.fetch = async () => { throw new Error("Unexpected startup network request"); };
	pi.on("session_start", async (_event, ctx) => {
		try {
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			assert.ok(agentDir, "probe requires an isolated agent directory");
			const authPath = join(agentDir, "auth.json");
			const credentials = JSON.parse(await readFile(authPath, "utf8"));
			credentials["pix-anthropic"].expires = 0;
			await writeFile(authPath, JSON.stringify(credentials));
			const started = Promise.withResolvers<void>();
			const response = Promise.withResolvers<Response>();
			let calls = 0;
			let refreshSignal: AbortSignal | undefined;
			globalThis.fetch = async (url, init) => {
				assert.equal(url, "https://api.anthropic.com/v1/oauth/token", "no inference request after cancellation");
				calls++;
				refreshSignal = init?.signal ?? undefined;
				started.resolve();
				return response.promise;
			};
			const model = ctx.modelRegistry.find("pix-anthropic", "claude-haiku-4-5");
			assert.ok(model);
			const controller = new AbortController();
			const pending = ctx.modelRegistry.complete(model, {
				messages: [{ role: "user", content: "cancel before inference", timestamp: 0 }],
			}, { signal: controller.signal });
			await started.promise;
			controller.abort(new Error("cancelled probe"));
			const result = await pending;
			assert.match(result.errorMessage ?? "", /cancelled probe/);
			assert.equal(refreshSignal?.aborted, false);
			response.resolve(new Response(JSON.stringify({
				access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800,
			})));
			const auth = await ctx.modelRegistry.getProviderAuth("pix-anthropic");
			assert.equal(auth?.auth.apiKey, "new-access");
			assert.equal(calls, 1);
			const stored = JSON.parse(await readFile(authPath, "utf8"));
			assert.equal(stored["pix-anthropic"].refresh, "new-refresh");
			writeSync(1, "PIX_REFRESH_PERSISTED\n");
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	});
}
