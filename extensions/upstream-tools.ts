import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerLsp from "../node_modules/@narumitw/pi-lsp/dist/index.ts";
import registerSubagents from "pi-subagents";
import registerWebAccess from "pi-web-access";
import { simplifySubagent } from "../src/simple-subagent.ts";
import { registerCapabilityAction } from "../src/capability-actions.ts";
import { configureSubagentRoles } from "../src/subagent-roles.ts";
import { withAnimatedSubagentWidgets } from "../src/subagent-spinner.ts";
import { webProfiles } from "../src/web-profiles.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function boundedSubagentTool(pi: ExtensionAPI, tool: RegisteredTool) {
  if (tool.name !== "subagent") {
    for (const profile of webProfiles(tool)) pi.registerTool(profile);
    return;
  }
  tool = simplifySubagent(tool);
  const execute = tool.execute.bind(tool);
  pi.registerTool({
    ...tool,
    execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, rawCtx: unknown) {
      const ctx = withAnimatedSubagentWidgets(rawCtx as Parameters<typeof withAnimatedSubagentWidgets>[0]);
      const isInlineWorkflow = typeof params.workflowScript === "string" || typeof params.workflowScriptPath === "string";
      if (!isInlineWorkflow) return execute(toolCallId, params, signal, onUpdate, ctx);
      const requestedConcurrency = typeof params.globalConcurrencyLimit === "number" ? params.globalConcurrencyLimit : 4;
      const requestedSpawns = typeof params.maxSubagentSpawnsPerRun === "number" ? params.maxSubagentSpawnsPerRun : 8;
      return execute(toolCallId, {
        ...params,
        globalConcurrencyLimit: Math.min(requestedConcurrency, 4),
        maxSubagentSpawnsPerRun: Math.min(requestedSpawns, 8),
      }, signal, onUpdate, ctx);
    },
  });
}

function toolsOnly(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerCommand") return () => {};
      if (property === "registerTool") return (tool: RegisteredTool) => boundedSubagentTool(target, tool);
      // Upstream widgets cache rendered lines per 1s frame; animate them at pi's spinner cadence.
      if (property === "on") return (event: string, handler: (e: unknown, ctx: unknown) => unknown) =>
        target.on(event as Parameters<ExtensionAPI["on"]>[0], ((e: unknown, ctx: unknown) =>
          handler(e, withAnimatedSubagentWidgets(ctx as Parameters<typeof withAnimatedSubagentWidgets>[0]))) as Parameters<ExtensionAPI["on"]>[1]);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function (pi: ExtensionAPI) {
  process.env.PI_SUBAGENT_MAX_DEPTH ??= "1";
  process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN ??= "8";
  process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION ??= "24";
  registerCapabilityAction(pi, "subagent", {
    verb: "roles",
    description: "Set each role's model and effort",
    shortcut: "r",
    run: configureSubagentRoles,
  });
  const api = toolsOnly(pi);
  registerSubagents(api);
  registerWebAccess(api);
  registerLsp(api);
}
