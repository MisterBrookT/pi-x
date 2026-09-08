import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session-local coordination via Pi's shared bus, not extension module globals. */
export const BACKGROUND_STATE_QUERY = "pix:background-state:query";
export interface BackgroundState {
	running: number;
	goal?: { id: string; active: boolean };
}

export function backgroundState(pi: Pick<ExtensionAPI, "events">): BackgroundState {
	const state: BackgroundState = { running: 0 };
	pi.events.emit(BACKGROUND_STATE_QUERY, state);
	return state;
}
