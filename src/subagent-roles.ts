import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  mergeBuiltinAgentOverride,
  removeBuiltinAgentOverrideFields,
  type AgentConfig,
} from "../node_modules/pi-subagents/src/agents/agents.ts";

import { subagentRoles } from "./subagent-policy.ts";

export const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function roleSummary(agent: AgentConfig): string {
  const model = agent.model && agent.model !== "inherit" ? agent.model : "parent model";
  const effort = typeof agent.thinking === "string" ? agent.thinking : "parent effort";
  return `${agent.name} · ${model} · ${effort}`;
}

/** Use the executor's discovery and override format, not a second role registry. */
export async function configureSubagentRoles(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Subagent role configuration requires an interactive UI.", "error");
    return;
  }
  // Discovery reads project settings too; do not load them before trust is granted.
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("Trust this project before configuring subagent roles.", "error");
    return;
  }
  try {
    while (true) {
      const agents = discoverAgents(ctx.cwd, "both", ctx.model?.provider).agents
        .filter(agent => subagentRoles.some(role => role === agent.name));
      const labels = agents.map(roleSummary);
      const selected = await ctx.ui.select("Subagent roles · user settings · model / effort", labels);
      const agent = agents[labels.indexOf(selected ?? "")];
      if (!agent) return;
      const field = await ctx.ui.select(`${agent.name} · ${agent.description}`, ["Model", "Effort", "Fallback"]);
      if (!field) continue;
      let fields: { model?: string; thinking?: string; fallbackModels?: string[] };
      const available = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
      const models = [...new Set(available.map(model => `${model.provider}/${model.id}`))];
      if (field === "Model") {
        const selectedModel = await ctx.ui.select(`${agent.name} model · current: ${agent.model ?? "parent"}`, ["Inherit parent model", ...new Set(models)]);
        if (!selectedModel) continue;
        fields = { model: selectedModel === "Inherit parent model" ? "inherit" : selectedModel };
      } else if (field === "Effort") {
        const thinking = await ctx.ui.select(`${agent.name} effort · current: ${agent.thinking || "parent"} (runtime may clamp to model limits)`, ["Default", ...effortLevels]);
        if (!thinking) continue;
        if (thinking === "Default") {
          removeBuiltinAgentOverrideFields(ctx.cwd, agent.name, "user", ["thinking"]);
          ctx.ui.notify(`Reset ${agent.name} user effort override. Applies to new children.`, "info");
          continue;
        }
        fields = { thinking };
      } else {
        const fallback = await ctx.ui.select(`${agent.name} fallback · current: ${agent.fallbackModels?.join(", ") || "none"}`, ["None", ...models]);
        if (!fallback) continue;
        if (fallback === "None") fields = { fallbackModels: [] };
        else {
          const thinking = await ctx.ui.select(`${agent.name} fallback effort`, ["Default", ...effortLevels]);
          if (!thinking) continue;
          fields = { fallbackModels: [thinking === "Default" ? fallback : `${fallback}:${thinking}`] };
        }
      }
      const path = mergeBuiltinAgentOverride(ctx.cwd, agent.name, "user", fields);
      ctx.ui.notify(`Saved ${agent.name} ${field.toLowerCase()} in ${path}. Applies to new children; higher-priority project/provider overrides may still win.`, "info");
    }
  } catch (error) {
    ctx.ui.notify(`Could not configure subagent roles: ${(error as Error).message}`, "error");
  }
}
