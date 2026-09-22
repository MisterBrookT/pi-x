/**
 * Reading `web-search.json`. The file and its location stay compatible with
 * what Pix used before, so existing settings and credentials keep working.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cidr, parseAllowRanges } from "./ssrf.ts";

export interface WebConfig {
  provider?: string;
  searchProvider?: string;
  openaiApiKey?: string;
  maxInlineContentChars?: number;
  proxy?: string;
  ssrf?: { allowRanges?: unknown };
  pdf?: { enabled?: boolean; maxSizeMB?: number; maxPages?: number };
  fetch?: { timeout?: number };
  [key: string]: unknown;
}

/** `PI_CODING_AGENT_DIR`, else `$XDG_CONFIG_HOME/pi`, else `~/.pi`. */
export function getWebConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "pi");
  return join(homedir(), ".pi");
}

export function getWebConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getWebConfigDir(env), "web-search.json");
}

export function readWebConfig(path = getWebConfigPath()): WebConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Web settings must be a JSON object");
  }
  return config as WebConfig;
}

/** Parsed once per call so a bad range fails the request, not the session. */
export function allowRangesOf(config: WebConfig): Cidr[] {
  return parseAllowRanges(config.ssrf?.allowRanges);
}

export const DEFAULT_MAX_INLINE_CHARS = 25_000;

export function maxInlineChars(config: WebConfig): number {
  const value = config.maxInlineContentChars;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_INLINE_CHARS;
}

/** Fetch timeout in milliseconds; `fetch.timeout` is configured in seconds. */
export function fetchTimeoutMs(config: WebConfig): number {
  const seconds = config.fetch?.timeout;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return 30_000;
  return Math.min(Math.floor(seconds * 1000), 2_147_483_647);
}

/** Strip query and fragment from a proxy URL, or null when unset. */
export function normalizeProxyUrl(value: unknown, source = "proxy"): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid ${source} URL: ${value}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error(`Invalid ${source} URL: ${value}`);
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}
