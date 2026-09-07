/** Roles exposed by Pix; upstream may provide additional agents. */
export const subagentRoles = ["worker", "scout"] as const;

export const subagentRoleGuidance = "Choose worker for scoped implementation: make narrow edits, run checks, and report changes and risks. Choose scout for codebase discovery and navigation; choose worker for implementation. Choose the role by task, not by model; its configured model, effort, and fallback are resolved at launch.";
