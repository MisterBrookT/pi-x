/**
 * Which tools a session starts with, and which stay off until asked for.
 *
 * Active schemas occupy model context. Pix specialists are registered with
 * `deferred` exposure, so Pi's native tool_search loads them for this session
 * or /tool explicitly enables them; loads last for the session, including
 * reloads. Loading never writes preferences or overrides a saved off choice:
 * an off tool is dropped from the active set and its calls are blocked, also
 * when a codemode script issues them.
 *
 * Explicit choices live in shared agent settings. Every session rereads them
 * before a turn; navigating a branch never rewinds them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";
import { CAPABILITIES, defaultToolMode, toolChoice } from "../src/tool-panel.ts";
import { DISCOVERY_STATE, GOAL_TOOL_STATE, GOAL_TOOL_PERMISSION } from "../src/tool-discovery.ts";

const TOOL_SEARCH = "tool_search";

/** Tools pix enables for a new session, beyond Pi's own defaults. */
const defaultPixTools = [
  "todo",
  "question",
  TOOL_SEARCH,
  ...CAPABILITIES.filter((capability) => capability.defaultOn).flatMap((capability) => capability.primary).filter(name => defaultToolMode(name) === "on"),
];

const loadedBy = (details: unknown): string[] => {
  const loaded = (details as { loaded?: unknown } | undefined)?.loaded;
  return Array.isArray(loaded) ? loaded.filter((name): name is string => typeof name === "string") : [];
};

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
    const selected = selectedTools(known, current, overrides, loaded);
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
  // A reload of the same session must keep what tool_search already loaded in this session,
  // so the tool results on the current branch are the record, not module memory.
  const restore = (ctx: any) => {
    let entries: any[] = [];
    try { entries = ctx?.sessionManager?.getBranch?.() ?? []; } catch { return; }
    for (const entry of entries) {
      const m = entry?.type === "message" ? entry.message : undefined;
      if (m?.role === "toolResult" && m.toolName === TOOL_SEARCH) for (const name of loadedBy(m.details)) loaded.add(name);
    }
  };
  pi.on("session_start", (_event, ctx) => { apply(true); restore(ctx); apply(); });
  pi.on("session_tree", () => apply());
  pi.on("before_agent_start", () => apply());

  // Deferred tools stay callable from codemode whether active or not; an explicit off must hold there too.
  pi.on("tool_call", (event) => {
    if (toolChoice(event.toolName, settings.read()) !== false) return;
    return { block: true, reason: `${event.toolName} is disabled by the user. Only the user may enable it through /tool.` };
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== TOOL_SEARCH || event.isError) return;
    const overrides = settings.read();
    const found = loadedBy(event.details);
    const blocked = found.filter(name => toolChoice(name, overrides) === false);
    for (const name of found) if (!blocked.includes(name)) loaded.add(name);
    apply();
    if (!blocked.length) return;
    return {
      content: [...event.content, { type: "text", text: `Disabled by user: ${blocked.join(", ")}. Only the user may enable them through /tool.` }],
      details: { ...(event.details as object), loaded: found.filter(name => !blocked.includes(name)), blocked },
    };
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
