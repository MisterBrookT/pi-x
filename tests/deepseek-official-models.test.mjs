import test from "node:test";
import assert from "node:assert/strict";
import { correctOfficialDeepseek, officialDeepseekModels } from "../scripts/deepseek-official-models.mjs";

test("verified official IDs replace retired aliases without changing credentials, defaults or model order", () => {
  const models = { providers: { other: { apiKey: "keep" }, "deepseek-official": { api: "openai-completions", baseUrl: "https://api.deepseek.com", apiKey: "!existing-command-not-executed", models: [{ id: "deepseek-chat" }, { id: "custom" }, { id: "deepseek-reasoner" }] } } };
  const settings = { defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", enabledModels: ["pix-anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol", "deepseek-official/deepseek-chat", "openrouter/deepseek/deepseek-v4.1-flash-1017", "deepseek-official/deepseek-reasoner"] };
  const result = correctOfficialDeepseek(models, settings);
  assert.deepEqual(result.settings.enabledModels, ["pix-anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol", "deepseek-official/deepseek-flash", "openrouter/deepseek/deepseek-v4.1-flash-1017", "deepseek-official/deepseek-v4-pro"]);
  assert.equal(result.settings.defaultProvider, settings.defaultProvider); assert.equal(result.settings.defaultModel, settings.defaultModel);
  assert.equal(result.models.providers["deepseek-official"].apiKey, models.providers["deepseek-official"].apiKey);
  assert.deepEqual(result.models.providers.other, models.providers.other);
  assert.deepEqual(result.models.providers["deepseek-official"].models.map(m => m.id), ["deepseek-flash", "custom", "deepseek-v4-pro"]);
  assert.equal(models.providers["deepseek-official"].models[0].id, "deepseek-chat", "pure planning does not mutate input");
  assert.deepEqual(correctOfficialDeepseek(result.models, result.settings), result, "idempotent");
});

test("catalog records current thinking, vision, maximum output and conservative peak-price estimates", () => {
  assert.deepEqual(officialDeepseekModels.map(m => [m.reasoning, m.contextWindow, m.maxTokens]), [[true, 1000000, 393216], [true, 1000000, 393216]]);
  assert.deepEqual(officialDeepseekModels[0].input, ["text", "image"]); assert.deepEqual(officialDeepseekModels[1].input, ["text"]);
  assert.deepEqual(officialDeepseekModels.map(m => m.cost), [{ input: .30, output: 1.20, cacheRead: .006, cacheWrite: 0 }, { input: 1.32, output: 3.96, cacheRead: .044, cacheWrite: 0 }]);
  assert.throws(() => correctOfficialDeepseek({ providers: {} }, {}), /refusing/);
});
