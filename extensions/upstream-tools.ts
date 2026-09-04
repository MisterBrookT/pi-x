import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerLsp from "../node_modules/@narumitw/pi-lsp/dist/index.ts";
import registerSubagents from "pi-subagents";
import registerWebAccess from "pi-web-access";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function boundedSubagentTool(pi: ExtensionAPI, tool: RegisteredTool) {
  if (tool.name !== "subagent") return pi.registerTool(tool);
  const execute = tool.execute.bind(tool);
  pi.registerTool({
    ...tool,
    execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) {
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
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export default function (pi: ExtensionAPI) {
  process.env.PI_SUBAGENT_MAX_DEPTH ??= "1";
  process.env.PI_SUBAGENT_MAX_SPAWNS_PER_RUN ??= "8";
  process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION ??= "24";
  const api = toolsOnly(pi);
  registerSubagents(api);
  registerWebAccess(api);
  registerLsp(api);
}
