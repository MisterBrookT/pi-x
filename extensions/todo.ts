import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "active" | "done";
interface Item { id: number; text: string; status: Status }
interface State { items: Item[]; nextId: number }
interface Details extends State { action: string; error?: string }

const Params = Type.Object({
  action: StringEnum(["list", "add", "set", "clear"] as const),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.Number()),
  status: Type.Optional(StringEnum(["pending", "active", "done"] as const)),
});

export default function (pi: ExtensionAPI) {
  let state: State = { items: [], nextId: 1 };
  const restore = (ctx: ExtensionContext) => {
    state = { items: [], nextId: 1 };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") continue;
      const d = entry.message.details as Details | undefined;
      if (d) state = { items: d.items, nextId: d.nextId };
    }
    renderWidget(ctx);
  };
  const renderWidget = (ctx: ExtensionContext) => {
    const open = state.items.filter(i => i.status !== "done");
    if (!open.length) return ctx.ui.setWidget("pix-todo", undefined);
    ctx.ui.setWidget("pix-todo", open.slice(0, 6).map(i => `${i.status === "active" ? "›" : "○"} #${i.id} ${i.text}`));
  };
  const result = (action: string, text: string, error?: string): { content: [{type:"text";text:string}]; details: Details; isError?: boolean } => ({
    content: [{ type: "text", text }], details: { action, items: structuredClone(state.items), nextId: state.nextId, error }, ...(error ? { isError: true } : {})
  });
  pi.on("session_start", (_e, ctx) => restore(ctx));
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Track non-trivial multi-step work. Skip trivial tasks. Actions: list, add, set status, clear.",
    promptSnippet: "Track pending, active, and completed steps for non-trivial work",
    promptGuidelines: [
      "Use todo for non-trivial multi-step work; keep statuses current.",
    ],
    parameters: Params,
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "list") return result("list", state.items.length ? state.items.map(i => `[${i.status}] #${i.id} ${i.text}`).join("\n") : "No todos");
      if (p.action === "add") { if (!p.text?.trim()) return result("add", "text is required", "text is required"); const item={id:state.nextId++,text:p.text.trim(),status:"pending" as Status}; state.items.push(item); renderWidget(ctx); return result("add", `Added #${item.id}`); }
      if (p.action === "set") { const item=state.items.find(i=>i.id===p.id); if (!item || !p.status) return result("set", "valid id and status are required", "valid id and status are required"); item.status=p.status; renderWidget(ctx); return result("set", `#${item.id} → ${item.status}`); }
      state={items:[],nextId:1}; renderWidget(ctx); return result("clear", "Todos cleared");
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(`todo ${args.action}`)),0,0); },
    renderResult(r, _o, theme) { const t=r.content[0]; return new Text(theme.fg(r.isError?"error":"muted",t?.type==="text"?t.text:""),0,0); }
  });
  pi.registerCommand("todo", { description: "Show the current Pix todo list", handler: async (_args, ctx) => { const lines=state.items.length?state.items.map(i=>`[${i.status}] #${i.id} ${i.text}`):["No todos"]; ctx.ui.notify(lines.join("\n"),"info"); } });
}
