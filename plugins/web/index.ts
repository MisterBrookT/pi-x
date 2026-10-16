// Web search and page fetching: web_search / fetch_content, and "configure" in the tool panel.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCapabilityAction } from "../core/capability-actions.ts";
import { withPixToolGuidance } from "../core/tool-guidance.ts";
import { withSpecialistExposure } from "../core/tool-discovery.ts";
import { configureWeb } from "./web-settings.ts";
import { readWebConfig } from "./config.ts";
import { registerWebTools } from "./tools.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export default function (pi: ExtensionAPI) {
  // Settings are read per call, so a saved change applies without /reload.
  const webTools = new Map<string, RegisteredTool>();
  registerWebTools(new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return (tool: RegisteredTool) => {
        webTools.set(tool.name, tool);
        target.registerTool(withSpecialistExposure(withPixToolGuidance(tool)));
      };
      return Reflect.get(target, property, receiver);
    },
  }) as ExtensionAPI, () => readWebConfig());
  registerCapabilityAction(pi, "web", {
    verb: "configure",
    description: "Test web access and configure fetching limits",
    shortcut: "c",
    run: ctx => configureWeb(ctx, async (kind, context) => {
      const name = kind === "search" ? "web_search" : "fetch_content";
      const tool = webTools.get(name);
      if (!tool) throw new Error(`${name} is not registered`);
      const args = kind === "search"
        ? { query: "example domain", numResults: 1 }
        : { url: "https://example.com", mode: "readable" };
      const result = await tool.execute(`web-test-${Date.now()}`, args, AbortSignal.timeout(30000), undefined, context);
      const details = result.details as { error?: string; successful?: number } | undefined;
      if (details?.error || details?.successful === 0) throw new Error(`${kind}: ${details.error ?? "No successful results"}`);
      const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      return `${kind} test result:\n${text.slice(0, 1500)}`;
    }),
  });
}
