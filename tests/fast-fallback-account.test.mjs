import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Regression: the fast-mode fallback retried with the default login's token instead of the
// account accountkit chose, so an exhausted default account kept answering 429.
const home = mkdtempSync(join(tmpdir(), "pixff-"));
const bin = join(home, "bin"); mkdirSync(bin);
const prof = join(home, "claude-alt"); mkdirSync(prof); writeFileSync(join(prof, ".claude.json"), "{}");
const cred = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-alt", expiresAt: Date.now() + 3_600_000 } });
writeFileSync(join(bin, "security"), `#!/bin/sh\necho '${cred}'\n`); chmodSync(join(bin, "security"), 0o755);
writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [{ id: "alt", label: "alt", configDir: prof }] }));
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PIX_HOME = home;
process.env.PIX_CLAUDE_ROUTE = "alt";
const jiti = createJiti(import.meta.url);
const { createPixAnthropicStream } = await jiti.import("../plugins/pix-anthropic/stream.ts");
const fast = await jiti.import("../plugins/core/fast-mode.ts");

const SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");
const model = { id: "claude-opus-5-5", name: "Opus", api: "anthropic-messages", provider: "pix-anthropic", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 };

test("fast-mode fallback retries on the chosen account, not the default login", { skip: process.platform !== "darwin" }, async () => {
  fast.clearFastModeFallbacks(); fast.setFastModeEnabled(true);
  const auth = [];
  const fetch = async (_u, init) => {
    auth.push(init.headers.Authorization);
    if (auth.length === 1) return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}', { status: 429 });
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const events = [];
  for await (const e of createPixAnthropicStream()(model, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-ant-oat01-default", fetch })) events.push(e);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(auth, ["Bearer sk-ant-oat01-alt", "Bearer sk-ant-oat01-alt"]);
  fast.setFastModeEnabled(false);
});
