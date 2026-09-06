import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const agents = ["worker", "scout", "reviewer", "researcher"];
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
  const fallback = await ctx.ui.select(`${agent} fallback model`, ["none", ...models.filter((candidate) => candidate !== "inherit" && candidate !== model)]);
  if (!fallback) return;
  let fallbackThinking = "default";
  if (fallback !== "none") {
    const chosen = await ctx.ui.select(`${agent} fallback thinking`, thinkingLevels);
    if (!chosen) return;
    fallbackThinking = chosen;
  }
  const fallbackModels = fallback === "none" ? undefined : [fallbackThinking === "default" ? fallback : `${fallback}:${fallbackThinking}`];

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
  text = applyEdits(text, modify(text, ["subagents", "agentOverrides", agent, "fallbackModels"], fallbackModels, { formattingOptions }));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pix-${process.pid}`;
  await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  await rename(temporary, path);
  ctx.ui.notify(`${agent}: ${model}, thinking ${thinking}, fallback ${fallbackModels?.[0] ?? "none"}. Run /reload to apply.`, "info");
}

const commandOptions = {
  websearch: [
    { value: "on", label: "on", description: "Enable web access" },
    { value: "off", label: "off", description: "Disable web access" },
  ],
  subagent: [
    { value: "on", label: "on", description: "Enable subagents" },
    { value: "off", label: "off", description: "Disable subagents" },
    { value: "config", label: "config", description: "Configure role models, thinking, fallback" },
  ],
  computer: [
    { value: "on", label: "on", description: "Enable GUI control for this session" },
    { value: "off", label: "off", description: "Disable GUI control" },
  ],
  mcp: [
    { value: "on", label: "on", description: "Enable MCP tools for this session" },
    { value: "off", label: "off", description: "Disable MCP tools" },
  ],
} as const;

const capabilities = {
  websearch: ["web_search", "source_check", "fetch_content", "get_search_content"],
  subagent: ["subagent", "bg_wait", "subagent_supervisor"],
  computer: [
    "computer", "find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui",
    "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser",
  ],
  mcp: ["mcp", "mcpScript"],
} as const;
const defaultPixTools = ["todo", "question", "lsp_diagnostics", "lsp_fix", ...capabilities.websearch, ...capabilities.subagent];

/**
 * Tool families that stay off until asked for.
 *
 * Every active schema is re-sent on every request, so a family that most
 * sessions never touch is a standing charge on the context window and on the
 * model's attention. Computer use and MCP are both large, both situational, and
 * neither is discoverable as a cost. Enable them per session with /tool, or
 * permanently by listing them in the pix settings.
 *
 * Names are matched only when present, so this costs nothing when the backing
 * package is not installed.
 */
const offByDefault = [
  // @injaneity/pi-computer-use, roughly 2,100 tokens.
  "computer", "find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui",
  "act_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser",
  // pi-mcp-adapter, roughly 1,200 tokens, plus one tool per configured server.
  "mcp", "mcpScript",
];

/** MCP registers one tool per server, which cannot be listed ahead of time. */
const isMcpServerTool = (name: string): boolean => name.startsWith("mcp__");

export default function (pi: ExtensionAPI) {
  /**
   * Families the user turned on for this session.
   *
   * Needed because withheld tools are re-checked before every turn: an owning
   * package may re-enable its own tool at any time. pi-mcp-adapter does exactly
   * this, re-adding `mcp` after session start, so a single pass at startup is
   * not enough to keep it off.
   */
  const enabled = new Set<string>();

  const withhold = () => {
    const active = new Set(pi.getActiveTools());
    let changed = false;
    for (const tool of active) {
      if (enabled.has(tool)) continue;
      if (!offByDefault.includes(tool) && !isMcpServerTool(tool)) continue;
      active.delete(tool);
      changed = true;
    }
    if (changed) pi.setActiveTools([...active]);
  };

  // Re-applied every turn so a package cannot quietly re-enable its own tools.
  pi.on("before_agent_start", withhold);

  pi.on("session_start", () => {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const active = new Set(pi.getActiveTools());
    for (const tool of defaultPixTools) if (available.has(tool)) active.add(tool);
    // Applied after the defaults so a family is off unless explicitly enabled.
    // The /tool command loads later still, so an explicit choice wins over this.
    for (const tool of active) if (!enabled.has(tool) && (offByDefault.includes(tool) || isMcpServerTool(tool))) active.delete(tool);
    pi.setActiveTools([...active].filter((tool) => process.platform === "win32" || tool !== "powershell"));
  });

  for (const [command, tools] of Object.entries(capabilities)) {
    pi.registerCommand(command, {
      description: {
        subagent: "Show, toggle, or configure subagents: /subagent [on|off|config]",
        websearch: "Show or change web access: /websearch [on|off]",
        computer: "Show or change GUI control, off by default: /computer [on|off]",
        mcp: "Show or change MCP tools, off by default: /mcp [on|off]",
      }[command] ?? `Show or change ${command}: /${command} [on|off]`,
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

        const targets = [...family];
        // MCP registers one tool per configured server, so the family list
        // cannot name them; match them by prefix instead.
        if (command === "mcp") targets.push(...[...available].filter(isMcpServerTool));

        for (const tool of targets) {
          if (action === "on") { active.add(tool); enabled.add(tool); }
          else { active.delete(tool); enabled.delete(tool); }
        }
        pi.setActiveTools([...active]);
        ctx.ui.notify(`${command} ${action}`, "info");
      },
    });
  }
}
