import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const agents = ["worker", "scout"];
const thinkingLevels = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function configureSubagent(ctx: ExtensionContext) {
  if (!ctx.hasUI) {
    ctx.ui.notify("/subagent config requires the interactive terminal", "error");
    return;
  }
  const agent = await ctx.ui.select("Configure subagent", agents);
  if (!agent) return;
  const availableModels = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  const models = ["inherit", ...new Set(availableModels.map((model) => `${model.provider}/${model.id}`))];
  const model = await ctx.ui.select(`${agent} model`, models);
  if (!model) return;
  const thinking = await ctx.ui.select(`${agent} thinking`, thinkingLevels);
  if (!thinking) return;

  const path = join(homedir(), ".pi/agent/settings.json");
  let text = "{}\n";
  try { text = await readFile(path, "utf8"); } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const errors: ParseError[] = [];
  const settings = parse(text, errors);
  if (errors.length || !settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`Cannot update invalid settings file: ${path}`);
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;
  text = applyEdits(text, modify(text, ["subagents", "agentOverrides", agent, "model"], model, { formattingOptions }));
  text = applyEdits(text, modify(text, ["subagents", "agentOverrides", agent, "thinking"], thinking === "default" ? undefined : thinking === "off" ? false : thinking, { formattingOptions }));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pix-${process.pid}`;
  await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  await rename(temporary, path);
  ctx.ui.notify(`${agent}: ${model}, thinking ${thinking}. Run /reload to apply.`, "info");
}

const commandOptions = {
  websearch: [
    { value: "on", label: "on", description: "Enable web access" },
    { value: "off", label: "off", description: "Disable web access" },
  ],
  subagent: [
    { value: "on", label: "on", description: "Enable subagents" },
    { value: "off", label: "off", description: "Disable subagents" },
    { value: "config", label: "config", description: "Configure role models and thinking" },
  ],
} as const;

const capabilities = {
  websearch: ["web_search", "source_check", "fetch_content", "get_search_content"],
  subagent: ["subagent", "bg_wait", "subagent_supervisor"],
} as const;
const defaultPixTools = ["todo", "question", "lsp_diagnostics", "lsp_fix", ...capabilities.websearch, ...capabilities.subagent];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const active = new Set(pi.getActiveTools());
    for (const tool of defaultPixTools) if (available.has(tool)) active.add(tool);
    pi.setActiveTools([...active].filter((tool) => process.platform === "win32" || tool !== "powershell"));
  });

  for (const [command, tools] of Object.entries(capabilities)) {
    pi.registerCommand(command, {
      description: command === "subagent"
        ? "Show, toggle, or configure subagents: /subagent [on|off|config]"
        : "Show or change web access: /websearch [on|off]",
      getArgumentCompletions: (prefix) => {
        const matches = commandOptions[command as keyof typeof commandOptions].filter(option => option.value.startsWith(prefix));
        return matches.length ? [...matches] : null;
      },
      handler: async (rawArgs, ctx) => {
        const action = rawArgs.trim().toLowerCase();
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        const active = new Set(pi.getActiveTools());
        const family = tools.filter((tool) => available.has(tool));

        if (!action) {
          const enabled = family.length > 0 && family.every((tool) => active.has(tool));
          ctx.ui.notify(`${command} is ${enabled ? "on" : "off"}`, "info");
          return;
        }
        if (command === "subagent" && action === "config") {
          await configureSubagent(ctx);
          return;
        }
        if (action !== "on" && action !== "off") {
          ctx.ui.notify(`Usage: /${command} [on|off${command === "subagent" ? "|config" : ""}]`, "error");
          return;
        }

        for (const tool of family) {
          if (action === "on") active.add(tool);
          else active.delete(tool);
        }
        pi.setActiveTools([...active]);
        ctx.ui.notify(`${command} ${action}`, "info");
      },
    });
  }
}
