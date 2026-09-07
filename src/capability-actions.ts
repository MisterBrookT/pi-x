/** Capability-owned actions exposed by /tool without extra top-level commands. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export interface CapabilityAction {
	verb: string;
	description: string;
	/** Optional key in the capability's /tool panel. */
	shortcut?: KeyId;
	run: (ctx: ExtensionContext) => Promise<void> | void;
}

type ActionHost = Pick<ExtensionAPI, "events">;
interface ActionQuery {
	capabilityId: string;
	actions: CapabilityAction[];
}
const queryEvent = "pix:capability-actions:query";

/**
 * Pi loads each extension with a separate module cache. Use its shared event
 * bus, not a module-level Map. Pi removes these subscriptions on reload so an
 * unloaded provider cannot leave stale action callbacks behind.
 */
export const registerCapabilityAction = (pi: ActionHost, capabilityId: string, action: CapabilityAction): (() => void) =>
	pi.events.on(queryEvent, (data: unknown) => {
		const query = data as ActionQuery;
		if (query?.capabilityId === capabilityId && Array.isArray(query.actions)) query.actions.push(action);
	});

/** Queries are synchronous; last registration of a verb wins. */
export const capabilityActions = (pi: ActionHost, capabilityId: string): CapabilityAction[] => {
	const query: ActionQuery = { capabilityId, actions: [] };
	pi.events.emit(queryEvent, query);
	return [...new Map(query.actions.map(action => [action.verb, action])).values()];
};
