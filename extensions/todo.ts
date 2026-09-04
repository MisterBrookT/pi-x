import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "active" | "done";
interface Item { id: string; text: string; status: Status; parentId?: string }
interface State { items: Item[]; nextId: number }
interface Details extends State { action: string; error?: string }

export const fitTodoWidgetLines = (lines: string[], width: number): string[] =>
  lines.map(line => truncateToWidth(line, width, ""));

const Params = Type.Object({
  action: StringEnum(["list", "add", "set", "clear"] as const),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.String({ description: "Todo ID, such as 1 or 1.2" })),
  parentId: Type.Optional(Type.String({ description: "Top-level parent ID when adding a nested todo" })),
  status: Type.Optional(StringEnum(["pending", "active", "done"] as const)),
});

export default function (pi: ExtensionAPI) {
  let state: State = { items: [], nextId: 1 };
  let enabled = true;
  const restore = (ctx: ExtensionContext) => {
    state = { items: [], nextId: 1 };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue;
      const d = entry.message.details as Details | undefined;
      if (d) state = {
        items: d.items.map(item => ({ ...item, id: String(item.id), ...(item.parentId === undefined ? {} : { parentId: String(item.parentId) }) })),
        nextId: d.nextId,
      };
    }
    renderWidget(ctx);
  };
  const renderWidget = (ctx: ExtensionContext) => {
    if (!enabled) return ctx.ui.setWidget("pix-todo", undefined);
    const open = state.items.filter(i => i.status !== "done");
    if (!open.length) return ctx.ui.setWidget("pix-todo", undefined);
    ctx.ui.setWidget("pix-todo", (_tui, theme) => {
      const lines = open.slice(0, 6).map(item => {
        const marker = theme.fg("accent", item.status === "active" ? "›" : "○");
        const indent = item.parentId ? "  " : "";
        return `${indent}${marker} ${theme.fg("accent", `#${item.id}`)} ${theme.fg("text", item.text)}`;
      });
      return {
        render: (width: number) => fitTodoWidgetLines(lines, width),
        invalidate() {},
      };
    });
  };
  const result = (action: string, text: string, error?: string): { content: [{type:"text";text:string}]; details: Details; isError?: boolean } => ({
    content: [{ type: "text", text }], details: { action, items: structuredClone(state.items), nextId: state.nextId, error }, ...(error ? { isError: true } : {})
  });
  pi.on("session_start", (_e, ctx) => { enabled = true; restore(ctx); });
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Track non-trivial multi-step work. Skip trivial tasks. Actions: list, add (optionally under a top-level parentId), set status, clear. Supports two levels such as 1 and 1.1.",
    promptSnippet: "Track pending, active, and completed steps for non-trivial work",
    promptGuidelines: [
      "Use todo for non-trivial multi-step work; keep statuses current.",
    ],
    parameters: Params,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { id?: unknown; parentId?: unknown };
      return {
        ...input,
        ...(typeof input.id === "number" ? { id: String(input.id) } : {}),
        ...(typeof input.parentId === "number" ? { parentId: String(input.parentId) } : {}),
      };
    },
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "list") return result("list", state.items.length ? state.items.map(i => `${i.parentId ? "  " : ""}[${i.status}] #${i.id} ${i.text}`).join("\n") : "No todos");
      if (p.action === "add") {
        if (!p.text?.trim()) return result("add", "text is required", "text is required");
        let id: string;
        if (p.parentId) {
          const parent = state.items.find(i => i.id === p.parentId && !i.parentId);
          if (!parent) return result("add", "parentId must identify a top-level todo", "parentId must identify a top-level todo");
          const nextChild = state.items.filter(i => i.parentId === parent.id).length + 1;
          id = `${parent.id}.${nextChild}`;
        } else {
          id = String(state.nextId++);
        }
        const item: Item = { id, text: p.text.trim(), status: "pending", ...(p.parentId ? { parentId: p.parentId } : {}) };
        state.items.push(item); renderWidget(ctx); return result("add", `Added #${item.id}`);
      }
      if (p.action === "set") { const item=state.items.find(i=>i.id===p.id); if (!item || !p.status) return result("set", "valid id and status are required", "valid id and status are required"); item.status=p.status; renderWidget(ctx); return result("set", `#${item.id} → ${item.status}`); }
      state={items:[],nextId:1}; renderWidget(ctx); return result("clear", "Todos cleared");
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(`todo ${args.action}`)),0,0); },
    renderResult(r, _o, theme) { const t=r.content[0]; return new Text(theme.fg(r.isError?"error":"muted",t?.type==="text"?t.text:""),0,0); }
  });
  pi.registerCommand("todo", {
    description: "Show or toggle todo tracking: /todo [on|off]",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "on", label: "on", description: "Enable todo tracking" },
        { value: "off", label: "off", description: "Disable todo tracking" },
      ].filter(option => option.value.startsWith(prefix));
      return options.length ? options : null;
    },
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();
      if (action === "on" || action === "off") {
        enabled = action === "on";
        const active = new Set(pi.getActiveTools());
        if (enabled) active.add("todo"); else active.delete("todo");
        pi.setActiveTools([...active]);
        renderWidget(ctx);
        ctx.ui.notify(`todo ${action}`, "info");
        return;
      }
      if (action) {
        ctx.ui.notify("Usage: /todo [on|off]", "error");
        return;
      }
      const lines = state.items.length ? state.items.map(i => `[${i.status}] #${i.id} ${i.text}`) : ["No todos"];
      ctx.ui.notify(`${enabled ? "todo is on" : "todo is off"}\n${lines.join("\n")}`, "info");
    },
  });
}
