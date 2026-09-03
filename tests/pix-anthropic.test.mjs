import test from "node:test";
import assert from "node:assert/strict";
import registerPixAnthropic from "../extensions/pix-anthropic/index.ts";
import { createPixAnthropicStream } from "../extensions/pix-anthropic/stream.ts";
import { clearFastModeFallbacks, fastModeActiveFor, setFastModeEnabled } from "../src/fast-mode.ts";

const SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 120, cache_creation_input_tokens: 8 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const model = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8 (pix)",
  api: "anthropic-messages",
  provider: "pix-anthropic",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  compat: { forceAdaptiveThinking: true },
};

const context = {
  systemPrompt: "Test system prompt",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("registers an isolated Pix provider using Pi's current provider contract", () => {
  let registration;
  registerPixAnthropic({
    registerProvider(id, config) {
      registration = { id, config };
    },
  });

  assert.equal(registration.id, "pix-anthropic");
  assert.equal(registration.config.api, "anthropic-messages");
  assert.equal(registration.config.apiKey, "$PIX_ANTHROPIC_API_KEY");
  assert.equal(typeof registration.config.streamSimple, "function");
  assert.equal(typeof registration.config.oauth.login, "function");
  const ids = new Set(registration.config.models.map(({ id }) => id));
  for (const id of [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5",
    "claude-sonnet-5",
  ]) {
    assert.ok(ids.has(id), `missing current OMP model ${id}`);
  }
  assert.equal(registration.config.models.length, 12);
});

test("subscription transport reports Anthropic cache usage exactly", async () => {
  setFastModeEnabled(false);
  const requests = [];
  const mockFetch = async (_url, init) => {
    requests.push({ headers: { ...init.headers }, body: JSON.parse(init.body) });
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const events = await collect(createPixAnthropicStream()(model, context, {
    apiKey: "sk-ant-oat01-test",
    fetch: mockFetch,
  }));
  const done = events.find((event) => event.type === "done");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.speed, undefined);
  assert.equal(done.message.usage.cacheRead, 120);
  assert.equal(done.message.usage.cacheWrite, 8);
  assert.equal(done.message.usage.input, 7);
  assert.equal(done.message.usage.output, 2);
});

test("subscription transport retries rejected fast mode once at normal speed", async () => {
  clearFastModeFallbacks();
  setFastModeEnabled(true);
  const requests = [];
  const mockFetch = async (_url, init) => {
    requests.push({ headers: { ...init.headers }, body: JSON.parse(init.body) });
    if (requests.length === 1) return new Response("fast unavailable", { status: 400 });
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const events = await collect(createPixAnthropicStream()(model, context, {
    apiKey: "sk-ant-oat01-test",
    fetch: mockFetch,
  }));

  assert.equal(events.at(-1).type, "done");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.speed, "fast");
  assert.match(requests[0].headers["anthropic-beta"], /fast-mode-2026-02-01/);
  assert.equal(requests[1].body.speed, undefined);
  assert.doesNotMatch(requests[1].headers["anthropic-beta"] ?? "", /fast-mode-2026-02-01/);
  assert.equal(fastModeActiveFor(model), false, "subsequent turns stay on normal speed after fallback");
  setFastModeEnabled(false);
});

test("transport honors Pi hooks, headers, adaptive thinking, Unicode, and cache opt-out", async () => {
  setFastModeEnabled(false);
  const seen = { responses: [] };
  const events = await collect(createPixAnthropicStream()(model, {
    ...context,
    messages: [{ role: "user", content: "hello 👋" }],
  }, {
    apiKey: "sk-ant-oat01-test",
    reasoning: "high",
    cacheRetention: "none",
    headers: { "x-pix-test": "yes" },
    onPayload(payload) {
      seen.payload = payload;
      return { ...payload, metadata: { hook: true } };
    },
    onResponse(response) {
      seen.responses.push(response.status);
    },
    fetch: async (_url, init) => {
      seen.request = { headers: init.headers, body: JSON.parse(init.body) };
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }));

  assert.equal(events.at(-1).type, "done");
  assert.equal(seen.request.headers["x-pix-test"], "yes");
  assert.deepEqual(seen.responses, [200]);
  assert.deepEqual(seen.request.body.thinking, { type: "adaptive" });
  assert.deepEqual(seen.request.body.output_config, { effort: "high" });
  assert.deepEqual(seen.request.body.metadata, { hook: true });
  assert.match(JSON.stringify(seen.request.body), /👋/);
  assert.doesNotMatch(JSON.stringify(seen.request.body), /cache_control/);
});

test("Fable 5.1 uses OMP's safe preserved-thinking binding", async () => {
  setFastModeEnabled(false);
  let request;
  await collect(createPixAnthropicStream()({ ...model, id: "claude-fable-5-1" }, context, {
    apiKey: "sk-ant-oat01-test",
    reasoning: "minimal",
    fetch: async (_url, init) => {
      request = { body: JSON.parse(init.body), headers: init.headers };
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }));
  assert.deepEqual(request.body.thinking, {
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.deepEqual(request.body.output_config, { effort: "low" });
  assert.match(request.headers["anthropic-beta"], /thinking-binding-controls-2026-08-01/);
});

test("API-key requests can use fast mode", async () => {
  clearFastModeFallbacks();
  setFastModeEnabled(true);
  let request;
  await collect(createPixAnthropicStream()(model, context, {
    apiKey: "sk-ant-api01-test",
    fetch: async (_url, init) => {
      request = { headers: init.headers, body: JSON.parse(init.body) };
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }));
  assert.equal(request.body.speed, "fast");
  assert.match(request.headers["anthropic-beta"], /fast-mode-2026-02-01/);
  setFastModeEnabled(false);
});

test("subscription transport does not retry unrelated server errors", async () => {
  clearFastModeFallbacks();
  setFastModeEnabled(true);
  let calls = 0;
  const events = await collect(createPixAnthropicStream()(model, context, {
    apiKey: "sk-ant-oat01-test",
    fetch: async () => {
      calls += 1;
      return new Response("server error", { status: 500 });
    },
  }));

  assert.equal(calls, 1);
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error.errorMessage, /Anthropic API error 500/);
  setFastModeEnabled(false);
});
