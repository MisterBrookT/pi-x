import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { backgroundState } from "../core/background-state.ts";
import { CHAT_WAITS_QUERY, type ChatWaitsState } from "../core/chat-waiting.ts";

/** One status query at the idle boundary, never a polling loop. */
export async function hasPendingGoalWork(pi: Pick<ExtensionAPI, "events" | "getAllTools">): Promise<boolean> {
	if (backgroundState(pi).running > 0) return true;
	if (!pi.getAllTools().some((tool) => tool.name === "subagent")) return false;
	return new Promise<boolean>((resolve, reject) => {
		const requestId = randomUUID();
		let unsubscribe = () => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("Subagent status unavailable; use /goal resume once it is available."));
		}, 2000);
		unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (value: unknown) => {
			const reply = value as { version?: number; requestId?: string; success?: boolean; data?: { fleet?: { version?: number; totalActive?: number } } };
			if (reply?.version !== 1 || reply.requestId !== requestId) return;
			clearTimeout(timer);
			unsubscribe();
			const fleet = reply.data?.fleet;
			const active = fleet?.totalActive;
			if (!reply.success || fleet?.version !== 1 || typeof active !== "number" || !Number.isInteger(active) || active < 0) {
				reject(new Error("Cannot determine outstanding subagent work; goal paused."));
			} else resolve(active > 0);
		});
		pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "status", params: {} });
	});
}

/** What a waiting goal waits on: running jobs, open chat waits, and the earliest scheduled health check. */
export function goalDependencies(pi: Pick<ExtensionAPI, "events">): { jobs: number; waits: number; next?: number } {
	const bg = backgroundState(pi);
	const chat: ChatWaitsState = { waits: 0 };
	pi.events.emit(CHAT_WAITS_QUERY, chat);
	const times = [bg.nextLook, chat.nextCheck].filter((t): t is number => typeof t === "number");
	return { jobs: bg.running, waits: chat.waits, ...(times.length ? { next: Math.min(...times) } : {}) };
}
