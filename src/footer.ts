export interface FooterOptions {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  cacheHit: boolean;
  tokenSpeed: boolean;
  cost: boolean;
  context: boolean;
  provider: boolean;
  thinking: boolean;
}

export const defaultFooterOptions: FooterOptions = {
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite: true,
  cacheHit: true,
  tokenSpeed: true,
  cost: false,
  context: true,
  provider: true,
  thinking: true,
};

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | undefined {
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? cacheRead / promptTokens * 100 : undefined;
}

export function tokenSpeed(outputTokens: number, startedAt: number | undefined, endedAt: number): number | undefined {
  if (!startedAt || outputTokens <= 0 || endedAt <= startedAt) return undefined;
  return outputTokens / ((endedAt - startedAt) / 1000);
}
