export type FastModeTarget = "openai" | "anthropic" | "google";

const stateKey = Symbol.for("@brooktang/pi-x/fast-mode");
const fallbackKey = Symbol.for("@brooktang/pi-x/fast-mode-fallbacks");
const feedbackKey = Symbol.for("@brooktang/pi-x/fast-mode-feedback");
type FastModeGlobal = typeof globalThis & { [stateKey]?: boolean; [fallbackKey]?: Set<string>; [feedbackKey]?: Set<string> };

function modelKey(model: { provider?: string; id?: string }): string {
  return `${model.provider ?? ""}/${model.id ?? ""}`;
}

export function isFastModeEnabled(): boolean {
  return (globalThis as FastModeGlobal)[stateKey] === true;
}

export function setFastModeEnabled(value: boolean): void {
  (globalThis as FastModeGlobal)[stateKey] = value;
  if (!value) (globalThis as FastModeGlobal)[fallbackKey]?.clear();
}

export function recordFastModeFallback(model: { provider?: string; id?: string }): void {
  const state = globalThis as FastModeGlobal;
  const key = modelKey(model);
  if (!state[fallbackKey]) state[fallbackKey] = new Set();
  if (!state[feedbackKey]) state[feedbackKey] = new Set();
  state[fallbackKey].add(key);
  state[feedbackKey].add(key);
}

export function consumeFastModeFallbackFeedback(model: { provider?: string; id?: string }): boolean {
  const pending = (globalThis as FastModeGlobal)[feedbackKey];
  return pending?.delete(modelKey(model)) === true;
}

export function clearFastModeFallbacks(): void {
  const state = globalThis as FastModeGlobal;
  state[fallbackKey]?.clear();
  state[feedbackKey]?.clear();
}

export function fastModeFellBack(model: { provider?: string; id?: string }): boolean {
  return (globalThis as FastModeGlobal)[fallbackKey]?.has(modelKey(model)) === true;
}

export function fastModeTarget(model: { provider?: string; api?: string } | undefined): FastModeTarget | undefined {
  if (!model) return undefined;
  if ((model.provider === "anthropic" || model.provider === "pix-anthropic") && model.api === "anthropic-messages") return "anthropic";
  if (model.provider === "google" && model.api === "google-generative-ai") return "google";
  if (model.provider === "openai" || model.provider === "openai-codex") return "openai";
  return undefined;
}

export function fastModeActiveFor(model: { provider?: string; api?: string; id?: string } | undefined): boolean {
  if (!isFastModeEnabled() || !model || fastModeFellBack(model)) return false;
  const target = fastModeTarget(model);
  if (target !== "anthropic") return target !== undefined;
  return model?.id === "claude-opus-4-8" || model?.id === "claude-opus-5";
}

export function applyFastMode(payload: unknown, target: FastModeTarget): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (target === "anthropic") return { ...payload, speed: "fast" };
  if (target === "google") {
    const current = payload as Record<string, unknown>;
    const config = current.config && typeof current.config === "object" && !Array.isArray(current.config)
      ? current.config as Record<string, unknown>
      : {};
    return { ...current, config: { ...config, serviceTier: "priority" } };
  }
  return { ...payload, service_tier: "priority" };
}

export function addAnthropicFastBeta(headers: Record<string, string | null>): void {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  const current = headers[name] ?? "";
  const beta = "fast-mode-2026-02-01";
  if (!current.split(",").map((value) => value.trim()).includes(beta)) {
    headers[name] = current ? `${current},${beta}` : beta;
  }
}
