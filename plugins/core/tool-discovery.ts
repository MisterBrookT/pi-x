import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_TOOL_STATE = "pix:goal-tool-state";
export const GOAL_TOOL_PERMISSION = "pix:goal-tool-permission";

export const DISCOVERY_STATE = "pix:discovered-tools";

/** Pi gives each extension its own API wrapper; share state through its bus. */
export function discoveredTools(pi: ExtensionAPI): Set<string> {
  const state: { tools?: Set<string> } = {};
  pi.events.emit(DISCOVERY_STATE, state);
  return state.tools ?? new Set();
}

export const EVERYDAY_WEB = ["web_search", "fetch_content", "get_search_content"];
/**
 * Pix specialists: registered with `deferred` exposure so Pi's native
 * tool_search can load them. MCP server tools belong to Pi's built-in MCP,
 * whose exposure setting decides how they are reached.
 */
export const SPECIALISTS = [
  ...EVERYDAY_WEB,
  "computer",
  "lsp_diagnostics",
  "lsp_fix",
  "subagent_supervisor",
  "source_check",
  "video_content",
  "goal",
];
export const isDiscoverable = (name: string): boolean => SPECIALISTS.includes(name);

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
/** Registration-time exposure; activation and explicit off choices stay with capabilities/tool. */
export const withSpecialistExposure = (tool: Tool): Tool =>
  isDiscoverable(tool.name) ? { ...tool, exposure: "deferred", namespace: tool.namespace ?? SPECIALIST_NAMESPACE } : tool;
/** tool_search lists searchable sources by namespace; unnamespaced tools would go unmentioned. */
export const SPECIALIST_NAMESPACE = { name: "pix", description: "Pix specialists: web search and fetching, desktop/browser automation, LSP diagnostics and fixes, subagent supervisor communication, goals for substantial multi-step work" };
