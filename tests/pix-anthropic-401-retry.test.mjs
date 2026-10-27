import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPixAnthropicStream } from "../plugins/pix-anthropic/stream.ts";
import { claudeKeychainService } from "../plugins/pix-anthropic/claude-auth.ts";

// Claude Code rotates its OAuth token whenever any `claude` run refreshes it; the old token then
// answers 401 "Invalid authentication credentials". Pix must re-read the login and retry once.
const home = mkdtempSync(join(tmpdir(), "pix401-"));
process.env.PIX_HOME = home;
delete process.env.PIX_CLAUDE_ROUTE;
const prof = join(home, "claude-prof");
mkdirSync(prof);
writeFileSync(join(prof, ".claude.json"), "{}");
writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [{ id: "p", label: "p", configDir: prof }] }));
const cred = (token) => writeFileSync(join(prof, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3600000 } }));
if (process.platform === "darwin") {
	const bin = join(prof, "security");
	writeFileSync(bin, `#!/bin/sh\n[ "$3" = "${claudeKeychainService(prof)}" ] || exit 1\ncat "${join(prof, ".credentials.json")}"\n`);
	chmodSync(bin, 0o700);
	process.env.PATH = `${prof}:${process.env.PATH}`;
}

test("401 after Claude Code rotated the token: re-read the login and retry once", async () => {
	cred("sk-ant-oat01-old");
	const seen = [];
	const stream = createPixAnthropicStream()({
		id: "claude-opus-4-8", api: "anthropic-messages", provider: "pix-anthropic",
		baseUrl: "https://example.invalid", maxTokens: 1024, contextWindow: 200000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}, { messages: [{ role: "user", content: "hello" }] }, {
		apiKey: "sk-ant-oat01-old", fetch: async (_url, init) => {
			seen.push(init.headers.Authorization);
			if (seen.length === 1) {
				cred("sk-ant-oat01-new"); // another `claude` process refreshed meanwhile
				return new Response('{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}', { status: 401 });
			}
			return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
		},
	});
	let last;
	for await (const event of stream) last = event;
	assert.deepEqual(seen, ["Bearer sk-ant-oat01-old", "Bearer sk-ant-oat01-new"]);
	assert.doesNotMatch(last.error?.errorMessage ?? "", /401/);
});
