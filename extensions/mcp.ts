import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter, type McpAdapterOptions } from "../vendor/mcp/index.ts";
import { discoveredTools, MCP_TOOL_NAMES } from "../src/tool-discovery.ts";
import { selectedTools, toolSettings, type ToolSettings } from "../src/tool-settings.ts";

/** Pix owns policy; the vendored engine retains transports, auth, and configuration. */
export function registerMcp(pi: ExtensionAPI, settings: ToolSettings = toolSettings(), options: McpAdapterOptions = {}) {
  const owned = new Set<string>();
  let ready = false;
  const searching = new AsyncLocalStorage<boolean>();
  let reportError = (_message: string) => {};
  pi.events.on(MCP_TOOL_NAMES, data => {
    if (data && typeof data === "object") (data as { names?: ReadonlySet<string> }).names = owned;
  });
  const select = (requested: string[]) => {
    const overrides = settings.read();
    const loaded = discoveredTools(pi);
    // Preserve search-mode discovery without treating concurrent startup or
    // background refresh as a user request to activate tools.
    if (searching.getStore()) for (const name of requested) {
      if (name !== "mcp" && name !== "mcpScript" && owned.has(name) && overrides[name] !== false && overrides.mcp !== false) loaded.add(name);
    }
    return selectedTools(pi.getAllTools().map(tool => tool.name), requested, overrides, loaded, owned);
  };
  const sync = () => { if (ready) pi.setActiveTools(select(pi.getActiveTools())); };
  const api = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "setActiveTools") return (names: string[]) => target.setActiveTools(select(names));
      if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        owned.add(tool.name);
        const metadata = tool.name === "mcp" ? {
          description: "Access MCP server tools. Search for tools, inspect their input schemas, or call a tool with arguments. Also supports server status, installation, and authentication.",
          promptSnippet: "Search and call MCP server tools",
        } : tool.name === "mcpScript" ? {
          description: "Run JavaScript that combines MCP tool calls. await tools.search({query}) returns {items, total, hasMore, nextOffset}; await tools.describe({path}) returns a descriptor or {path, error}. await tools.call(path, args) returns {ok: true, data} or {ok: false, error}. Use emit(value) for output.",
          promptSnippet: "Run scripts that combine MCP tool calls",
        } : {};
        target.registerTool({ ...tool, ...metadata, execute(...args) {
          const explicitSearch = tool.name === "mcp" && typeof args[1]?.search === "string";
          return searching.run(explicitSearch, () => tool.execute(...args));
        } });
        // Dynamic registrations may happen after the startup policy pass.
        queueMicrotask(() => {
          try { sync(); }
          catch (error) {
            pi.setActiveTools(pi.getActiveTools().filter(name => !owned.has(name)));
            reportError(`MCP activation blocked: ${String(error)}`);
          }
        });
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  createMcpAdapter(options)(api);
  pi.on("session_start", (_event, ctx) => {
    reportError = message => ctx.ui.notify(message, "error");
    ready = true;
    sync();
  });
  pi.on("before_agent_start", sync);
  pi.on("session_shutdown", () => { ready = false; searching.disable(); });
}

export default function mcp(pi: ExtensionAPI) { registerMcp(pi); }
