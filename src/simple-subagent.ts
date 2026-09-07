import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const text = () => Type.String({ minLength: 1 });
export const simpleSubagentParameters = Type.Object({
  action: Type.Union(["start", "status", "steer", "stop"].map(value => Type.Literal(value))),
  tasks: Type.Optional(Type.Array(Type.Object({
    agent: text(),
    task: text(),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 8,
    description: "For start: one task, or independent tasks to run in parallel. Agent names: worker, scout, reviewer, researcher (or a configured agent)." })),
  id: Type.Optional(Type.String({ minLength: 1, description: "Run ID returned by start. Required for steer/stop; omit for status to list runs." })),
  message: Type.Optional(Type.String({ minLength: 1, description: "New guidance for steer." })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Optional zero-based child index for status or steer within a parallel run." })),
}, { additionalProperties: false });

export const simpleSubagentDescription = `Delegate independent tasks to configured agents. Actions: start, status, steer, stop.
Start accepts tasks:[{agent,task}]; multiple tasks run in parallel (at most four concurrently, eight total). Parallel children use separate git worktrees; this requires a git repository. Their changes are NOT automatically merged: inspect returned artifacts and integrate reviewed changes yourself. A single task uses the current directory; never overlap writers there.
Runs are asynchronous and notify this session when finished. Continue independent work or return control; do not poll or sleep merely to wait. Read results before starting dependent work. Use status with the returned run ID for progress/output, optionally index for one child; without ID it lists runs. Steer sends guidance to a live run (index selects a child); stop interrupts the run. These do not undo changes already made.
Give each task enough context and a concrete deliverable. Agent models, permissions, budgets and review rules come from configuration, not tool arguments. Keep safety and confirmation requirements in delegated tasks; delegation does not grant permission. Use the main assistant and todo for sequencing: start A and B, consume both results, then start C. No scripting, scheduling or administrative actions are exposed here.`;

/** Translate a small public contract into the upstream executor's existing API. */
export function subagentRequest(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(["action", "tasks", "id", "message", "index"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported subagent field: ${key}`);
  const { action, tasks, id, message, index } = input;
  if (index !== undefined && (!Number.isInteger(index) || (index as number) < 0)) throw new Error("index must be a nonnegative integer");
  if (action === "start") {
    if (id !== undefined || message !== undefined || index !== undefined) throw new Error("start accepts only tasks");
    if (!Array.isArray(tasks) || !tasks.length || tasks.length > 8) throw new Error("start requires 1–8 tasks");
    const children = tasks.map((task, i) => {
      if (!task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some(k => k !== "agent" && k !== "task")) throw new Error("Each task accepts only agent and task");
      if (typeof task.agent !== "string" || !task.agent.trim() || typeof task.task !== "string" || !task.task.trim()) throw new Error("Each task requires nonempty agent and task");
      return { key: `task-${i + 1}`, agent: task.agent, task: task.task };
    });
    if (children.length === 1) return { agent: children[0].agent, task: children[0].task, async: true };
    // JSON serialization is deliberate: task text is data, never executable code.
    return { workflowScript: `return await runs.all(${JSON.stringify(children)});`, async: true,
      worktree: true, globalConcurrencyLimit: 4, maxSubagentSpawnsPerRun: 8 };
  }
  if (!["status", "steer", "stop"].includes(action as string)) throw new Error("Use start, status, steer, or stop");
  if (tasks !== undefined) throw new Error("tasks is only valid for start");
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
    promptSnippet: "Start, inspect, guide, or stop subagents; independent tasks can run in parallel",
    promptGuidelines: ["Use subagent only for independent work; read results before dependent work and keep one writer per worktree."],
    // Old normalizers/renderers expect the old schema. Keep result rendering,
    // but use Pi's generic call rendering for the new arguments.
    prepareArguments: undefined,
    renderCall: undefined,
    async execute(callId, params, signal, update, ctx) {
      return tool.execute(callId, subagentRequest(params), signal, update, ctx);
    },
  };
}
