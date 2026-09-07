import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactWebTool } from "./compact-web.ts";
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

const coreFields: Record<string, string[]> = {
  web_search: ["query", "queries", "numResults", "recencyFilter", "domainFilter"],
  fetch_content: ["url", "urls", "mode", "prompt"],
  get_search_content: ["responseId", "url", "offset", "limit", "findText", "findMode"],
};

/** A narrow argument contract, not merely hidden documentation. */
function selectFields(tool: Tool, names: string[]): Tool {
  const properties = Object.fromEntries(names.filter(n => tool.parameters.properties[n]).map(n => [n, tool.parameters.properties[n]]));
  return {
    ...tool,
    parameters: { ...tool.parameters, properties,
      required: (tool.parameters.required ?? []).filter((n: string) => names.includes(n)), additionalProperties: false },
    prepareArguments: undefined,
    execute(id, args, signal, update, ctx) {
      for (const key of Object.keys(args)) if (!names.includes(key)) throw new Error(`Unsupported ${tool.name} option: ${key}`);
      return tool.execute(id, args, signal, update, ctx);
    },
  };
}

/** Everyday research plus optional tools managed by the Web advanced panel. */
export function webProfiles(original: Tool): Tool[] {
  const compact = compactWebTool(original);
  if (!coreFields[original.name]) return [compact];
  const core = selectFields(compact, coreFields[original.name]);
  if (original.name === "web_search") core.description = "Search the web using configured provider/network defaults. Returns summaries and source links. Use 2–4 distinct queries for research. Fetch important sources to inspect their evidence. The configured curator workflow may open a review interface.";
  if (original.name !== "fetch_content") return [core];
  core.description = "Read webpages, PDFs, images or repositories from URLs. readable (default) extracts text; raw returns textual HTTP content; answer answers prompt using only fetched content. Large content is stored; use get_search_content for more. Use video_content for video analysis.";
  const video = selectFields(compact, ["url", "prompt", "timestamp", "frames"]);
  return [core, {
    ...video, name: "video_content", label: "Video",
    parameters: { ...video.parameters, required: ["url"] },
    description: "Analyze a YouTube or local video using the configured backend. Supply url and optionally a question, timestamp/range or frame count. Uses the same fetching backend as fetch_content; results are stored for get_search_content.",
    promptSnippet: "Analyze videos or extract frames (optional)",
    promptGuidelines: [],
    renderCall: undefined,
    async execute(id, args, signal, update, ctx) {
      if (typeof args.url !== "string" || !args.url.trim()) throw new Error("video_content requires url");
      return video.execute(id, args, signal, update, ctx);
    },
  }];
}
