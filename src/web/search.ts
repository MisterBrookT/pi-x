/**
 * Web search through OpenAI's hosted `web_search` tool.
 *
 * Credentials are never read from disk here. Pi's model registry resolves
 * them, which is what makes a Codex subscription work without this module
 * knowing anything about OAuth.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type WebConfig, readWebConfig } from "./config.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** Codex first: a subscription costs nothing extra per search. */
const SEARCH_PROVIDERS = ["openai-codex", "openai"] as const;

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchResponse {
  query: string;
  answer: string;
  results: SearchResult[];
}

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: "day" | "week" | "month" | "year";
  domainFilter?: string[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface Auth {
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  responsesUrl: string;
  codex: boolean;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function codexAccountId(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return undefined;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** Newest general-purpose model; `pro`/`ultra` tiers are wasted on search. */
function pickSearchModel<T extends { id: string }>(models: T[]): T | undefined {
  const usable = models.filter((m) => !/pro|ultra/i.test(m.id));
  if (usable.length === 0) return undefined;
  return usable.find((m) => /terra/i.test(m.id)) ?? usable.find((m) => /^gpt-\d/i.test(m.id)) ?? usable[0];
}

/** Ask Pi for a usable model and its request auth. */
export async function resolveAuth(ctx: ExtensionContext, config: WebConfig = readWebConfig()): Promise<Auth | undefined> {
  let models: { id: string; provider: string }[];
  try {
    models = ctx.modelRegistry.getAll();
  } catch {
    return undefined;
  }
  for (const provider of SEARCH_PROVIDERS) {
    const preferred = pickSearchModel(models.filter((m) => m.provider === provider));
    if (!preferred) continue;
    try {
      const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(preferred as never);
      if (!resolved.ok || !resolved.apiKey) continue;
      const codex = provider === "openai-codex";
      return {
        apiKey: resolved.apiKey,
        model: preferred.id,
        headers: Object.fromEntries(Object.entries(resolved.headers ?? {}).filter(([, v]) => v !== null)) as Record<string, string>,
        responsesUrl: codex ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL,
        codex,
      };
    } catch {
      // Try the next provider rather than failing the whole search.
    }
  }
  const apiKey = (config.openaiApiKey && String(config.openaiApiKey)) || process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return { apiKey, model: "gpt-5", headers: {}, responsesUrl: OPENAI_RESPONSES_URL, codex: false };
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return null;
  try {
    input = new URL(input.includes("://") ? input : `https://${input}`).hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function domainFilters(filter?: string[]): { allowed_domains?: string[]; blocked_domains?: string[] } | null {
  if (!filter?.length) return null;
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const raw of filter) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    (raw.trim().startsWith("-") ? blocked : allowed).push(domain);
  }
  if (!allowed.length && !blocked.length) return null;
  return { ...(allowed.length ? { allowed_domains: allowed } : {}), ...(blocked.length ? { blocked_domains: blocked } : {}) };
}

function buildInstructions(options: SearchOptions): string {
  const lines = [
    "Search the web and return a concise answer grounded only in the web results.",
    "Include clickable source citations in the response text when possible.",
  ];
  const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
  if (options.recencyFilter) lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
  if (options.numResults && options.numResults > 0) {
    lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
  }
  const filters = domainFilters(options.domainFilter);
  if (filters?.allowed_domains) lines.push(`Only use sources from: ${filters.allowed_domains.join(", ")}.`);
  if (filters?.blocked_domains) lines.push(`Do not use sources from: ${filters.blocked_domains.join(", ")}.`);
  return lines.join(" ");
}

function isWebSearchCall(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call";
}

/** The endpoint answers with either plain JSON or an SSE stream. */
export function parseResponseText(text: string): { output: unknown[]; sawWebSearch: boolean } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`OpenAI API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = Array.isArray(parsed) ? { output: parsed } : (parsed as Record<string, unknown>) ?? {};
    const output = Array.isArray(payload.output) ? payload.output : [];
    return { output, sawWebSearch: output.some(isWebSearchCall) };
  }

  const items: unknown[] = [];
  let completed: unknown[] | null = null;
  let sawWebSearch = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof event.type === "string" && event.type.startsWith("response.web_search_call")) sawWebSearch = true;
    if (event.type === "response.output_item.done" && event.item) {
      items.push(event.item);
      sawWebSearch ||= isWebSearchCall(event.item);
    }
    if ((event.type === "response.done" || event.type === "response.completed") && event.response) {
      const output = (event.response as Record<string, unknown>).output;
      if (Array.isArray(output)) completed = output;
    }
  }
  const output = completed?.length ? completed : items;
  if (output.length === 0) throw new Error("OpenAI API returned no parseable response output");
  return { output, sawWebSearch: sawWebSearch || output.some(isWebSearchCall) };
}

function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
    return url.toString();
  } catch {
    return raw.replace(/[?&]utm_source=openai$/, "");
  }
}

function snippetAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || !text) return "";
  const snippet = text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

export function extractResults(output: unknown[], numResults?: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, title: unknown, snippet = "") => {
    if (typeof url !== "string" || !url.trim()) return;
    const clean = cleanUrl(url);
    if (seen.has(clean)) return;
    seen.add(clean);
    results.push({ title: typeof title === "string" && title.trim() ? title : clean, url: clean, snippet });
  };

  // Citations carry surrounding prose, so they make the better snippets.
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const a of annotations) {
        if (!a || typeof a !== "object" || (a as { type?: unknown }).type !== "url_citation") continue;
        const ann = a as Record<string, unknown>;
        add(ann.url, ann.title, snippetAround(text, ann.start_index, ann.end_index));
      }
    }
  }

  for (const item of output) {
    if (!isWebSearchCall(item)) continue;
    const value = item as { action?: unknown; sources?: unknown; results?: unknown };
    const action = value.action && typeof value.action === "object" ? (value.action as { sources?: unknown }).sources : undefined;
    for (const group of [action, value.sources, value.results]) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!source || typeof source !== "object") continue;
        const record = source as Record<string, unknown>;
        add(record.url ?? record.source_website_url, record.title ?? record.caption);
      }
    }
  }

  return numResults && numResults > 0 ? results.slice(0, Math.min(Math.floor(numResults), 20)) : results;
}

export function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

/** Redact anything that looks like a token before it reaches a transcript. */
function redact(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join("[redacted]") : message).replace(/Bearer\s+[\w.-]+/gi, "Bearer [redacted]");
}

export async function search(query: string, auth: Auth, options: SearchOptions = {}): Promise<SearchResponse> {
  const headers: Record<string, string> = {
    ...auth.headers,
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
  };
  if (auth.codex) {
    const accountId = codexAccountId(auth.apiKey);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    headers.originator = "pi";
  }
  const filters = domainFilters(options.domainFilter);
  const body = {
    model: auth.model,
    instructions: buildInstructions(options),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [{ type: "web_search", ...(filters ? { filters } : {}) }],
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
    tool_choice: "required" as const,
    parallel_tool_calls: true,
  };

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 60_000);
  const onAbort = () => timeout.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await (options.fetch ?? fetch)(auth.responsesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(redact(`OpenAI API error ${response.status}: ${detail}`, auth.apiKey));
    }
    const { output, sawWebSearch } = parseResponseText(await response.text());
    const results = extractResults(output, options.numResults);
    const answer = extractAnswer(output);
    if (!sawWebSearch && !answer && results.length === 0) throw new Error("Search returned no web results");
    return { query, answer, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(message, auth.apiKey));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
