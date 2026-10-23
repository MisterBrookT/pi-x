import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session-local coordination via Pi's shared bus, not extension module globals. */
export const BACKGROUND_STATE_QUERY = "pix:background-state:query";
/** Emitted with { id, state } when a background job ends, so todo steps waiting on it can be refreshed. */
export const BACKGROUND_JOB_END = "pix:background-job-end";
/** Emitted when running jobs or their next health check change, so remote views can refresh. */
export const BACKGROUND_CHANGED = "pix:background-changed";
export interface BackgroundState {
	running: number;
	/** Chat asks/handoffs still waiting for a reply: background work done by another session. */
	waits?: number;
	/** Earliest scheduled health check (epoch ms) among running jobs, if any. */
	nextLook?: number;
	goal?: { id: string; active: boolean };
}

export function backgroundState(pi: Pick<ExtensionAPI, "events">): BackgroundState {
	const state: BackgroundState = { running: 0 };
	pi.events.emit(BACKGROUND_STATE_QUERY, state);
	return state;
}
