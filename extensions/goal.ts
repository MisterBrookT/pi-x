import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BACKGROUND_STATE_QUERY, type BackgroundState } from "../src/background-state.ts";
import { GOAL_ENTRY, GOAL_MAX_CONTINUATIONS, GOAL_MAX_EVIDENCE, GOAL_MAX_OBJECTIVE, goalInstructions, parseGoal, type GoalState } from "../src/goal-state.ts";
import { hasPendingGoalWork } from "../src/goal-work.ts";
import { createStateReminder } from "../src/state-reminder.ts";

const WAKE = "pix-goal-wake";
const commands = ["status", "pause", "stop", "resume", "clear"];

export default function goalExtension(pi: ExtensionAPI) {
	let goal: GoalState | null = null;
	let closed = false;
	let checking = false;
	let modelFailed = false;
	let hasGoalHistory = false;
	const reminder = createStateReminder(pi, "pix-goal-context");
	const publishState = (beforeNextResponse = false) => {
		if (!hasGoalHistory) return;
		const content = goal?.status === "active" ? goalInstructions(goal)
			: goal ? `Goal ${goal.id} is ${goal.status}. ${goal.reason}\nEarlier instructions to continue this goal are no longer active. Only an explicit /goal resume or a new /goal can activate goal mode.`
			: "Goal mode is off. Earlier goal instructions are no longer active. Only an explicit /goal can activate goal mode.";
		reminder.publish(`[CURRENT GOAL STATE]\nThis update supersedes earlier goal-state reminders.\n${content}`, beforeNextResponse);
	};

	const show = (ctx: ExtensionContext, waiting = false) => {
		if (ctx.hasUI) ctx.ui.setStatus("pix-goal", goal?.status === "active"
			? `goal on${waiting ? " (waiting)" : ""} · ${goal.continuations}/${GOAL_MAX_CONTINUATIONS}` : undefined);
	};
	const save = (next: GoalState | null, ctx: ExtensionContext, beforeNextResponse = false) => {
		goal = next;
		hasGoalHistory = true;
		pi.appendEntry(GOAL_ENTRY, goal ? { ...goal } : null);
		publishState(beforeNextResponse);
		show(ctx);
	};
	const pause = (reason: string, ctx: ExtensionContext) => {
		if (goal?.status !== "active") return;
		save({ ...goal, status: "paused", reason }, ctx);
		if (ctx.hasUI) ctx.ui.notify(`Goal paused: ${reason}`, "info");
	};
	const restore = (ctx: ExtensionContext, reloading = false) => {
		closed = false;
		modelFailed = false;
		goal = null;
		hasGoalHistory = false;
		reminder.restore(ctx);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === GOAL_ENTRY) {
				goal = parseGoal(entry.data);
				hasGoalHistory = true;
			}
		}
		if (!reloading && goal?.status === "active") pause("Session restored; use /goal resume to continue.", ctx);
		publishState();
		show(ctx);
	};
	const wake = (content: string) => pi.sendMessage({
		customType: WAKE, content, display: true, details: { goalId: goal?.id },
	}, { triggerTurn: true, deliverAs: "followUp" });

	pi.events.on(BACKGROUND_STATE_QUERY, (data: unknown) => {
		if (data && typeof data === "object" && goal) {
			(data as BackgroundState).goal = { id: goal.id, active: !closed && goal.status === "active" };
		}
	});
	pi.on("session_start", (event, ctx) => restore(ctx, event.reason === "reload"));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => {
		reminder.restore(ctx);
		publishState(true);
	});
	pi.on("session_shutdown", (event, ctx) => {
		closed = true;
		// Reload replaces extensions, not the user's goal or continuation budget.
		if (event.reason !== "reload") pause("Session closed; use /goal resume after reopening.", ctx);
	});
	pi.on("agent_start", (_event, ctx) => show(ctx));
	pi.on("agent_end", (event, ctx) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		// Pi retries errors and recovers context overflow after agent_end.
		// Only the final outcome at agent_settled can establish a failed run.
		modelFailed = last?.role === "assistant" && last.stopReason === "error";
		if (last?.role === "assistant" && last.stopReason === "aborted") {
			pause("Interrupted; use /goal resume when ready.", ctx);
		}
	});
	pi.on("context", (_event, ctx) => {
		if (goal?.status === "active" && !pi.getActiveTools().includes("goal")) {
			pause("The goal tool is disabled. Enable it with /tool goal on before resuming.", ctx);
		}
		// Never remove old wakes or move state reminders: later durable updates
		// supersede them without invalidating the provider's conversation prefix.
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (closed || checking || goal?.status !== "active" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (modelFailed) {
			pause("Model error after recovery ended; use /goal resume when ready.", ctx);
			return;
		}
		const current = goal;
		checking = true;
		try {
			const pending = await hasPendingGoalWork(pi);
			// A user command, lifecycle change, or completion wake may have won the race.
			if (closed || goal !== current || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			if (!pi.getActiveTools().includes("goal")) {
				pause("The goal tool is disabled; use /tool goal on before resuming.", ctx);
			} else if (pending) {
				show(ctx, true);
			} else if (goal.continuations >= GOAL_MAX_CONTINUATIONS) {
				pause(`Reached ${GOAL_MAX_CONTINUATIONS} automatic continuations; review progress before /goal resume.`, ctx);
			} else {
				save({ ...goal, continuations: goal.continuations + 1 }, ctx);
				wake(`Goal continuation ${goal.continuations}/${GOAL_MAX_CONTINUATIONS}. Continue useful work toward the active goal, or report verified completion or a genuine blocker with the goal tool.`);
			}
		} catch (error) {
			if (!closed && goal === current) pause(error instanceof Error ? error.message : String(error), ctx);
		} finally {
			checking = false;
		}
	});

	pi.registerCommand("goal", {
		description: "Configure this session's goal, inspect its status, or start work toward an objective",
		getArgumentCompletions: (prefix) => commands.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async function configureGoal(raw, ctx, objectiveOnly = false): Promise<void> {
			const args = raw.trim();
			const status = goal ? `Goal ${goal.status} · ${goal.continuations}/${GOAL_MAX_CONTINUATIONS} continuations\n${goal.objective}${goal.reason ? `\n${goal.reason}` : ""}` : "Goal off · No objective set.";
			if (!args && ctx.mode === "tui" && ctx.hasUI) {
				const current = goal;
				const actions = !goal ? ["Start goal"] : [
					...(goal.status === "active" ? ["Pause goal"] : goal.status === "paused" || goal.status === "blocked" ? ["Resume goal"] : []),
					"Replace goal", "Clear goal",
				];
				const selected = await ctx.ui.select(status, actions);
				if (!selected) return;
				let next: string | undefined;
				if (selected === "Start goal" || selected === "Replace goal") {
					next = await ctx.ui.input("Goal objective");
					if (!next?.trim()) return;
				} else {
					next = ({ "Pause goal": "pause", "Resume goal": "resume", "Clear goal": "clear" } as Record<string, string>)[selected];
				}
				if (closed || goal !== current) {
					ctx.ui.notify("Goal changed while the settings were open. Open /goal again.", "info");
					return;
				}
				if (next) await configureGoal(next, ctx, selected === "Start goal" || selected === "Replace goal");
				return;
			}
			if (!objectiveOnly && (!args || args === "status")) {
				ctx.ui.notify(`${status}\nUse /goal to configure. Controls: pause, resume, clear.`, "info");
				return;
			}
			if (!objectiveOnly && (args === "pause" || args === "stop")) {
				pause("Paused by user. Current work is not cancelled; Esc interrupts it.", ctx);
				return;
			}
			if (!objectiveOnly && args === "clear") { save(null, ctx); return; }
			if (closed || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
				ctx.ui.notify("Goal mode requires a persistent TUI or RPC session.", "error");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current turn to finish or press Esc before starting/resuming a goal.", "warning");
				return;
			}
			if (!pi.getActiveTools().includes("goal")) {
				ctx.ui.notify("Enable the goal tool with /tool goal on first.", "error");
				return;
			}
			if (!objectiveOnly && args === "resume") {
				if (!goal || (goal.status !== "paused" && goal.status !== "blocked")) {
					ctx.ui.notify("Only a paused or blocked goal can be resumed.", "warning");
					return;
				}
				save({ ...goal, status: "active", continuations: 0, reason: "" }, ctx);
			} else {
				if (args.length > GOAL_MAX_OBJECTIVE) {
					ctx.ui.notify(`Keep the objective under ${GOAL_MAX_OBJECTIVE} characters.`, "error");
					return;
				}
				save({ version: 1, id: randomUUID(), objective: args, status: "active", continuations: 0, reason: "" }, ctx);
			}
			modelFailed = false;
			// A visible custom message starts the run without impersonating new user input.
			if (goal) wake(`Work toward this user-set goal:\n${goal.objective}`);
		},
	});

	pi.registerTool({
		name: "goal", label: "Goal",
		description: "Finish the active /goal. Use its exact id. completed requires concrete verification evidence (checks and results); blocked requires the missing information, permission, or prerequisite. Do not mark waiting background work as blocked. Does not start or resume goals.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			status: StringEnum(["completed", "blocked"] as const),
			evidence: Type.String({ minLength: 1, maxLength: GOAL_MAX_EVIDENCE, pattern: "\\S" }),
		}),
		async execute(_callId, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const current = goal;
			if (closed || !current || current.status !== "active" || current.id !== params.id) throw new Error("No matching active goal.");
			if (!params.evidence.trim()) throw new Error("Concrete evidence or a blocker is required.");
			if (params.status === "completed" && await hasPendingGoalWork(pi)) throw new Error("Background work is still running. Read its results before completing the goal.");
			signal?.throwIfAborted();
			if (closed || goal !== current) throw new Error("Goal changed while checking completion.");
			save({ ...current, status: params.status, reason: params.evidence.trim() }, ctx, true);
			return { content: [{ type: "text", text: `Goal ${params.status}: ${goal.reason}` }], details: { goal: { ...goal } } };
		},
	});
}
