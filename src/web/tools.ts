/**
 * The three web tools Pix registers: `web_search`, `fetch_content`, and
 * `get_search_content`.
 *
 * Large results never go straight into the context. A tool returns a preview
 * plus a `responseId`, and the model reads the rest in slices.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allowRangesOf, fetchTimeoutMs, maxInlineChars, readWebConfig, type WebConfig } from "./config.ts";
import { fetchUrl } from "./fetch.ts";
import { resolveAuth, search } from "./search.ts";
import { type FindMode, findContent, getRecord, sliceContent, store } from "./storage.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Result = { content: { type: "text"; text: string }[]; details?: Record<string, unknown> };

const PREVIEW_CHARS = 2_000;
/** More than a handful of pages at once is usually an unfocused request. */
const MAX_URLS = 10;

function textResult(text: string, details: Record<string, unknown> = {}): Result {
  return { content: [{ type: "text", text }], details };
}

function errorResult(message: string, details: Record<string, unknown> = {}): Result {
  return textResult(`Error: ${message}`, { ...details, error: message });
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return [];
}

export function webSearchTool(config: () => WebConfig): Tool {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return a synthesized answer with source citations. Prefer queries (plural) with 2-4 varied angles for research, since each query is answered separately. Full result text is stored; read it with get_search_content.",
    promptSnippet: "Search the web. Prefer {queries:[...]} with 2-4 varied angles over a single query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Single search query. For research, prefer 'queries' with several angles." },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Multiple queries searched in sequence, each returning its own answer. Vary phrasing, scope, and angle across 2-4 queries for coverage.",
        },
        numResults: { type: "integer", minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)" },
        recencyFilter: { type: "string", enum: ["day", "week", "month", "year"], description: "Filter by recency" },
        domainFilter: { type: "array", items: { type: "string" }, description: "Limit to domains (prefix with - to exclude)" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_id: string, args: Record<string, unknown>, signal: AbortSignal, _update: unknown, ctx: ExtensionContext): Promise<Result> {
      const queries = [...asStringArray(args.query), ...asStringArray(args.queries)];
      if (queries.length === 0) return errorResult("web_search requires query or queries");
      const settings = config();
      const auth = await resolveAuth(ctx, settings);
      if (!auth) {
        return errorResult("No OpenAI or Codex credentials available. Sign in with /login openai-codex, or set openaiApiKey in web-search.json.");
      }
      const numResults = typeof args.numResults === "number" ? args.numResults : 5;
      const answered: { query: string; answer: string; sources: { url: string; title: string; snippet?: string }[] }[] = [];
      const failures: string[] = [];
      for (const query of queries) {
        if (signal.aborted) break;
        try {
          const response = await search(query, auth, {
            numResults,
            recencyFilter: args.recencyFilter as never,
            domainFilter: args.domainFilter as string[] | undefined,
            signal,
          });
          answered.push({ query, answer: response.answer, sources: response.results });
        } catch (error) {
          failures.push(`${query}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (answered.length === 0) return errorResult(failures.join("; ") || "No results", { queryCount: queries.length });

      const responseId = store({ type: "search", queries: answered });
      const sections = answered.map(({ query, answer, sources }) => {
        const list = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})${s.snippet ? `\n   ${s.snippet}` : ""}`).join("\n");
        return `## ${query}\n\n${answer}\n\n### Sources\n${list || "(none)"}`;
      });
      const text = sections.join("\n\n");
      const truncated = text.length > PREVIEW_CHARS * 4;
      return textResult(
        truncated ? `${text.slice(0, PREVIEW_CHARS * 4)}\n\n_Truncated. Read the rest with get_search_content responseId=${responseId}._` : text,
        {
          responseId,
          queryCount: queries.length,
          successful: answered.length,
          resultCount: answered.reduce((n, a) => n + a.sources.length, 0),
          truncated,
          ...(failures.length ? { failed: failures } : {}),
        },
      );
    },
  } as Tool;
}

export function fetchContentTool(config: () => WebConfig): Tool {
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch URL(s) and extract readable content as markdown. Use mode 'raw' for the exact textual HTTP body. PDFs are extracted to text. Large content is stored; read the rest with get_search_content.",
    promptSnippet: "Fetch readable or raw content from URLs, including PDFs.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Single URL to fetch" },
        urls: { type: "array", items: { type: "string" }, description: "Multiple URLs (fetched in parallel)" },
        mode: { type: "string", enum: ["readable", "raw"], description: "readable (default extraction) or raw (exact textual HTTP body)" },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(_id: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
      const urls = [...asStringArray(args.url), ...asStringArray(args.urls)];
      if (urls.length === 0) return errorResult("fetch_content requires url or urls");
      if (urls.length > MAX_URLS) return errorResult(`fetch_content accepts at most ${MAX_URLS} URLs per call`);
      const settings = config();
      const mode = args.mode === "raw" ? "raw" : "readable";
      let allowRanges: ReturnType<typeof allowRangesOf>;
      try {
        allowRanges = allowRangesOf(settings);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      const fetched = await Promise.all(
        urls.map((url) => fetchUrl(url, { mode, signal, allowRanges, timeoutMs: fetchTimeoutMs(settings), pdf: settings.pdf })),
      );
      const successful = fetched.filter((r) => !r.error);
      const limit = maxInlineChars(settings);
      const responseId = store({ type: "fetch", urls: fetched });
      if (successful.length === 0) {
        return errorResult(fetched.map((r) => `${r.url}: ${r.error}`).join("; "), { urlCount: urls.length, successful: 0, responseId });
      }
      const body = fetched
        .map((r) => (r.error ? `## ${r.url}\n\nError: ${r.error}` : `## ${r.title ?? r.url}\n${r.url}\n\n${r.content}`))
        .join("\n\n---\n\n");
      const truncated = body.length > limit;
      const text = truncated
        ? `${body.slice(0, limit)}\n\n_Truncated at ${limit} characters. Read the rest with get_search_content responseId=${responseId}._`
        : body;
      return textResult(text, {
        responseId,
        urlCount: urls.length,
        successful: successful.length,
        totalChars: fetched.reduce((n, r) => n + r.content.length, 0),
        title: successful[0]?.title,
        truncated,
      });
    },
  } as Tool;
}

