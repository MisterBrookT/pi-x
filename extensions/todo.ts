import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "active" | "done";
interface Item { id: string; text: string; status: Status; parentId?: string; dependsOn?: string[] }
interface State { items: Item[]; nextId: number }
interface Details extends State { action: string; error?: string }

export const fitTodoWidgetLines = (lines: string[], width: number): string[] =>
  lines.map(line => truncateToWidth(line, width, ""));

export const unmetTodoDependencies = (item: Item, items: Item[]): string[] =>
  (item.dependsOn ?? []).filter(id => items.find(candidate => candidate.id === id)?.status !== "done");

export const hasTodoDependencyCycle = (items: Item[]): boolean => {
  const dependencies = new Map(items.map(item => [item.id, item.dependsOn ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (dependencies.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return items.some(item => visit(item.id));
};

const formatItem = (item: Item, items: Item[]): string => {
  const unmet = unmetTodoDependencies(item, items);
  const status = item.status === "pending" && unmet.length ? `blocked: ${unmet.map(id => `#${id}`).join(", ")}` : item.status;
  const dependencies = item.dependsOn?.length ? ` (depends on ${item.dependsOn.map(id => `#${id}`).join(", ")})` : "";
  return `${item.parentId ? "  " : ""}[${status}] #${item.id} ${item.text}${dependencies}`;
};

const itemFields = {
  parentId: Type.Optional(Type.String({ description: "Top-level parent ID; parents must appear before children" })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Todo IDs that must be done before this item can start" })),
};

const Params = Type.Object({
  action: StringEnum(["list", "add", "replace", "set", "clear"] as const),
  items: Type.Optional(Type.Array(Type.Object({ text: Type.String(), ...itemFields }), {
    minItems: 1,
    description: "For replace: the entire new plan, all pending. IDs restart at 1; children use 1.1, 1.2, etc. Dependencies may reference later items in this array. Replaces all existing todos atomically.",
  })),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.String({ description: "Todo ID, such as 1 or 1.2" })),
  ...itemFields,
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
        items: d.items.map(item => ({
          ...item,
          id: String(item.id),
          ...(item.parentId === undefined ? {} : { parentId: String(item.parentId) }),
          ...(item.dependsOn === undefined ? {} : { dependsOn: item.dependsOn.map(String) }),
        })),
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
        const unmet = unmetTodoDependencies(item, state.items);
        const marker = theme.fg("accent", item.status === "active" ? "›" : unmet.length ? "×" : "○");
        const indent = item.parentId ? "  " : "";
        const waiting = unmet.length ? theme.fg("muted", ` ← ${unmet.map(id => `#${id}`).join(", ")}`) : "";
        return `${indent}${marker} ${theme.fg("accent", `#${item.id}`)} ${theme.fg("text", item.text)}${waiting}`;
      });
      return {
        render: (width: number) => fitTodoWidgetLines(lines, width),
        invalidate() {},
      };
    });
  };
  const result = (action: string, text: string, error?: string): { content: [{type:"text";text:string}]; details: Details } => {
    // Pi marks thrown errors as failed tool calls; returning isError is not sufficient.
    if (error) throw new Error(error);
    return { content: [{ type: "text", text }], details: { action, items: structuredClone(state.items), nextId: state.nextId } };
  };
  pi.on("session_start", (_e, ctx) => { enabled = true; restore(ctx); });
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Track non-trivial work. Prefer replace(items) to create a whole plan in one call (replaces existing todos, resets IDs and statuses); add(text) appends one item, set(id,status) updates progress, list/clear inspect/reset. Optional parentId groups subtasks; dependsOn controls readiness, not automatic execution. Independent ready items may be delegated in parallel. Reset active/done dependents to pending before reopening a prerequisite.",
    promptSnippet: "Track pending, active, and completed steps for non-trivial work",
    promptGuidelines: [
      "Use todo for non-trivial multi-step work; keep statuses current.",
    ],
    parameters: Params,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const normalize = (value: unknown): unknown => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const input = value as { id?: unknown; parentId?: unknown; dependsOn?: unknown };
        return {
          ...input,
          ...(typeof input.id === "number" ? { id: String(input.id) } : {}),
          ...(typeof input.parentId === "number" ? { parentId: String(input.parentId) } : {}),
          ...(Array.isArray(input.dependsOn) ? { dependsOn: input.dependsOn.map(id => typeof id === "number" ? String(id) : id) } : {}),
        };
      };
      const input = args as { items?: unknown };
      return {
        ...normalize(args) as object,
        ...(Array.isArray(input.items) ? { items: input.items.map(normalize) } : {}),
      };
    },
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "list") return result("list", state.items.length ? state.items.map(i => formatItem(i, state.items)).join("\n") : "No todos");
      if (p.action === "add" || p.action === "replace") {
        const inputs = p.action === "replace" ? p.items : [p];
        if (!inputs?.length) return result(p.action, "items is required and must not be empty", "items is required and must not be empty");
        // Stage the complete change so any invalid item leaves the old plan untouched.
        const next: State = p.action === "replace" ? { items: [], nextId: 1 } : structuredClone(state);
        for (const input of inputs) {
          if (!input.text?.trim()) return result(p.action, "text is required", "text is required");
          let id: string;
          if (input.parentId !== undefined) {
            const parent = next.items.find(i => i.id === input.parentId && !i.parentId);
            if (!parent) return result(p.action, "parentId must identify a top-level todo", "parentId must identify a top-level todo");
            id = `${parent.id}.${next.items.filter(i => i.parentId === parent.id).length + 1}`;
          } else {
            id = String(next.nextId++);
          }
          const dependsOn = [...new Set(input.dependsOn ?? [])];
          next.items.push({
            id, text: input.text.trim(), status: "pending",
            ...(input.parentId ? { parentId: input.parentId } : {}),
            ...(dependsOn.length ? { dependsOn } : {}),
          });
        }
        for (const item of next.items) {
          if (item.dependsOn?.includes(item.id)) return result(p.action, `#${item.id} cannot depend on itself`, `#${item.id} cannot depend on itself`);
          const missing = (item.dependsOn ?? []).filter(id => !next.items.some(candidate => candidate.id === id));
          if (missing.length) {
            const message = `unknown dependencies: ${missing.map(id => `#${id}`).join(", ")}`;
            return result(p.action, message, message);
          }
        }
        if (hasTodoDependencyCycle(next.items)) return result(p.action, "dependency cycle detected", "dependency cycle detected");
        state = next;
        renderWidget(ctx);
        return result(p.action, p.action === "replace"
          ? state.items.map(item => formatItem(item, state.items)).join("\n")
          : `Added #${state.items[state.items.length - 1].id}`);
      }
      if (p.action === "set") {
        const item = state.items.find(i => i.id === p.id);
        if (!item || !p.status) return result("set", "valid id and status are required", "valid id and status are required");
        const unmet = unmetTodoDependencies(item, state.items);
        if (p.status !== "pending" && unmet.length) {
          const message = `#${item.id} is blocked by ${unmet.map(id => `#${id}`).join(", ")}`;
          return result("set", message, message);
        }
        if (item.status === "done" && p.status !== "done") {
          const dependents = state.items.filter(candidate => candidate.status !== "pending" && candidate.dependsOn?.includes(item.id));
          if (dependents.length) {
            const message = `Reset dependents ${dependents.map(candidate => `#${candidate.id}`).join(", ")} to pending first before reopening #${item.id}`;
            return result("set", message, message);
          }
        }
        item.status = p.status; renderWidget(ctx); return result("set", `#${item.id} → ${item.status}`);
      }
      state={items:[],nextId:1}; renderWidget(ctx); return result("clear", "Todos cleared");
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(`todo ${args.action}`)),0,0); },
    renderResult(r, _o, theme, context) { const t=r.content[0]; return new Text(theme.fg(context.isError?"error":"muted",t?.type==="text"?t.text:""),0,0); }
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
      const lines = state.items.length ? state.items.map(i => formatItem(i, state.items)) : ["No todos"];
      ctx.ui.notify(`${enabled ? "todo is on" : "todo is off"}\n${lines.join("\n")}`, "info");
    },
  });
}
