import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { subagentRoles, subagentRoleGuidance } from "./subagent-policy.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
export const simpleSubagentParameters = Type.Object({
  action: Type.Union(["start", "status", "steer", "stop"].map(value => Type.Literal(value))),
  tasks: Type.Optional(Type.Array(Type.Object({
    agent: Type.Union(subagentRoles.map(role => Type.Literal(role))),
    task: Type.String({ minLength: 1, description: "Task and relevant context." }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8,
    description: "For start: one task, or independent tasks to run in parallel. Available roles: worker and scout." })),
  worktree: Type.Optional(Type.Boolean({ description: "For start: isolate tasks in git worktrees (requires a clean working tree). Defaults to false." })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "For start: fresh task-only context (default), or fork the parent conversation when needed." })),
  id: Type.Optional(Type.String({ minLength: 1, description: "Run ID returned by start. Required for steer/stop; omit for status to list runs." })),
  message: Type.Optional(Type.String({ minLength: 1, description: "New guidance for steer." })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Optional zero-based child index for status or steer within a parallel run." })),
}, { additionalProperties: false });

export const simpleSubagentDescription = `Delegate tasks to configured agents.
${subagentRoleGuidance}
Up to four tasks run concurrently. Default: fresh context and shared cwd (including uncommitted changes). Choose context:fork only when conversation history is needed; set worktree:true for isolation (requires a clean git tree). never overlap writers in a shared cwd; worktree changes are NOT merged automatically. Role permissions remain configured, not granted by delegation.
Completion notifies this session; delegation does not grant permission. Stop and steer do not undo work already done.`;

/** Translate a small public contract into the upstream executor's existing API. */
export function subagentRequest(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["action", "tasks", "worktree", "context", "id", "message", "index"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported subagent field: ${key}`);
  const { action, tasks, worktree, context, id, message, index } = input;
  if (index !== undefined && (!Number.isInteger(index) || (index as number) < 0)) throw new Error("index must be a nonnegative integer");
  if (action === "start") {
    if (id !== undefined || message !== undefined || index !== undefined) throw new Error("start accepts only tasks, worktree, and context");
    if (worktree !== undefined && typeof worktree !== "boolean") throw new Error("worktree must be a boolean");
    if (context !== undefined && context !== "fresh" && context !== "fork") throw new Error("context must be fresh or fork");
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 8) throw new Error("start requires 1–8 tasks");
    const children = tasks.map((task, i) => {
      if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some(k => k !== "agent" && k !== "task")) throw new Error("Each task accepts only agent and task");
      if (typeof task.agent !== "string" || !task.agent.trim() || typeof task.task !== "string" || !task.task.trim()) throw new Error("Each task requires nonempty agent and task");
      if (!subagentRoles.some(role => role === task.agent)) throw new Error("Available subagent roles: worker and scout");
      return { key: `task-${i + 1}`, agent: task.agent, task: task.task };
    });
    if (children.length === 1) return { agent: children[0].agent, task: children[0].task, async: true, context: context ?? "fresh", ...(worktree === undefined ? {} : { worktree }) };
    // JSON serialization is deliberate: task text is data, never executable code.
    return { workflowScript: `return await runs.all(${JSON.stringify(children)});`, async: true,
      context: context ?? "fresh", ...(worktree === undefined ? {} : { worktree }), globalConcurrencyLimit: 4, maxSubagentSpawnsPerRun: 8 };
  }
  if (!["status", "steer", "stop"].includes(action as string)) throw new Error("Use start, status, steer, or stop");
  if (tasks !== undefined || worktree !== undefined || context !== undefined) throw new Error("tasks, worktree, and context are only valid for start");
  if (id !== undefined && (typeof id !== "string" || !id.trim())) throw new Error("id must be nonempty");
  if (action !== "status" && !id) throw new Error(`${action} requires a run id`);
  if (action === "steer") {
    if (typeof message !== "string" || !message.trim()) throw new Error("steer requires a message");
    return { action: "steer", id, message, ...(index === undefined ? {} : { index }) };
  }
  if (message !== undefined) throw new Error("message is only valid for steer");
  if (action === "stop") {
    if (index !== undefined) throw new Error("stop interrupts the whole run; omit index");
    return { action: "interrupt", id };
  }
  if (!id && index !== undefined) throw new Error("status index requires a run id");
  return id ? { action: "status", id, view: "transcript", ...(index === undefined ? {} : { index }) } : { action: "status", view: "fleet" };
}

export function simplifySubagent(tool: Tool): Tool {
  return {
    ...tool,
    parameters: simpleSubagentParameters,
    description: simpleSubagentDescription,
    promptSnippet: "Delegate tasks to other agents",
    promptGuidelines: ["Use subagents when delegation or parallel work would help."],
    // Old normalizers/renderers expect the old schema. Keep result rendering,
    // but use Pi's generic call rendering for the new arguments.
    prepareArguments: undefined,
    renderCall: undefined,
    async execute(callId, params, signal, update, ctx) {
      return tool.execute(callId, subagentRequest(params), signal, update, ctx);
    },
  };
}
