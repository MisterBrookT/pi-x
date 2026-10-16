/** Roles exposed by Pix; upstream may provide additional agents. */
export const subagentRoles = ["worker", "scout"] as const;

export const subagentRoleGuidance = "scout explores the codebase and reports; worker makes scoped edits, runs checks, and reports changes and risks.";

/**
 * How the model sees the supervisor channel.
 *
 * A child that hits a decision it cannot make pauses and asks; this tool is how
 * the main agent answers. Upstream describes it by its transport ("native
 * channel", "pi-intercom"), which tells the model nothing about when to use it.
 */
export const supervisorDescription =
  "Answer a subagent that has paused for a decision. pending lists open requests; reply answers one (replyTo, message); send or ask reaches a live child (to); list and status show the channel.";
