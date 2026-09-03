import test from "node:test";
import assert from "node:assert/strict";
import { addAnthropicFastBeta, applyFastMode, fastModeActiveFor, fastModeTarget, isFastModeEnabled, setFastModeEnabled } from "../src/fast-mode.ts";

test("fast mode recognizes only supported direct providers", () => {
  assert.equal(fastModeTarget({ provider: "openai-codex", api: "openai-responses" }), "openai");
  assert.equal(fastModeTarget({ provider: "anthropic", api: "anthropic-messages" }), "anthropic");
  assert.equal(fastModeTarget({ provider: "pix-anthropic", api: "anthropic-messages" }), "anthropic");
  assert.equal(fastModeTarget({ provider: "google", api: "google-generative-ai" }), "google");
  assert.equal(fastModeTarget({ provider: "opencode", api: "google-generative-ai" }), undefined);
  assert.equal(fastModeTarget({ provider: "openrouter", api: "openai-completions" }), undefined);
});

test("unsupported Anthropic models fall back to normal speed", () => {
  setFastModeEnabled(true);
  assert.equal(fastModeActiveFor({ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5" }), false);
  assert.equal(fastModeActiveFor({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-8" }), true);
  setFastModeEnabled(false);
});

test("fast mode adds the provider-specific request field", () => {
  assert.deepEqual(applyFastMode({ model: "gpt" }, "openai"), { model: "gpt", service_tier: "priority" });
  assert.deepEqual(applyFastMode({ model: "claude" }, "anthropic"), { model: "claude", speed: "fast" });
  assert.deepEqual(applyFastMode({ model: "gemini", config: { temperature: 0.2 } }, "google"), {
    model: "gemini",
    config: { temperature: 0.2, serviceTier: "priority" },
  });
});

test("Anthropic fast beta is added once without losing existing betas", () => {
  const headers = { "anthropic-beta": "prompt-caching-2024-07-31" };
  addAnthropicFastBeta(headers);
  addAnthropicFastBeta(headers);
  assert.equal(headers["anthropic-beta"], "prompt-caching-2024-07-31,fast-mode-2026-02-01");
});

test("fast mode state can be toggled", () => {
  setFastModeEnabled(true);
  assert.equal(isFastModeEnabled(), true);
  setFastModeEnabled(false);
  assert.equal(isFastModeEnabled(), false);
});
