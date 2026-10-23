// How a feature plugs into the phone hub (plugins/remote): its own API routes, phone events,
// extra fields on sessions, and which routes the relay may forward. The hub itself names no feature.

export interface HubLiveSession { id: string; name: string; cwd: string; busy: boolean }
export interface HubPush { title: string; body: string; session: string; tag: string; foryou?: boolean }

/** What the hub lends a plugin. */
export interface HubContext {
	/** Send an event to every connected phone. */
	publish(event: string, data: unknown): void;
	/** Push a notification (skipped when push is off). */
	notify(message: HubPush): void;
	liveSessions(): HubLiveSession[];
	/** Queue a prompt into a live session (follow-up if busy). False if that session is not connected. */
	queue(session: string, text: string): boolean;
	/** A quiet line the session sees on its next turn; it never starts a turn. */
	note?(session: string, text: string): boolean;
	/** Re-send one session and the session list to phones (after the plugin's session fields changed). */
	refreshSession(session: string): void;
}

export interface HubRouteResult { status: number; body: unknown }

/** One feature's hub side. Every hook is optional. */
export interface HubPluginInstance {
	/** Answer an /api request, or return undefined to let the hub continue. */
	route?(method: string, path: string, body: () => Promise<any>): Promise<HubRouteResult | undefined> | HubRouteResult | undefined;
	/** Events every phone gets when it connects: [event, data]. */
	initial?(): [string, unknown][];
	/** Extra fields on a session-list row / full session. */
	summary?(session: string): Record<string, unknown> | undefined;
	session?(session: string): Record<string, unknown> | undefined;
	sessionJoined?(session: string): void;
	close?(): void;
}
export type HubPlugin = (ctx: HubContext) => HubPluginInstance;

/** Relay allow-list entries a plugin adds: phone requests the relay may forward to the Mac. */
export type RelayRule = (path: string, method: string) => boolean;

// Plugins register here when Pi loads them; the hub reads the registry when it starts. On globalThis
// because Pi may load each extension as its own module graph.
interface Registry { hub: Map<string, HubPlugin>; relay: Map<string, RelayRule> }
const registry = (): Registry => ((globalThis as any).__pixHubPlugins ??= { hub: new Map(), relay: new Map() });

/** Add a feature to the hub: its routes and events, and the phone requests the relay may forward. */
export function registerHubPlugin(name: string, plugin: HubPlugin, relay?: RelayRule): void {
	registry().hub.set(name, plugin);
	if (relay) registry().relay.set(name, relay);
}
export const registeredHubPlugins = (): HubPlugin[] => [...registry().hub.values()];
export const pluginRelayAllowed = (path: string, method: string) => [...registry().relay.values()].some(rule => rule(path, method));
