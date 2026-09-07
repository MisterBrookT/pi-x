/**
 * The single record of which tools the user chose.
 *
 * Capability knobs and individual tool rows both write here, in one format, so
 * they cannot disagree. An earlier version kept a second record for per-family
 * commands, which let the two contradict each other: whichever handler ran last
 * silently undid the other's choice. Entries are replayed in branch order and
 * the last choice for a name wins, so "last thing the user did" is the rule
 * regardless of which control they used.
 *
 * Only explicit choices are stored, never the resolved active set. Saving the
 * whole set would freeze a session against a later release: a tool shipped
 * afterwards would be absent from the saved list and stay off with nothing
 * explaining why.
 */

import { CAPABILITIES } from "./tool-panel.ts";

/** Session entry holding explicit per-tool choices. */
export const TOOL_ENTRY = "pix-tool-overrides";

/**
 * Entry written by the removed per-family commands (`/computer`, `/mcp`).
 *
 * Read for sessions that already contain it, so reloading one does not silently
 * drop a capability the user had turned on. Nothing writes it any more.
 */
export const LEGACY_FAMILY_ENTRY = "pix-capability-enabled";

/** Explicit per-tool choices; absent tools keep whatever default applies. */
export interface Overrides {
	[tool: string]: boolean;
}

/** The minimum of a session entry this module needs, so tests need no session. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Fold a branch of session entries into the choices they express.
 *
 * A legacy family entry is expanded to that capability's primary tools when
 * turned on, and to everything it owns when turned off, matching what the
 * capability knob does now.
 */
export const foldOverrides = (entries: Iterable<BranchEntry>): Overrides => {
	const merged: Overrides = {};
	for (const entry of entries) {
		if (entry.type !== "custom") continue;

		if (entry.customType === TOOL_ENTRY) {
			const data = (entry.data as { overrides?: Overrides } | undefined)?.overrides;
			if (data) for (const [name, on] of Object.entries(data)) merged[name] = on;
			continue;
		}

		if (entry.customType !== LEGACY_FAMILY_ENTRY) continue;
		const legacy = entry.data as { family?: string; on?: boolean } | undefined;
		const capability = CAPABILITIES.find((candidate) => candidate.id === legacy?.family);
		if (!capability) continue;
		const names = legacy?.on ? capability.primary : [...capability.primary, ...capability.secondary];
		// A family choice supersedes earlier single-tool choices inside it, the
		// same way toggling the knob does.
		for (const name of [...capability.primary, ...capability.secondary]) delete merged[name];
		for (const name of names) merged[name] = legacy?.on === true;
	}
	return merged;
};

/** Read the choices recorded on the current branch. */
export const readOverrides = (ctx: {
	sessionManager: { getBranch: () => BranchEntry[] };
}): Overrides => foldOverrides(ctx.sessionManager.getBranch());
