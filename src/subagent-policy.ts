/** Roles exposed by Pix; upstream may provide additional agents. */
export const subagentRoles = ["worker", "scout"] as const;

export const subagentRoleGuidance = "scout explores the codebase and reports; worker makes scoped edits, runs checks, and reports changes and risks.";
