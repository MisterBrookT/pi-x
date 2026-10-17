/**
 * The For you coordinator: one Pi session (id "pix-foryou") that looks after brook's open loops.
 * It gets a map of what is open each turn, plus one `loops` tool, and decides the rest itself:
 * do a loop here, hand it to a session already open or already on it, or start one in a project.
 * In every other session this extension does nothing.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { LOOP_MESSAGE, loopMessage, loopPromptSummary } from "../core/loop-message.ts";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { matchesKey } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readOpen, actItem, preparedItem, finishedItem, answerCard, currentCard, stillWaiting, quickAnswer, coordinatorContext, dismissItem, doneItem, forYouSession, publishChoices, laterItem, nextItem, noteItem, trackTurn, type LiveSession } from "./proactive-store.ts";
import type { CardAnswer } from "./proactive-store.ts";
import { registerHubPlugin } from "../core/hub-plugin.ts";
import { forYouHub, forYouRelayAllowed } from "./hub.ts";
import { expandForYou, withForYou } from "./foryou-mention.ts";
import { remoteDefaultPort, remoteTokenPath } from "../core/hub-paths.ts";

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

export interface ForYouDeps { sessions?: () => Promise<LiveSession[]>; handOff?: typeof handOff; answer?: typeof answerViaHub; dir?: string; cardPollMs?: number; badge?: (waiting: boolean) => void }

/** Answer through the hub when it runs (it queues work into sessions and updates the phone). */
async function answerViaHub(id: string, body: { answer: CardAnswer; choice?: number; to?: string; text?: string }): Promise<"ok" | "gone" | "nohub"> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/card`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, by: "mac" }), signal: AbortSignal.timeout(8000) });
		return res.ok ? "ok" : res.status === 409 ? "gone" : "nohub";
	} catch { return "nohub"; }
}

/** Cmd+Shift+Y (Otty sends Cmd as super via the kitty keyboard protocol; plain Cmd+Y is Otty's Redo). */
export const CARD_KEY = "super+shift+y";

/** The hand icon on the For you tab in Otty's sidebar while a card waits (like the phone). */
/** One line per card UI event in ~/.pix/proactive/card-ui.log, so a misbehaving card can be traced later. */
export function cardLog(dir: string | undefined, event: string, data: Record<string, unknown> = {}) {
	try { appendFileSync(join(dir ?? join(homedir(), ".pix", "proactive"), "card-ui.log"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n"); } catch { /* logging never breaks the card */ }
}

export function ottyBadge(waiting: boolean, run: (cmd: string, args: string[]) => void = (c, a) => { try { execFile(c, a, () => {}); } catch { /* no otty */ } }, pane = process.env.OTTY_PANE_ID) {
	if (!pane) return;
	run("otty", ["pane", "badge", pane.startsWith("p_") ? pane : `p_${pane}`, ...(waiting ? ["--kind", "awaiting-input"] : ["--clear"])]);
}
export const CARD_LATER = "Later", CARD_NO = "Not important, forget it", CARD_ELSE = "Something else…";
/** How a judge-written button reads in the Mac picker: where it runs, when that is another session. */
export const choiceLabel = (c: { label: string; run: string; name?: string }) => ["here", "discuss", "later", "no"].includes(c.run) ? c.label : c.run === "new" ? `${c.label} (new session) ›` : `${c.label} (${c.name ?? c.run}) ›`;

/** The waiting card as a few short lines above the editor. */
export const cardLines = (it: { title: string; why?: string; source: string; left: number; choices: { label: string; run: string; name?: string }[] }) => [
	`● ${it.title.length > 60 ? `${it.title.slice(0, 59)}…` : it.title}${it.left ? `  +${it.left}` : ""}   ⌘⇧Y`,
];

/** A session to hand the task to, as one option in the card's list. */
export const sendLabel = (x: { id: string; name: string; cwd?: string }) => x.id === "new" ? `Do it in a new session (${x.cwd ?? "project"}) ›` : `Do it in ${x.name} ›`;

/** The card in the Mac picker: what it is, then what each button would do (so the decision is clear). */
export const cardTitle = (it: { prepared?: string; title: string; why?: string; source: string; left: number; at?: number; action?: string; task?: string; choices: { label: string; run: string; name?: string; task?: string }[] }) => [
	it.title,
	`${it.source}${it.left ? ` · ${it.at ?? 1} of ${it.left + 1}   ← → more cards` : ""}`,
	"",
	...(it.why ? [it.why, ""] : []),
	...(it.prepared ? [`Prepared: ${it.prepared}`, ""] : []),
	...(it.task ?? it.action ? [`Plan: ${it.task ?? it.action}`] : []),
].join("\n");

/** A short reply in the For you editor that answers the waiting card: a button number or later/no/done. */
export function cardReply(text: string, buttons: number): { answer: CardAnswer; choice?: number; text?: string } | undefined {
	const t = text.trim();
	const n = /^\d$/.test(t) ? Number(t) : NaN;
	if (n >= 1 && n <= buttons) return { answer: "choice", choice: n - 1 };
	return quickAnswer(t) ? { answer: "else", text: t } : undefined;
}

export default function (pi: ExtensionAPI, deps: ForYouDeps = {}) {
	// The phone side: the bell page, cards on the For you session, and its /api/foryou routes.
	registerHubPlugin("foryou", forYouHub(), forYouRelayAllowed);
	const isCoordinator = (ctx: any) => ctx?.sessionManager?.getSessionId?.() === forYouSession.id;
	const sessions = deps.sessions ?? hubSessions;

	pi.registerTool({
		name: TOOL,
		label: "Loops",
		description: "Act on brook's open loops (For you). prepared: the result of preparing a new loop under the hood (text = the draft or facts brook will see on the card). handoff: send a loop to another Pi session (an open one by id, the one already on it, or \"new\" in a folder). note: add a progress line to a loop's brief. finished: the whole loop is done (text = what was done); it goes back to brook once to check and close. next: a step is finished and the next one is brook's; give the new button (1-3 word outcome, e.g. \"Send results to Amber\") and next step, and it comes back to him. choices: brook must decide; put 1-3 buttons (label + run: here|discuss|<session id>|new|later|no, optional prompt) and an optional question on his card, then end your turn without waiting (he can also type his own answer or pick Later). later: park it until near its due date. done: brook handled it. drop: not worth tracking.",
		parameters: Type.Object({
			action: StringEnum(["prepared", "handoff", "note", "next", "finished", "choices", "later", "done", "drop"] as const),
			id: Type.String({ description: "Loop id" }),
			into: Type.Optional(Type.String({ description: "handoff: a session id, or \"new\"" })),
			cwd: Type.Optional(Type.String({ description: "handoff into \"new\": the project folder (default: the loop's project)" })),
			text: Type.Optional(Type.String({ description: "note: the progress line; next: what is done" })),
			button: Type.Optional(Type.String({ description: "next: the new main button, 1-3 words naming the outcome" })),
			choices: Type.Optional(Type.Array(Type.Object({ label: Type.String(), run: Type.String({ description: "here, discuss, a session id, new, later, or no" }), prompt: Type.Optional(Type.String()) }), { description: "choices: the card's buttons" })),
			question: Type.Optional(Type.String({ description: "choices: what brook is deciding, one line" })),
			step: Type.Optional(Type.String({ description: "next: the next step" })),
		}),
		async execute(_id, p) {
			const done = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (p.action === "prepared") return done(preparedItem(p.id, p.text ?? "", deps.dir) ? "On brook's card. End your turn." : `No open loop ${p.id}, or empty text.`);
			if (p.action === "note") return done(noteItem(p.id, p.text ?? "", deps.dir) ? "Noted." : `No loop ${p.id}, or empty note.`);
			if (p.action === "finished") return done(finishedItem(p.id, p.text ?? "", deps.dir) ? "Back to brook to check and close." : `No open loop ${p.id}, or empty text.`);
			if (p.action === "choices") return done(publishChoices(p.id, p.choices, { question: p.question, dir: deps.dir }) ? "On brook's card. End your turn; his answer will come back." : `No open loop ${p.id}, or no valid choices.`);
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
	// Cards: in the For you session only. A card never pops up by itself: it sits as a small widget above the
	// editor (reply with a number, later, no or done) and on the phone, so the session keeps working. brook answers whenever he wants;
	// the first answer (Mac or phone) wins. Typing "later"/"no"/"done" on the card acts directly.
	let timer: ReturnType<typeof setInterval> | undefined, showing: string | undefined, close: AbortController | undefined, shown: string | undefined, badged: boolean | undefined;
	const widget = (ctx: any, it: Awaited<ReturnType<typeof currentCard>>) => {
		const key = it ? `${it.id}:${it.left}:${it.choices.map(c => c.label).join("|")}` : "";
		if (key === shown) return;
		if (!!key !== badged) { badged = !!key; (deps.badge ?? ottyBadge)(badged); }
		shown = key;
		cardLog(deps.dir, "widget", { id: it?.id ?? null, left: it?.left });
		ctx.ui.setWidget?.("foryou-card", it ? cardLines(it) : undefined);
	};
	const check = async (ctx: any) => {
		if (!isCoordinator(ctx) || !ctx.hasUI) return;
		const it = currentCard(deps.dir, await sessions().catch(() => []));
		// Close the open picker only when its card was answered elsewhere (phone) or went away,
		// not because another card is first in line (the picker may show card 2 of 3).
		if (showing && !stillWaiting(showing, deps.dir)) { cardLog(deps.dir, "picker closed: card answered or gone", { id: showing }); close?.abort(); }
		widget(ctx, it);
	};
	const answer = async (ctx: any, skip = 0): Promise<void> => {
		const it = currentCard(deps.dir, await sessions().catch(() => []), Date.now(), skip);
		if (!it) { cardLog(deps.dir, "shortcut: no card"); ctx.ui.notify("No card waiting.", "info"); return; }
		if (showing) { cardLog(deps.dir, "shortcut ignored: picker already open", { showing }); return; }
		cardLog(deps.dir, "picker open", { id: it.id, at: it.at, of: it.left + 1, skip });
		showing = it.id; close = new AbortController();
		try {
			const title = cardTitle(it);
			const labels = it.choices.map(choiceLabel);
			// One flat list: no second picker. Only sessions that fit this loop (same project, or the suggested one) are offered; anything else, type it.
			const taken = new Set(it.choices.map(c => c.run));
			const targets = it.sessions.filter(x => x.fits && !taken.has(x.id)).slice(0, 2);
			const sendLabels = targets.map(sendLabel);
			// ←/→ flip between waiting cards without leaving the picker.
			let step = 0;
			const flip = (it.left && ctx.ui.onTerminalInput) ? ctx.ui.onTerminalInput((data: string) => {
				const d = matchesKey(data, "right") ? 1 : matchesKey(data, "left") ? -1 : 0;
				if (!d) return undefined;
				step = d; cardLog(deps.dir, d > 0 ? "key →" : "key ←", { id: it.id }); close?.abort();
				return { consume: true };
			}) : undefined;
			let pick: string | undefined;
			try { pick = await ctx.ui.select(title, [...labels, ...sendLabels, CARD_ELSE, ...(taken.has("later") ? [] : [CARD_LATER]), CARD_NO], { signal: close.signal }); }
			finally { flip?.(); }
			if (step) { showing = undefined; return void (await answer(ctx, skip + step + it.left + 1)); }
			if (!pick) { cardLog(deps.dir, close?.signal.aborted ? "picker closed by code" : "picker closed: esc", { id: it.id }); return; }
			cardLog(deps.dir, "pick", { id: it.id, pick });
			const text = pick === CARD_ELSE ? await ctx.ui.input("Your answer (or later / no / done)", "", { signal: close.signal }) : undefined;
			if (pick === CARD_ELSE && !text?.trim()) return;
			const to = targets[sendLabels.indexOf(pick)]?.id;
			const index = labels.indexOf(pick);
			const kind: CardAnswer = index >= 0 ? "choice" : pick === CARD_LATER ? "later" : pick === CARD_NO ? "no" : to ? "send" : "else";
			const choice = index >= 0 ? index : undefined;
			const via = await (deps.answer ?? answerViaHub)(it.id, { answer: kind, choice, ...(to ? { to } : {}), text });
			cardLog(deps.dir, "answer", { id: it.id, kind, choice, to, via, text });
			if (via === "gone") { ctx.ui.notify("That card was already answered.", "info"); return; }
			if (via !== "ok") {
				// No hub: answer here directly.
				const r = answerCard(it.id, kind, { choice, to, text, by: "mac", dir: deps.dir, live: await sessions().catch(() => []) });
				if (!r) { ctx.ui.notify("That card was already answered.", "info"); return; }
				if (r.here) pi.sendUserMessage(r.here, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				if (r.into) await (deps.handOff ?? handOff)(it.id, r.into);
			}
		} catch (e) { cardLog(deps.dir, "error", { id: it.id, error: String((e as Error)?.stack ?? e) }); throw e; }
		finally { showing = undefined; close = undefined; await check(ctx).catch(() => {}); }
	};
	pi.registerShortcut(CARD_KEY, { description: "Answer the waiting For you card", handler: async (ctx) => { if (isCoordinator(ctx)) await answer(ctx); } });
	// Pix's own loop prompts (card answers, handoffs) fold to one line on screen; the model still gets all of it.
	// Older loop prompts were stored as plain user messages: fold them the same way when drawn.
	pi.registerMarkdownTransformer?.((md, c) => {
		if (c.messageType !== "user") return md;
		const f = loopPromptSummary(md);
		return f ? `↳ loop **${f.title}**${f.you ? ` · you: ${f.you}` : ""}` : md;
	});
	pi.registerMessageRenderer(LOOP_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const s = (message.details ?? {}) as { title?: string; you?: string };
		const head = `${theme.fg("accent", "↳ loop")} ${theme.bold(s.title ?? "")}${s.you ? theme.fg("dim", `  · you: ${s.you}`) : ""}`;
		const box = new Box(outputPad, 0, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(expanded ? `${head}\n${theme.fg("dim", String(message.content))}` : head, 0, 0));
		return box;
	});
	pi.on("input", async (event, ctx) => {
		// brook's own short reply answers the waiting card; anything longer is a normal chat with For you.
		if (event.source === "interactive" && !event.images?.length && isCoordinator(ctx) && event.text.trim().length <= 20) {
			const it = currentCard(deps.dir, await sessions().catch(() => []));
			const r = it && cardReply(event.text, it.choices.length);
			if (it && r) {
				const via = await (deps.answer ?? answerViaHub)(it.id, r);
				if (via === "nohub") {
					const a = answerCard(it.id, r.answer, { ...r, by: "mac", dir: deps.dir, live: await sessions().catch(() => []) });
					if (a?.here) pi.sendUserMessage(a.here, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
					if (a?.into) await (deps.handOff ?? handOff)(it.id, a.into);
				}
				ctx.ui.notify(via === "gone" ? "That card was already answered." : `✓ ${it.title}`, "info");
				await check(ctx).catch(() => {});
				return { action: "handled" as const };
			}
		}
		if (event.source !== "extension" || event.images?.length) return { action: "continue" as const };
		const m = loopMessage(event.text);
		if (!m) return { action: "continue" as const };
		pi.sendMessage(m, { triggerTurn: true, deliverAs: event.streamingBehavior ?? "followUp" });
		return { action: "handled" as const };
	});
	pi.on("session_start", (_e, ctx) => {
		apply(ctx);
		clearInterval(timer);
		timer = setInterval(() => void check(ctx).catch(() => {}), deps.cardPollMs ?? 4000);
		timer.unref?.();
	});
	pi.on("agent_end", (_e, ctx) => void check(ctx).catch(() => {}));
	// Job tracking: a session that owns a loop reports where it stands on every turn end, without being asked.
	pi.on("agent_end", (event: any, ctx) => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			if (!id || id === forYouSession.id) return;
			const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
			const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
			trackTurn({ id, name: ctx?.sessionManager?.getSessionName?.() }, text, deps.dir);
		} catch { /* tracking never breaks a turn */ }
	});
	pi.on("session_start", (_e, ctx) => { shown = undefined; badged = undefined; void check(ctx).catch(() => {}); });
	pi.on("session_shutdown", () => { clearInterval(timer); close?.abort(); });
	pi.on("before_agent_start", async (event, ctx) => {
		apply(ctx);
		if (!isCoordinator(ctx)) return undefined;
		try { return { systemPrompt: `${event.systemPrompt}\n\n${coordinatorContext(deps.dir, await sessions())}` }; } catch { return undefined; }
	});
	// "@foryou:<id>" in any session: completion in the input box, and the full loop on send.
	pi.on("session_start", (_e, ctx) => { if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider?.(current => withForYou(current, () => readOpen())); });
	pi.on("input", (event, ctx) => {
		// "@" makes this session the loop's home: later taps on the loop come back here.
		let text = event.text;
		try { text = expandForYou(text, ctx?.sessionManager?.getSessionId?.() ?? "pi", undefined, ctx?.cwd); } catch { /* list unreadable: keep text */ }
		return text !== event.text ? { action: "transform", text } : { action: "continue" };
	});
}
