// Source: https://api-docs.deepseek.com/quick_start/pricing/ and /api/create-chat-completion/
// Verified 2026-10-29. Static cost fields use PEAK prices, not a claim of exact billed cost.
// The docs say 1M context without an integer: use a conservative 1,000,000 tokens.
export const officialDeepseekModels = [
  { id: "deepseek-flash", name: "DeepSeek V4.1 Flash 1017 (official)", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 393216, cost: { input: .30, output: 1.20, cacheRead: .006, cacheWrite: 0 } },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro 0813 (official)", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 393216, cost: { input: 1.32, output: 3.96, cacheRead: .044, cacheWrite: 0 } },
];
const replacement = { "deepseek-chat": "deepseek-flash", "deepseek-reasoner": "deepseek-v4-pro" };
export function correctOfficialDeepseek(models, settings) {
  const nextModels = structuredClone(models), nextSettings = structuredClone(settings);
  const provider = nextModels.providers?.["deepseek-official"];
  if (!provider || provider.api !== "openai-completions" || provider.baseUrl?.replace(/\/$/, "") !== "https://api.deepseek.com") throw new Error("unexpected official provider; refusing migration");
  const remaining = new Map(officialDeepseekModels.map(m => [m.id, structuredClone(m)]));
  provider.models = (provider.models ?? []).map(model => {
    const id = replacement[model.id] ?? model.id, verified = remaining.get(id);
    if (!verified) return model;
    remaining.delete(id); return verified;
  }).concat([...remaining.values()]);
  if (Array.isArray(nextSettings.enabledModels)) nextSettings.enabledModels = nextSettings.enabledModels.map(id => {
    const prefix = "deepseek-official/";
    return id.startsWith(prefix) && replacement[id.slice(prefix.length)] ? prefix + replacement[id.slice(prefix.length)] : id;
  });
  return { models: nextModels, settings: nextSettings };
}
