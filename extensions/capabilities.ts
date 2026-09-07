/**
 * Which tools a session starts with, and which stay off until asked for.
 *
 * Every active schema is re-sent on every request, so a family most sessions
 * never touch is a standing charge on the context window and on the model's
 * attention. Computer use and MCP are both large and both situational, so they
 * are withheld until chosen through `/tool`.
 *
 * Choices live in shared agent settings, not in conversation history. Every
 * session rereads them before a turn; navigating a branch never rewinds them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";
import { CAPABILITIES } from "../src/tool-panel.ts";

/** Tools pix enables for a new session, beyond Pi's own defaults. */
const defaultPixTools = [
  "todo",
  "question",
  "lsp_diagnostics",
  "lsp_fix",
  ...CAPABILITIES.filter((capability) => capability.defaultOn).flatMap((capability) => capability.primary),
];

export default function (pi: ExtensionAPI, settings: ToolSettings = toolSettings()) {
  const apply = (seed = false) => {
    const known = pi.getAllTools().map(tool => tool.name);
    const current = new Set(pi.getActiveTools());
    if (seed) for (const name of defaultPixTools) if (known.includes(name)) current.add(name);
    const selected = selectedTools(known, current, settings.read());
    pi.setActiveTools(selected.filter(name => process.platform === "win32" || name !== "powershell"));
  };
  pi.on("session_start", () => apply(true));
  pi.on("session_tree", () => apply());
  pi.on("before_agent_start", () => apply());

  /** Compatibility alias for the role editor exposed by /tool subagent roles. */
  pi.registerCommand("subagent-config", {
    description: "Configure subagent role models, thinking level, and fallback",
    handler: async (_args, ctx) => {
      const { configureSubagentRoles } = await import("../src/subagent-roles.ts");
      await configureSubagentRoles(ctx);
    },
  });
}
