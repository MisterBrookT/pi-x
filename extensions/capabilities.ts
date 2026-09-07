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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";
import { CAPABILITIES } from "../src/tool-panel.ts";

const agents = ["worker", "scout", "reviewer", "researcher"];
const thinkingLevels = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function configureSubagent(ctx: ExtensionContext) {
  if (!ctx.hasUI) {
    ctx.ui.notify("/subagent-config requires the interactive terminal", "error");
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

  /**
   * Subagent role configuration.
   *
   * This is not a tool toggle: it edits model, thinking level, and fallback in
   * settings.json. `/tool` owns on/off, so this keeps its own command rather
   * than hiding a settings editor inside a picker.
   */
  pi.registerCommand("subagent-config", {
    description: "Configure subagent role models, thinking level, and fallback",
    handler: async (_args, ctx) => {
      await configureSubagent(ctx);
    },
  });
}
