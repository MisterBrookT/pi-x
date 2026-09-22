import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWebConfigPath, normalizeProxyUrl } from "./web/config.ts";

export { getWebConfigPath as getWebSearchConfigPath, normalizeProxyUrl };

type Config = Record<string, any>;

export function readWebSettings(path = getWebConfigPath()): Config {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Web settings must be a JSON object");
  return config;
}

/** Read-modify-write so unrelated keys and credentials survive an edit. */
export function updateWebSettings(change: (config: Config) => void, path = getWebConfigPath()): void {
  const config = readWebSettings(path);
  change(config);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch {} }
}

/** Every CIDR is validated before it can widen the network guard. */
export function setAllowRanges(config: Config, input: string): void {
  const ranges = input.split(",").map(r => r.trim()).filter(Boolean);
  if (ranges.length === 0) { delete config.ssrf; return; }
  config.ssrf = { ...config.ssrf, allowRanges: ranges };
}

export function setMaxInlineChars(config: Config, input: string): void {
  const value = Number(input.trim());
  if (!Number.isFinite(value) || value < 1000) throw new Error("Enter a character limit of at least 1000.");
  config.maxInlineContentChars = Math.floor(value);
}

export type WebProbe = (kind: "search" | "fetch", ctx: ExtensionContext) => Promise<string>;

/** Standard Pi dialogs also work over RPC; no extra commands or model arguments. */
export async function configureWeb(ctx: ExtensionContext, probe: WebProbe, path = getWebConfigPath()): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("Web configuration requires an interactive UI.", "error"); return; }
  while (true) {
    try {
      const config = readWebSettings(path);
      const key = config.openaiApiKey ? "API key" : "Pi login";
      const selection = await ctx.ui.select(`Web · search via OpenAI (${key})`, ["Test connection", "Page size limit", "Allowed private ranges", "Proxy", "Setup help"]);
      if (!selection) return;
      if (selection === "Test connection") {
        const kind = await ctx.ui.select("Test separately · sends a real request (search may incur charges)", ["Search: example domain", "Fetch: https://example.com"]);
        if (!kind) continue;
        ctx.ui.notify("Testing web connection…", "info");
        ctx.ui.notify(await probe(kind.startsWith("Search") ? "search" : "fetch", ctx), "info");
        continue;
      }
      if (selection === "Setup help") {
        ctx.ui.notify(`Search uses your Pi OpenAI or Codex login; no separate key is needed. Settings live in ${path}. Set openaiApiKey there to use an API key instead.`, "info");
        continue;
      }
      if (selection === "Page size limit") {
        const input = await ctx.ui.input("Characters returned inline before content is stored for get_search_content", "25000");
        if (input === undefined) continue;
        updateWebSettings(c => setMaxInlineChars(c, input), path);
      } else if (selection === "Allowed private ranges") {
        ctx.ui.notify("Private and loopback addresses are blocked by default. Only add a range you control, such as a TUN/fake-IP proxy range.", "warning");
        const input = await ctx.ui.input("CIDR ranges exempt from the network guard · empty removes the exemption", "198.18.0.0/15");
        if (input === undefined) continue;
        updateWebSettings(c => setAllowRanges(c, input), path);
      } else {
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
      }
      ctx.ui.notify(`Saved in ${path}.`, "info");
    } catch (error) {
      ctx.ui.notify(`Web configuration: ${(error as Error).message}`, "error");
      // A malformed file must not trap the user in a retry loop.
      return;
    }
  }
}
