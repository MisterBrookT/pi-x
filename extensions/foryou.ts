/**
 * The For you coordinator: one Pi session (id "pix-foryou") that looks after brook's open loops.
 * It gets a map of what is open each turn, plus one `loops` tool, and decides the rest itself:
 * do a loop here, hand it to a session already open or already on it, or start one in a project.
 * In every other session this extension does nothing.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { actItem, coordinatorContext, dismissItem, doneItem, forYouSession, laterItem, nextItem, noteItem, type LiveSession } from "../src/proactive-store.ts";
import { remoteDefaultPort, remoteTokenPath } from "../src/remote-hub.ts";

const TOOL = "loops";

/** Live Pi sessions from the Remote hub; empty when it is not running. */
async function hubSessions(): Promise<LiveSession[]> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
		return res.ok ? await res.json() : [];
	} catch { return []; }
}

/** Hand off through the hub when it runs (it can queue into live sessions); else start directly. */
async function handOff(id: string, into: string, cwd?: string): Promise<boolean> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/act`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ into, ...(cwd ? { cwd } : {}) }), signal: AbortSignal.timeout(5000) });
		if (res.ok) return true;
	} catch { /* no hub */ }
	// No hub, or the hub keeps another list (tests, PIX_PROACTIVE_DIR): act directly.
	return !!(await actItem(id, { into, cwd }));
}

export interface ForYouDeps { sessions?: () => Promise<LiveSession[]>; handOff?: typeof handOff; dir?: string }

export default function (pi: ExtensionAPI, deps: ForYouDeps = {}) {
	const isCoordinator = (ctx: any) => ctx?.sessionManager?.getSessionId?.() === forYouSession.id;
	const sessions = deps.sessions ?? hubSessions;

	pi.registerTool({
		name: TOOL,
		label: "Loops",
		description: "Act on brook's open loops (For you). handoff: send a loop to another Pi session (an open one by id, the one already on it, or \"new\" in a folder). note: add a progress line to a loop's brief. next: a step is finished and the next one is brook's; give the new button (1-3 word outcome, e.g. \"Send results to Amber\") and next step, and it comes back to him. later: park it until near its due date. done: brook handled it. drop: not worth tracking.",
		parameters: Type.Object({
			action: StringEnum(["handoff", "note", "next", "later", "done", "drop"] as const),
			id: Type.String({ description: "Loop id" }),
			into: Type.Optional(Type.String({ description: "handoff: a session id, or \"new\"" })),
			cwd: Type.Optional(Type.String({ description: "handoff into \"new\": the project folder (default: the loop's project)" })),
			text: Type.Optional(Type.String({ description: "note: the progress line; next: what is done" })),
			button: Type.Optional(Type.String({ description: "next: the new main button, 1-3 words naming the outcome" })),
			step: Type.Optional(Type.String({ description: "next: the next step" })),
		}),
		async execute(_id, p) {
			const done = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (p.action === "note") return done(noteItem(p.id, p.text ?? "", deps.dir) ? "Noted." : `No loop ${p.id}, or empty note.`);
			if (p.action === "later") return done(laterItem(p.id, deps.dir) ? "Parked." : `No open loop ${p.id}.`);
			if (p.action === "next") return done(nextItem(p.id, { button: p.button ?? "", action: p.step ?? "", note: p.text }, deps.dir) ? `Moved ${p.id} on: "${p.button}".` : `No open loop ${p.id}, or missing button/step.`);
			if (p.action === "done") return done(doneItem(p.id, deps.dir) ? "Done." : `No open loop ${p.id}.`);
			if (p.action === "drop") return done(dismissItem(p.id, deps.dir) ? "Dropped." : `No open loop ${p.id}.`);
			if (!p.into || p.into === forYouSession.id) return done("Name a session id or \"new\"; to do it here, just do it.");
			return done((await (deps.handOff ?? handOff)(p.id, p.into, p.cwd)) ? `Handed ${p.id} to ${p.into === "new" ? "a new session" : p.into}.` : `Could not hand off ${p.id} (closed, or no folder for a new session).`);
		},
	});

	// The tool is only declared in the coordinator, so other sessions pay nothing for it.
	const apply = (ctx: any) => {
		const active = new Set(pi.getActiveTools());
		if (isCoordinator(ctx)) active.add(TOOL); else active.delete(TOOL);
		pi.setActiveTools([...active]);
	};
	pi.on("session_start", (_e, ctx) => apply(ctx));
	pi.on("before_agent_start", async (event, ctx) => {
		apply(ctx);
		if (!isCoordinator(ctx)) return undefined;
		try { return { systemPrompt: `${event.systemPrompt}\n\n${coordinatorContext(deps.dir, await sessions())}` }; } catch { return undefined; }
	});
}
