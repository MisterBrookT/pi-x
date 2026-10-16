import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Own only our tools' guidance; never rewrite the assembled system prompt. */
export function withPixToolGuidance(tool: Tool): Tool {
  if (tool.name === "lsp_diagnostics") return {
    ...tool,
    promptSnippet: "Check diagnostics using configured language servers",
    promptGuidelines: ["Use configured LSP servers for targeted diagnostics. If a server is unavailable, report that and use the project's checks."],
  };
  if (tool.name === "lsp_fix") return {
    ...tool,
    promptSnippet: "Apply fixes using configured language servers",
    promptGuidelines: ["Use LSP source fixes when supported by the configured server, then verify the resulting changes."],
  };
  return tool;
}
