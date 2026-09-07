import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

const descriptions: Record<string, string> = {
  web_search: "Search the web and return synthesized answers with source citations. For research, prefer 2–4 queries with distinct angles. Omit provider to use configured defaults. Results open an interactive curator by default; workflow:none skips it, auto-summary summarizes without opening it. includeContent fetches full pages in the background.",
  source_check: "Check a claim against web sources; return a bounded research artifact with exact passage citations.",
  fetch_content: "Fetch URLs as readable markdown, raw text, or source-grounded answers. Supports images, PDFs, GitHub repos, YouTube transcripts and local videos. Full original content is stored for get_search_content.",
  get_search_content: "Retrieve slices or matching passages from a previous web_search, source_check or fetch_content result.",
};

const common = {
  query: "Single search query; prefer queries for research.",
  queries: "Search 2–4 distinct angles, not rephrasings. Each query gets its own answer.",
  numResults: "Results per query; default 5, maximum 20.",
  domainFilter: "Include domains; prefix with - to exclude.",
};
const fields: Record<string, Record<string, string>> = {
  web_search: {
    ...common,
    workflow: "none: no curator; summary-review: curator + draft (default); auto-summary: summary without curator.",
    proxy: "HTTP(S) proxy for search and content requests; empty string forces direct access. Node fetch ignores HTTP(S)_PROXY; set here or in web-search.json.",
  },
  source_check: { ...common, queries: "Search queries; defaults to the claim." },
  fetch_content: {
    prompt: "Video analysis instruction, or required source-local question for mode:answer.",
    mode: "readable (default): extracted markdown; raw: exact textual HTTP body; answer: answer prompt using only fetched content.",
    answerModel: "provider/model-id override for answer. Defaults to configured fetch.answerProvider/answerModel, otherwise current Pi model.",
    timestamp: "Video timestamp (85, 23:45, 1:23:45) or range (23:41-25:00). Ranges sample evenly (default 6 frames); single timestamp + frames uses 5s intervals. YouTube needs yt-dlp + ffmpeg; local video needs ffmpeg.",
    frames: "Frame count: with range, controls density; with timestamp, samples every 5s; alone, samples entire video. YouTube needs yt-dlp + ffmpeg; local video needs ffmpeg.",
    model: "Gemini model override for video/YouTube; otherwise configured model or gemini-3.6-flash.",
    auth: "Opt into a browser-cookie profile by name; true only if exactly one profile exists.",
    proxy: "HTTP(S) proxy; localhost and NO_PROXY hosts bypass it. Empty string forces direct access.",
  },
  get_search_content: {
    responseId: "Response ID from web_search, source_check or fetch_content.",
    offset: "Character offset, default 0; ignored with findText.",
    limit: "Maximum returned characters; default/max from maxInlineContentChars. Ignored with findText.",
    findText: "Text(s) to find; replaces offset/limit slicing.",
    findMode: "findText matching: exact, case-insensitive (default), or fuzzy.",
  },
};

/** Prose-only compression: preserve every type, constraint, default and executor. */
export function compactWebTool(tool: Tool): Tool {
  if (!descriptions[tool.name]) return tool;
  const original = tool.parameters;
  const properties = { ...original.properties };
  for (const [name, description] of Object.entries(fields[tool.name])) {
    if (properties[name]) properties[name] = { ...properties[name], description };
  }
  return { ...tool, description: descriptions[tool.name], parameters: { ...original, properties } };
}
