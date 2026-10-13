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
import { actItem, finishedItem, answerCard, currentCard, coordinatorContext, dismissItem, doneItem, forYouSession, laterItem, nextItem, noteItem, type LiveSession } from "../src/proactive-store.ts";
import type { CardAnswer } from "../src/proactive-store.ts";
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

export interface ForYouDeps { sessions?: () => Promise<LiveSession[]>; handOff?: typeof handOff; answer?: typeof answerViaHub; dir?: string; cardPollMs?: number }

/** Answer through the hub when it runs (it queues work into sessions and updates the phone). */
async function answerViaHub(id: string, body: { answer: CardAnswer; choice?: number; to?: string; text?: string }): Promise<"ok" | "gone" | "nohub"> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/card`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, by: "mac" }), signal: AbortSignal.timeout(8000) });
		return res.ok ? "ok" : res.status === 409 ? "gone" : "nohub";
	} catch { return "nohub"; }
}

export const CARD_NO = "Not important, forget it", CARD_SEND = "Send to a session…", CARD_ELSE = "Something else…";
/** How a judge-written button reads in the Mac picker: where it runs, when that is another session. */
export const choiceLabel = (c: { label: string; run: string; name?: string }) => ["here", "discuss", "later", "no"].includes(c.run) ? c.label : c.run === "new" ? `${c.label} (new session) ›` : `${c.label} (${c.name ?? c.run}) ›`;

export default function (pi: ExtensionAPI, deps: ForYouDeps = {}) {
	const isCoordinator = (ctx: any) => ctx?.sessionManager?.getSessionId?.() === forYouSession.id;
	const sessions = deps.sessions ?? hubSessions;

	pi.registerTool({
		name: TOOL,
		label: "Loops",
		description: "Act on brook's open loops (For you). handoff: send a loop to another Pi session (an open one by id, the one already on it, or \"new\" in a folder). note: add a progress line to a loop's brief. finished: the whole loop is done (text = what was done); it goes back to brook once to check and close. next: a step is finished and the next one is brook's; give the new button (1-3 word outcome, e.g. \"Send results to Amber\") and next step, and it comes back to him. later: park it until near its due date. done: brook handled it. drop: not worth tracking.",
		parameters: Type.Object({
			action: StringEnum(["handoff", "note", "next", "finished", "later", "done", "drop"] as const),
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
			if (p.action === "finished") return done(finishedItem(p.id, p.text ?? "", deps.dir) ? "Back to brook to check and close." : `No open loop ${p.id}, or empty text.`);
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
	// Cards: in the For you session only. When Pi is idle, show the oldest loop that needs brook; nothing
	// runs until he picks. The phone shows the same card; whichever answers first wins, the other closes.
	let timer: ReturnType<typeof setInterval> | undefined, showing: string | undefined, close: AbortController | undefined;
	const check = async (ctx: any) => {
		if (!isCoordinator(ctx) || !ctx.hasUI) return;
		const it = currentCard(deps.dir, await sessions().catch(() => []));
		if (showing && showing !== it?.id) { close?.abort(); return; }
		if (!it || showing || !ctx.isIdle()) return;
		showing = it.id; close = new AbortController();
		try {
			const title = `For you · ${it.source}${it.left ? ` · ${it.left} more` : ""}\n${it.title}\n${it.why ? `${it.why}\n` : ""}Next: ${it.action}`;
			const labels = it.choices.map(choiceLabel);
			const pick = await ctx.ui.select(title, [...labels, CARD_NO, ...(it.sessions.length ? [CARD_SEND] : []), CARD_ELSE], { signal: close.signal });
			if (!pick) return;
			const text = pick === CARD_ELSE ? await ctx.ui.input("What should For you do instead?", "", { signal: close.signal }) : undefined;
			if (pick === CARD_ELSE && !text?.trim()) return;
			let to: string | undefined;
			if (pick === CARD_SEND) {
				const names = it.sessions.map(s => s.id === "new" ? `New session in ${s.cwd}` : `${s.name}  ${s.cwd ?? ""}`.trim());
				const where = await ctx.ui.select("Send to which session?", names, { signal: close.signal });
				if (!where) return;
				to = it.sessions[names.indexOf(where)]?.id;
			}
			const index = labels.indexOf(pick);
			const answer: CardAnswer = index >= 0 ? "choice" : pick === CARD_NO ? "no" : to ? "send" : "else";
			const choice = index >= 0 ? index : undefined;
			const via = await (deps.answer ?? answerViaHub)(it.id, { answer, choice, ...(to ? { to } : {}), text });
			if (via === "gone") { ctx.ui.notify("That card was already answered.", "info"); return; }
			if (via === "ok") return;
			// No hub: answer here directly.
			const r = answerCard(it.id, answer, { choice, to, text, by: "mac", dir: deps.dir, live: await sessions().catch(() => []) });
			if (!r) { ctx.ui.notify("That card was already answered.", "info"); return; }
			if (r.here) pi.sendUserMessage(r.here);
			if (r.into) await (deps.handOff ?? handOff)(it.id, r.into);
		} finally { showing = undefined; close = undefined; }
	};
	pi.on("session_start", (_e, ctx) => {
		apply(ctx);
		clearInterval(timer);
		timer = setInterval(() => void check(ctx).catch(() => {}), deps.cardPollMs ?? 4000);
		timer.unref?.();
	});
	pi.on("agent_end", (_e, ctx) => void check(ctx).catch(() => {}));
	pi.on("session_shutdown", () => { clearInterval(timer); close?.abort(); });
	pi.on("before_agent_start", async (event, ctx) => {
		apply(ctx);
		if (!isCoordinator(ctx)) return undefined;
		try { return { systemPrompt: `${event.systemPrompt}\n\n${coordinatorContext(deps.dir, await sessions())}` }; } catch { return undefined; }
	});
}
