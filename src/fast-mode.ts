export type FastModeTarget = "openai" | "anthropic" | "google";

const stateKey = Symbol.for("@brooktang/pi-x/fast-mode");
type FastModeGlobal = typeof globalThis & { [stateKey]?: boolean };

export function isFastModeEnabled(): boolean {
  return (globalThis as FastModeGlobal)[stateKey] === true;
}

export function setFastModeEnabled(value: boolean): void {
  (globalThis as FastModeGlobal)[stateKey] = value;
}

export function fastModeTarget(model: { provider?: string; api?: string } | undefined): FastModeTarget | undefined {
  if (!model) return undefined;
  if (model.provider === "anthropic" && model.api === "anthropic-messages") return "anthropic";
  if (model.api === "google-generative-ai") return "google";
  if (model.provider === "openai" || model.provider === "openai-codex") return "openai";
  return undefined;
}

export function applyFastMode(payload: unknown, target: FastModeTarget): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (target === "anthropic") return { ...payload, speed: "fast" };
  if (target === "google") return { ...payload, serviceTier: "priority" };
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
