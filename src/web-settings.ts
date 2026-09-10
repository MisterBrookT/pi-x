import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESOLVED_SEARCH_PROVIDERS } from "../node_modules/pi-web-access/gemini-search.ts";
import { getWebSearchConfigPath, normalizeProxyUrl } from "../node_modules/pi-web-access/utils.ts";

export const webProviders = [...RESOLVED_SEARCH_PROVIDERS];
type Config = Record<string, any>;

export function readWebSettings(path = getWebSearchConfigPath()): Config {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Web settings must be a JSON object");
  return config;
}

/** Read-modify-write preserves credentials and settings owned by upstream. */
export function updateWebSettings(change: (config: Config) => void, path = getWebSearchConfigPath()): void {
  const config = readWebSettings(path);
  change(config);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch {} }
}

export function setSearchSource(config: Config, provider: string): void {
  if (provider !== "auto" && !webProviders.includes(provider as any)) throw new Error("Unknown search provider");
  delete config.searchProvider;
  delete config.searchRouting;
  if (provider === "auto") delete config.provider;
  else config.provider = provider;
}

export function setSearchFallback(config: Config, input: string): void {
  const providers = input.split(",").map(p => p.trim()).filter(Boolean);
  if (!providers.length || new Set(providers).size !== providers.length || providers.some(p => !webProviders.includes(p as any))) {
    throw new Error("Enter distinct provider IDs separated by commas (no auto or all).");
  }
  delete config.provider;
  delete config.searchProvider;
  config.searchRouting = { providers, fallbackOn: ["transient", "quota", "network", "invalid-response", "unsupported"] };
}

const keyFields: Record<string, string> = { search1api: "search1apiApiKey", searchinfinity: "searchinfinityApiKey" };
export function providerHint(provider: string, config: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (["exa", "parallel-mcp", "duckduckgo", "anysearch"].includes(provider)) return "keyless option";
  if (provider === "openai") return "OpenAI/Codex login or API key; endpoint must support web search";
  if (provider === "kimi") return "requires Kimi Code login";
  if (provider === "searxng") return config.searxngBaseUrl || env.SEARXNG_BASE_URL ? "endpoint configured (untested)" : "requires SearXNG endpoint";
  const field = keyFields[provider] ?? `${provider}ApiKey`;
  const envKey = provider === "search1api" ? "SEARCH1API_KEY" : `${provider.toUpperCase()}_API_KEY`;
  return config[field] || env[envKey] ? "credential configured (untested)" : "requires API key / upstream setup";
}

export type WebProbe = (kind: "search" | "fetch", ctx: ExtensionContext) => Promise<string>;

/** Standard Pi dialogs also work over RPC; no extra commands or model arguments. */
export async function configureWeb(ctx: ExtensionContext, probe: WebProbe, path = getWebSearchConfigPath()): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("Web configuration requires an interactive UI.", "error"); return; }
  let changed = false;
  while (true) {
    try {
      const config = readWebSettings(path);
      const source = config.searchProvider ?? config.provider ?? config.searchRouting?.providers?.join(" → ") ?? "auto";
      const selection = await ctx.ui.select(`Web · search: ${Array.isArray(source) ? source.join(" + ") : source}${changed ? " · reload pending" : ""}`, ["Search source", "Test connection", "Advanced"]);
      if (!selection) return;
      if (selection === "Search source") {
        const ordered = [...webProviders].sort((a, b) => Number(!providerHint(a, config).includes("configured")) - Number(!providerHint(b, config).includes("configured")));
        const labels = ["auto · upstream automatic selection", ...ordered.map(p => `${p} · ${providerHint(p, config)}`)];
        const chosen = await ctx.ui.select("Search source · selecting may incur provider charges", labels);
        if (!chosen) continue;
        const provider = labels.indexOf(chosen) === 0 ? "auto" : ordered[labels.indexOf(chosen) - 1];
        updateWebSettings(c => setSearchSource(c, provider), path);
      } else if (selection === "Test connection") {
        if (changed) { ctx.ui.notify("Run /reload before testing the saved settings; upstream caches configuration.", "warning"); continue; }
        const kind = await ctx.ui.select("Test separately · sends a real request (search may incur charges)", ["Search: example domain", "Fetch: https://example.com"]);
        if (!kind) continue;
        ctx.ui.notify("Testing web connection…", "info");
        ctx.ui.notify(await probe(kind.startsWith("Search") ? "search" : "fetch", ctx), "info");
        continue;
      } else {
        const field = await ctx.ui.select("Advanced · page fetching is separate from search", ["Fallback order", "Proxy", "Interactive review", "Setup help"]);
        if (!field) continue;
        if (field === "Setup help") {
          ctx.ui.notify(`Provider credentials and endpoints: ${path}. Use upstream pi-web-access configuration (API keys may reference $ENV_VAR). Fake-IP DNS blocks are separate from search provider failures; network protections are not relaxed by this panel.`, "info");
          continue;
        }
        if (field === "Fallback order") {
          const input = await ctx.ui.input("Ordered provider IDs · replaces single source; only listed failures fall back", "exa, duckduckgo");
          if (input === undefined) continue;
          updateWebSettings(c => setSearchFallback(c, input), path);
        } else if (field === "Proxy") {
          const mode = await ctx.ui.select("HTTP(S) transport proxy · does not bypass network safety checks", ["Default (remove override)", "Direct", "Set URL"]);
          if (!mode) continue;
          let proxy: string | undefined;
          if (mode === "Set URL") {
            proxy = await ctx.ui.input("HTTP(S) proxy URL · stored in web-search.json", "http://127.0.0.1:7890");
            if (proxy === undefined) continue;
            if (!proxy.trim()) throw new Error("Enter a proxy URL or choose Direct.");
            normalizeProxyUrl(proxy, "proxy");
          }
          updateWebSettings(c => { if (mode.startsWith("Default")) delete c.proxy; else c.proxy = mode === "Direct" ? "" : proxy; }, path);
        } else {
          const workflow = await ctx.ui.select("Search results · interactive review opens a browser; summaries may use a model", ["none", "summary-review", "auto-summary"]);
          if (!workflow) continue;
          updateWebSettings(c => { c.workflow = workflow; }, path);
        }
      }
      changed = true;
      ctx.ui.notify(`Saved in ${path}. Run /reload to apply before searching or testing.`, "info");
    } catch (error) {
      ctx.ui.notify(`Web configuration: ${(error as Error).message}`, "error");
      // A malformed file must not trap the user in a retry loop.
      return;
    }
  }
}
