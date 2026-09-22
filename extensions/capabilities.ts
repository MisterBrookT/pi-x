/**
 * Which tools a session starts with, and which stay off until asked for.
 *
 * Active schemas occupy model context. Specialists stay deferred until
 * discover_tools activates them for this session or /tool explicitly enables
 * them. Discovery never writes preferences or overrides a saved off choice.
 *
 * Explicit choices live in shared agent settings. Every session rereads them
 * before a turn; navigating a branch never rewinds them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";
import { CAPABILITIES, defaultToolMode, toolChoice } from "../src/tool-panel.ts";
import { Type } from "typebox";
import { DISCOVERY_STATE, discoveryMatches, ownedMcpTools, GOAL_TOOL_STATE, GOAL_TOOL_PERMISSION } from "../src/tool-discovery.ts";

/** Tools pix enables for a new session, beyond Pi's own defaults. */
const defaultPixTools = [
  "todo",
  "question",
  "discover_tools",
  ...CAPABILITIES.filter((capability) => capability.defaultOn).flatMap((capability) => capability.primary).filter(name => defaultToolMode(name) === "on"),
];

export default function (pi: ExtensionAPI, settings: ToolSettings = toolSettings()) {
  const loaded = new Set<string>();
  let goalActive = false;
  pi.events.on(DISCOVERY_STATE, (data: unknown) => {
    if (data && typeof data === "object") (data as { tools?: Set<string> }).tools = loaded;
  });
  const apply = (seed = false) => {
    if (seed) {
      loaded.clear();
      if (goalActive) loaded.add("goal");
    }
    const known = pi.getAllTools().map(tool => tool.name);
    const current = new Set(pi.getActiveTools());
    if (seed) for (const name of defaultPixTools) if (known.includes(name)) current.add(name);
    const overrides = settings.read();
    for (const name of loaded) if (overrides[name] === false) loaded.delete(name);
    const selected = selectedTools(known, current, overrides, loaded, ownedMcpTools(pi));
    pi.setActiveTools(selected.filter(name => process.platform === "win32" || name !== "powershell"));
  };
  pi.events.on(GOAL_TOOL_PERMISSION, (data: unknown) => {
    if (data && typeof data === "object") (data as { allowed?: boolean }).allowed = settings.read().goal !== false;
  });
  pi.events.on(GOAL_TOOL_STATE, (data: unknown) => {
    if (!data || typeof data !== "object" || !("active" in data) || typeof data.active !== "boolean") return;
    goalActive = data.active;
    if (data.active) loaded.add("goal"); else loaded.delete("goal");
    apply();
  });
  pi.on("session_start", () => apply(true));
  pi.on("session_tree", () => apply());
  pi.on("before_agent_start", () => apply());

  pi.registerTool({
    name: "discover_tools",
    label: "Discover tools",
    description: "Find tools by capability or exact name and activate them for this session. Covers web, desktop/browser automation, LSP, subagent communication, and MCP integrations. Explicitly disabled tools remain unavailable.",
    promptSnippet: "Find and activate optional tools",
    promptGuidelines: ["When available tools cannot perform a task, use discover_tools to find a specialist. Respect explicitly disabled tools."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Capability needed or exact tool name" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }),
    async execute(_id, params) {
      const overrides = settings.read();
      const matches = discoveryMatches(pi.getAllTools(), params.query, params.limit ?? 2, ownedMcpTools(pi));
      const blocked = matches.filter(name => toolChoice(name, overrides, ownedMcpTools(pi)) === false);
      const allowed = matches.filter(name => toolChoice(name, overrides, ownedMcpTools(pi)) !== false);
      for (const name of allowed) loaded.add(name);
      apply();
      const active = new Set(pi.getActiveTools());
      const activated = allowed.filter(name => active.has(name));
      const text = [
        activated.length ? `Available now: ${activated.join(", ")}. Call these tools normally.` : "No matching tools activated.",
        blocked.length ? `Disabled by user: ${blocked.join(", ")}. Only the user may enable them through /tool.` : "",
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text }], details: { activated, blocked } };
    },
  });

  /** Compatibility alias for the role editor exposed by /tool subagent roles. */
  pi.registerCommand("subagent-config", {
    description: "Configure subagent role models, thinking level, and fallback",
    handler: async (_args, ctx) => {
      const { configureSubagentRoles } = await import("../src/subagent-roles.ts");
      await configureSubagentRoles(ctx);
    },
  });
}
