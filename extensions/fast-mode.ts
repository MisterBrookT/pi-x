import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addAnthropicFastBeta, applyFastMode, clearFastModeFallbacks, consumeFastModeFallbackFeedback, fastModeActiveFor, fastModeTarget, isFastModeEnabled, setFastModeEnabled } from "../src/fast-mode.js";

const configPath = join(homedir(), ".pi/agent/pix-fast.json");
const targetLabels = { openai: "OpenAI priority", anthropic: "Anthropic fast", google: "Google priority" } as const;

async function loadPreference(): Promise<boolean> {
  try { return JSON.parse(await readFile(configPath, "utf8")).enabled === true; }
  catch { return false; }
}

async function savePreference(enabled: boolean): Promise<void> {
  await writeFile(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    clearFastModeFallbacks();
    setFastModeEnabled(await loadPreference());
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && consumeFastModeFallbackFeedback({ provider: event.message.provider, id: event.message.model })) {
      ctx.ui.notify("Anthropic rejected fast mode; retried successfully at normal speed", "warning");
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (fastModeActiveFor(ctx.model) && fastModeTarget(ctx.model) === "anthropic") addAnthropicFastBeta(event.headers);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastModeActiveFor(ctx.model)) return;
    const target = fastModeTarget(ctx.model);
    if (target) return applyFastMode(event.payload, target);
  });

  pi.on("model_select", (event, ctx) => {
    if (isFastModeEnabled() && fastModeTarget(event.model) === "anthropic" && !fastModeActiveFor(event.model)) {
      ctx.ui.notify(`${event.model.id} does not support Anthropic fast mode; using normal speed`, "warning");
    }
  });

  pi.registerCommand("fast", {
    description: "Toggle priority processing for supported models",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "on", label: "on", description: "Enable priority processing" },
        { value: "off", label: "off", description: "Disable priority processing" },
        { value: "status", label: "status", description: "Show current fast-mode status" },
      ].filter(option => option.value.startsWith(prefix));
      return options.length ? options : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "error");
        return;
      }

      const target = fastModeTarget(ctx.model);
      if ((action === "on" || (!action && !isFastModeEnabled())) && !target) {
        ctx.ui.notify("Fast mode is unavailable for the current provider", "warning");
        return;
      }

      if (action !== "status") {
        setFastModeEnabled(action === "on" || (!action && !isFastModeEnabled()));
        try { await savePreference(isFastModeEnabled()); }
        catch (error) {
          ctx.ui.notify(`Fast mode changed for this session but could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
      const state = isFastModeEnabled() ? "on" : "off";
      const fallback = state === "on" && target === "anthropic" && !fastModeActiveFor(ctx.model);
      const detail = fallback ? " (unsupported by this model; using normal speed)" : target ? ` (${targetLabels[target]})` : "";
      ctx.ui.notify(`Fast mode is ${state}${detail}`, fallback ? "warning" : "info");
    },
  });
}
