import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { backgroundState } from "./background-state.ts";

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
