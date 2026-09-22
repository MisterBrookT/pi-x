import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOL_STATE = "pix:goal-tool-state";
export const GOAL_TOOL_PERMISSION = "pix:goal-tool-permission";

export const DISCOVERY_STATE = "pix:discovered-tools";
export const MCP_TOOL_NAMES = "pix:mcp-tool-names";

/** Registered ownership, not activation: custom MCP prefixes remain discoverable. */
export function ownedMcpTools(pi: ExtensionAPI): ReadonlySet<string> {
  const state: { names?: ReadonlySet<string> } = {};
  pi.events.emit(MCP_TOOL_NAMES, state);
  return state.names ?? new Set();
}

/** Pi gives each extension its own API wrapper; share state through its bus. */
export function discoveredTools(pi: ExtensionAPI): Set<string> {
  const state: { tools?: Set<string> } = {};
  pi.events.emit(DISCOVERY_STATE, state);
  return state.tools ?? new Set();
}

export const EVERYDAY_WEB = ["web_search", "fetch_content", "get_search_content"];
export const SPECIALISTS: Record<string, string> = {
  web_search: "web internet search research",
  fetch_content: "fetch read web pages URLs articles",
  get_search_content: "retrieve saved web search fetch results responseId",
  computer: "computer browser desktop GUI interaction automation",
  lsp_diagnostics: "code diagnostics language server errors types lint",
  lsp_fix: "code fixes language server organize imports",
  subagent_supervisor: "subagent supervisor communication message reply decision",
  source_check: "web source credibility verification check",
  video_content: "video content analysis youtube",
  mcp: "MCP external integrations servers",
  mcpScript: "MCP scripts external integrations servers",
};
export const isDiscoverable = (name: string, mcpNames?: ReadonlySet<string>): boolean => Object.hasOwn(SPECIALISTS, name) || name.startsWith("mcp__") || mcpNames?.has(name) === true;

export function discoveryMatches(tools: { name: string; description?: string }[], query: string, limit: number, mcpNames?: ReadonlySet<string>): string[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 1);
  if (!terms.length || limit < 1) return [];
  const candidates = tools.filter(tool => isDiscoverable(tool.name, mcpNames));
  const exact = candidates.find(tool => tool.name.toLowerCase() === query.trim().toLowerCase());
  if (exact) return [exact.name];
  return candidates.map(tool => {
    const text = `${tool.name} ${SPECIALISTS[tool.name] ?? "MCP external integration"} ${tool.description ?? ""}`.toLowerCase();
    const score = tool.name.toLowerCase() === query.trim().toLowerCase() ? 1000
      : terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { name: tool.name, score };
  }).filter(tool => tool.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit).map(tool => tool.name);
}
