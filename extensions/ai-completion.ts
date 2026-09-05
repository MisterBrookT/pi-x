import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AiCompletion, type Completer, type CompletionConfig, type CompletionModelRef, type ConversationTurn } from "../src/ai-completion.ts";

const configPath = process.env.PIX_COMPLETE_CONFIG ?? join(homedir(), ".pi/agent/pix-complete.json");
const defaultModel: CompletionModelRef = { provider: "pix-anthropic", id: "claude-haiku-4-5" };

async function loadConfig(): Promise<CompletionConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<CompletionConfig>;
    const model = parsed.model && typeof parsed.model.provider === "string" && typeof parsed.model.id === "string" ? parsed.model : undefined;
    return { enabled: parsed.enabled === true, model };
  } catch {
    return { enabled: false };
  }
}

async function saveConfig(config: CompletionConfig): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map(part => part.text)
    .join("\n")
    .trim();
}

export function conversationTurns(ctx: Pick<ExtensionContext, "sessionManager">): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const { role } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(entry.message.content);
    if (text) turns.push({ role, text });
  }
  return turns;
}

export interface CompletionService {
  completion: AiCompletion;
  isEnabled(): boolean;
}

/**
 * Registers `/complete` and returns the shared AI completion the editor consults.
 * Completion requests use the configured small model through Pi's model registry,
 * so credentials and providers such as pix-anthropic are reused unchanged.
 */
export default function registerAiCompletion(pi: ExtensionAPI): CompletionService {
  let config: CompletionConfig = { enabled: false };
  let context: ExtensionContext | undefined;

  const resolveModel = (ctx: ExtensionContext) => {
    const ref = config.model ?? defaultModel;
    const model = ctx.modelRegistry.find(ref.provider, ref.id);
    return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
  };

  const complete: Completer = async (prompt, signal) => {
    if (!context) throw new Error("no session");
    const model = resolveModel(context);
    if (!model) throw new Error("completion model unavailable");
    const message = await context.modelRegistry.complete(model, {
      systemPrompt: prompt.system,
      messages: [{ role: "user", content: [{ type: "text", text: prompt.user }], timestamp: Date.now() }],
    }, { signal, maxTokens: 120, temperature: 0.2, cacheRetention: "none" } as never);
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? message.stopReason);
    return messageText(message.content);
  };

  const completion = new AiCompletion(complete);
  const refresh = (ctx: ExtensionContext) => completion.setConversation(conversationTurns(ctx));

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    config = await loadConfig();
    refresh(ctx);
  });
  pi.on("session_tree", (_event, ctx) => refresh(ctx));
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "user") refresh(ctx);
  });

  pi.registerCommand("complete", {
    description: "AI inline completion: /complete [on|off|model|status]",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "on", label: "on", description: "Enable AI inline completion" },
        { value: "off", label: "off", description: "Disable AI inline completion" },
        { value: "model", label: "model", description: "Choose the completion model" },
        { value: "status", label: "status", description: "Show completion status" },
      ].filter(option => option.value.startsWith(prefix));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && !["on", "off", "model", "status"].includes(action)) {
        ctx.ui.notify("Usage: /complete [on|off|model|status]", "error");
        return;
      }
      if (action === "model") {
        if (!ctx.hasUI) return ctx.ui.notify("/complete model requires the interactive terminal", "error");
        const available = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
        const choice = await ctx.ui.select("Completion model", [...new Set(available.map(model => `${model.provider}/${model.id}`))]);
        if (!choice) return;
        const slash = choice.indexOf("/");
        config = { ...config, model: { provider: choice.slice(0, slash), id: choice.slice(slash + 1) } };
        completion.setConversation(conversationTurns(ctx));
      } else if (action !== "status") {
        config = { ...config, enabled: action === "on" || (!action && !config.enabled) };
      }
      if (action !== "status") {
        try { await saveConfig(config); }
        catch (error) {
          ctx.ui.notify(`Completion changed for this session but could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
      const ref = config.model ?? defaultModel;
      const model = resolveModel(ctx);
      const detail = model ? `${ref.provider}/${ref.id}` : `${ref.provider}/${ref.id} is unavailable; log in or run /complete model`;
      ctx.ui.notify(`AI completion is ${config.enabled ? "on" : "off"} (${detail})`, config.enabled && !model ? "warning" : "info");
    },
  });

  return { completion, isEnabled: () => config.enabled && context !== undefined && resolveModel(context) !== undefined };
}
