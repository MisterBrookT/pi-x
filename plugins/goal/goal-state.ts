export const GOAL_ENTRY = "pix-goal";
export const GOAL_MAX_CONTINUATIONS = 10;
export const GOAL_MAX_OBJECTIVE = 4000;
export const GOAL_MAX_EVIDENCE = 2000;

export interface GoalState {
	version: 1;
	id: string;
	objective: string;
	status: "active" | "paused" | "completed" | "blocked";
	continuations: number;
	reason: string;
}

/** Invalid or future records fail closed rather than reviving an older goal. */
export function parseGoal(value: unknown): GoalState | null {
	if (!value || typeof value !== "object") return null;
	const goal = value as GoalState;
	if (goal.version !== 1 || typeof goal.id !== "string" || !goal.id || goal.id.length > 64
		|| typeof goal.objective !== "string" || !goal.objective.trim() || goal.objective.length > GOAL_MAX_OBJECTIVE
		|| !["active", "paused", "completed", "blocked"].includes(goal.status)
		|| !Number.isInteger(goal.continuations) || goal.continuations < 0 || goal.continuations > GOAL_MAX_CONTINUATIONS
		|| typeof goal.reason !== "string" || goal.reason.length > GOAL_MAX_EVIDENCE) return null;
	return { ...goal };
}

export function goalInstructions(goal: GoalState): string {
	return `Active user goal ${goal.id} (${goal.continuations}/${GOAL_MAX_CONTINUATIONS} automatic continuations used):\n${goal.objective}\n\nWork toward this objective within existing permissions and instructions; keep its full scope, never narrow it to what is easy. The goal owns the outcome and acceptance verification and is the only continuation controller; todos only track steps. Progress means concrete actions and evidence, not plans or progress reports; do not stop while useful work remains. Finishing every todo is a cue to verify, not completion: audit the objective requirement by requirement against actual evidence. If verification finds a gap, add or reopen todos and continue. Only after every criterion is verified, call goal with status=completed and concrete evidence (checks and results); never claim verification you did not perform. Before declaring a blocker, try safe alternatives within existing permissions; do not repeatedly ask for authorization. If still blocked by missing authorization, information, or an unavailable prerequisite, call goal with status=blocked and explain what is needed. Use the exact goal id above. For background commands or subagents, do independent work, then yield for their native completion notification; do not poll or declare a blocker merely because work is still running. Goal mode grants no extra permissions.`;
}