export function getSearchContentTool(config: () => WebConfig): Tool {
  return {
    name: "get_search_content",
    label: "Get Search Content",
    description: "Retrieve bounded content slices, or find matching passages, from a previous web_search or fetch_content call.",
    promptSnippet: "Read stored web_search or fetch_content results by responseId. Use findText to jump to a passage.",
    parameters: {
      type: "object",
      properties: {
        responseId: { type: "string", description: "The responseId from web_search or fetch_content" },
        url: { type: "string", description: "Get content for this URL" },
        urlIndex: { type: "integer", minimum: 0, description: "Get content for the URL at this index" },
        query: { type: "string", description: "Get content for this query" },
        queryIndex: { type: "integer", minimum: 0, description: "Get content for the query at this index" },
        offset: { type: "integer", minimum: 0, description: "Character offset (default 0). Ignored when findText is supplied." },
        limit: { type: "integer", minimum: 1, description: "Maximum characters to return. Ignored when findText is supplied." },
        findText: {
          anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, minItems: 1, maxItems: 10 }],
          description: "Text or texts to find in the stored content. When supplied, offset and limit are ignored.",
        },
        findMode: { type: "string", enum: ["exact", "case-insensitive", "fuzzy"], description: "Matching mode for findText (default: case-insensitive)." },
      },
      required: ["responseId"],
      additionalProperties: false,
    },
    async execute(_id: string, args: Record<string, unknown>): Promise<Result> {
      if (args.findMode && !args.findText) return errorResult("findMode requires findText");
      const responseId = String(args.responseId ?? "");
      const record = getRecord(responseId);
      if (!record) return errorResult("Not found", { responseId });

      let content: string;
      let label: string;
      if (record.type === "fetch") {
        const entries = record.urls ?? [];
        const index = typeof args.urlIndex === "number" ? args.urlIndex : typeof args.url === "string" ? entries.findIndex((e) => e.url === args.url) : 0;
        const entry = entries[index];
        if (!entry) return errorResult("No stored content for that URL", { responseId });
        if (entry.error) return errorResult(entry.error, { responseId, url: entry.url });
        content = entry.content;
        label = entry.title ?? entry.url;
      } else {
        const entries = record.queries ?? [];
        const index = typeof args.queryIndex === "number" ? args.queryIndex : typeof args.query === "string" ? entries.findIndex((e) => e.query === args.query) : 0;
        const entry = entries[index];
        if (!entry) return errorResult("No stored content for that query", { responseId });
        content = `${entry.answer}\n\n### Sources\n${entry.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})${s.snippet ? `\n   ${s.snippet}` : ""}`).join("\n")}`;
        label = entry.query;
      }

      const terms = asStringArray(args.findText);
      if (terms.length > 0) {
        const findMode = (args.findMode as FindMode) ?? "case-insensitive";
        const matches = findContent(content, terms, findMode);
        if (matches.length === 0) return textResult(`No matches for ${terms.join(", ")} in ${label}.`, { responseId, matchCount: 0, findMode });
        return textResult(matches.map((m) => `…${m.text}…`).join("\n\n---\n\n"), {
          responseId,
          matchCount: matches.length,
          returnedMatches: matches.length,
          findMode,
          contentLength: content.length,
        });
      }

      try {
        const slice = sliceContent(content, typeof args.offset === "number" ? args.offset : 0, typeof args.limit === "number" ? args.limit : maxInlineChars(config()));
        const more = slice.nextOffset === undefined ? "" : `\n\n_More available from offset ${slice.nextOffset}._`;
        return textResult(slice.text + more, {
          responseId,
          title: label,
          contentLength: slice.contentLength,
          offset: slice.offset,
          returnedChars: slice.returnedChars,
          nextOffset: slice.nextOffset,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), { responseId });
      }
    },
  } as Tool;
}

/** Register the web tools, reading settings fresh on every call. */
export function registerWebTools(pi: ExtensionAPI, config: () => WebConfig = () => readWebConfig()): void {
  pi.registerTool(webSearchTool(config));
  pi.registerTool(fetchContentTool(config));
  pi.registerTool(getSearchContentTool(config));
}
