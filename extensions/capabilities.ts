/**
 * Which tools a session starts with, and which stay off until asked for.
 *
 * Every active schema is re-sent on every request, so a family most sessions
 * never touch is a standing charge on the context window and on the model's
 * attention. Computer use and MCP are both large and both situational, so they
 * are withheld until chosen through `/tool`.
 *
 * Choices live in one record owned by `/tool`. Earlier versions had a second
 * record written by per-family commands like `/computer`, which let the two
 * disagree: whichever ran last silently undid the other. Those commands are
 * gone and this reads the single record.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { type Overrides, readOverrides } from "../src/tool-overrides.ts";
import { CAPABILITIES, isMcpServerTool } from "../src/tool-panel.ts";

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

/**
 * Tools withheld unless chosen.
 *
 * Derived from the capability definitions so the panel and the defaults cannot
 * drift apart: a capability marked off-by-default withholds everything it owns,
 * and one marked on-by-default still withholds its secondary tools, which are
 * internals the primary tool calls without their schemas being sent.
 */
const offByDefault = new Set(
  CAPABILITIES.flatMap((capability) =>
    capability.defaultOn ? capability.secondary : [...capability.primary, ...capability.secondary],
  ),
);

const isWithheld = (name: string): boolean => offByDefault.has(name) || isMcpServerTool(name);

export default function (pi: ExtensionAPI) {
  /**
   * Explicit choices, replayed from the session record.
   *
   * Needed because withheld tools are re-checked before every turn: an owning
   * package may re-enable its own tool at any time. pi-mcp-adapter does exactly
   * this, re-adding `mcp` after session start, so a single pass at startup is
   * not enough to keep it off.
   */
  let overrides: Overrides = {};

  const restore = (ctx: ExtensionContext) => {
    overrides = readOverrides(ctx);
  };

  /** Withhold every off-by-default tool the user has not asked for. */
  const withhold = () => {
    const active = new Set(pi.getActiveTools());
    let changed = false;
    for (const name of active) {
      if (overrides[name] === true) continue;
      if (overrides[name] !== false && !isWithheld(name)) continue;
      active.delete(name);
      changed = true;
    }
    if (changed) pi.setActiveTools([...active]);
  };

  /** Re-enable the tools the record says were chosen. */
  const applyChosen = () => {
    const available = new Set(pi.getAllTools().map((entry) => entry.name));
    const active = new Set(pi.getActiveTools());
    let changed = false;
    for (const [name, on] of Object.entries(overrides)) {
      if (!on || !available.has(name) || active.has(name)) continue;
      active.add(name);
      changed = true;
    }
    if (changed) pi.setActiveTools([...active]);
  };

  // Re-applied every turn so a package cannot quietly re-enable its own tools.
  // The record is re-read first, so a choice made mid-session is honoured
  // rather than withheld again on the next turn.
  pi.on("before_agent_start", (_event, ctx) => {
    restore(ctx);
    applyChosen();
    withhold();
  });

  // Branch navigation can move to a point with different choices.
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    applyChosen();
    withhold();
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    const available = new Set(pi.getAllTools().map((entry) => entry.name));
    const active = new Set(pi.getActiveTools());
    for (const name of defaultPixTools) if (available.has(name)) active.add(name);
    for (const [name, on] of Object.entries(overrides)) if (on && available.has(name)) active.add(name);
    for (const name of [...active]) {
      if (overrides[name] === true) continue;
      if (overrides[name] === false || isWithheld(name)) active.delete(name);
    }
    pi.setActiveTools([...active].filter((name) => process.platform === "win32" || name !== "powershell"));
  });

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
