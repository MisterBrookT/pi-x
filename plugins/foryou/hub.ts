import { hideLine, isAutonomy, setLineAutonomy } from "./proactive-lines.ts";
// For you's side of the phone hub: its list event, card fields on the For you session, and /api/foryou routes.
import { watchFile, unwatchFile } from "node:fs";
import type { HubPlugin } from "../core/hub-plugin.ts";
import { avatarFile, readFileOrUndefined, sourceIconFile } from "../core/avatarkit.ts";
import { paths as proactivePaths } from "./proactive.ts";
import { editMemoryLine, markMemorySeen, memoryUnseen, memoryView, removeMemoryLine } from "./proactive-memory.ts";
import { setItemAutonomy, contextSections, coordinatorContext, actItem, answerCard, startForYou, currentCard, waitingCards, forYouSession, dismissItem, doneItem, forYouView, laterItem, nowItem, type Card, type CardAnswer } from "./proactive-store.ts";

export interface ForYouHubOptions {
	/** Proactive list folder; defaults to ~/.pix/proactive. Tests inject a temp dir and launcher. */
	dir?: string;
	start?: (prompt: string) => Promise<unknown>;
	act?: (id: string, focus?: boolean, into?: string, cwd?: string) => Promise<unknown>;
}

export function avatarRoute(path: string): { status: number; body: unknown } {
	const enc = path.slice("/api/foryou/avatar/".length); let q: URLSearchParams; try { q = new URLSearchParams(Buffer.from(enc, "base64url").toString("utf8")); } catch { q = new URLSearchParams(); }
	const badge = q.get("badge");
	const f = badge ? sourceIconFile(badge) : q.get("name") ? avatarFile({ name: q.get("name")!.slice(0, 80), source: (q.get("source") || undefined) as any, id: q.get("id")?.slice(0, 80) || undefined }) : undefined;
	const b = readFileOrUndefined(f);
	return b && b.length < 900_000 ? { status: 200, body: { mimeType: f!.endsWith(".png") ? "image/png" : "image/jpeg", data: b.toString("base64") } } : { status: 404, body: { error: "no picture" } };
}

/** Phone requests the relay may forward for For you. */
export const forYouRelayAllowed = (path: string, method: string) =>
	method === "GET" && (path === "/api/foryou" || path === "/api/foryou/memory" || /^\/api\/foryou\/avatar\/[A-Za-z0-9_-]{1,400}$/.test(path)) || method === "POST" && (path === "/api/foryou/memory/seen" || path === "/api/foryou/memory/remove" || path === "/api/foryou/memory/edit") || method === "POST" && path === "/api/foryou/chat" || method === "POST" && /^\/api\/foryou\/[A-Za-z0-9_-]{1,40}\/(act|dismiss|later|done|now|card)$/.test(path) || method === "POST" && /^\/api\/foryou\/line\/[A-Za-z0-9_-]{1,60}\/(hide|autonomy)$/.test(path) || method === "GET" && path === "/api/foryou/context" || method === "POST" && /^\/api\/foryou\/[A-Za-z0-9_-]{1,40}\/autonomy$/.test(path);

export const forYouHub = (options: ForYouHubOptions = {}): HubPlugin => hub => {
	const dir = options.dir;
	const live = () => hub.liveSessions();
	// The page shows each loop with its real buttons and where each one goes (same as the card).
	const pdir = proactivePaths(dir).dir;
	const forYou = () => ({ ...forYouView(dir), cards: waitingCards(dir, live(), Date.now(), 50), memoryNew: memoryUnseen(pdir) });
	// The card: the oldest loop that needs brook, shown in the For you session (one at a time).
	let card: Card | undefined = currentCard(dir, live());
	let cards: Card[] = waitingCards(dir, live());
	let knownItems = new Set(forYou().pending.map(i => i.id));
	const onProactive = () => {
		const view = forYou(), list = view.pending;
		hub.publish("foryou", view);
		for (const it of list) if (!knownItems.has(it.id) && !it.quiet) hub.notify({ title: "For you", body: it.title, session: forYouSession.id, tag: `foryou-${it.id}`, foryou: true });
		knownItems = new Set(list.map(i => i.id));
		const before = JSON.stringify(cards); card = currentCard(dir, live()); cards = waitingCards(dir, live());
		if (before !== JSON.stringify(cards)) hub.refreshSession(forYouSession.id);
	};
	const inbox = proactivePaths(dir).inbox, health = proactivePaths(dir).health, memLog = proactivePaths(dir).memoryLog;
	watchFile(inbox, { interval: 2000 }, onProactive);
	watchFile(health, { interval: 5000 }, onProactive);
	watchFile(memLog, { interval: 3000 }, onProactive);
	// Parked loops come back by time, not by a file change: re-check every minute.
	const wake = setInterval(() => { if (forYou().pending.some(i => !knownItems.has(i.id))) onProactive(); }, 60_000);
	wake.unref();
	const failed = (error: unknown) => ({ status: 500, body: { error: `Could not start Pi: ${error instanceof Error ? error.message : String(error)}` } });

	return {
		initial: () => [["foryou", forYou()]],
		summary: id => id === forYouSession.id && card ? { card: true } : undefined,
		session: id => id === forYouSession.id && card ? { card, cards } : undefined,
		// A session joining can add a "Send to" button to the card.
		sessionJoined: id => { if (id !== forYouSession.id) onProactive(); },
		close: () => { unwatchFile(inbox, onProactive); unwatchFile(health, onProactive); unwatchFile(memLog, onProactive); clearInterval(wake); },
		async route(method, path, body) {
			if (method === "GET" && path === "/api/foryou") return { status: 200, body: forYou() };
			// A post's person photo or app badge, as JSON so it passes the relay. 404 = initials / no badge.
			if (method === "GET" && /^\/api\/foryou\/avatar\/[A-Za-z0-9_-]{1,400}$/.test(path)) return avatarRoute(path);
			// Memory: what For you learned, readable and removable by brook. Only the memory folder.
			if (method === "GET" && path === "/api/foryou/memory") return { status: 200, body: memoryView(pdir) };
			if (method === "POST" && path === "/api/foryou/memory/edit") {
				const input = await body().catch(() => ({})) as any;
				const ok = typeof input?.card === "string" && typeof input?.line === "string" && typeof input?.text === "string" && editMemoryLine(pdir, input.card, input.line.slice(0, 2000), input.text.slice(0, 2000));
				onProactive();
				return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "line not found" } };
			}
			// What For you sees now: each section of its injected prompt and its size.
			if (method === "GET" && path === "/api/foryou/context") return { status: 200, body: { sections: contextSections(coordinatorContext(dir, live())) } };
			if (method === "POST" && path === "/api/foryou/memory/seen") { markMemorySeen(pdir); onProactive(); return { status: 200, body: { ok: true } }; }
			if (method === "POST" && path === "/api/foryou/memory/remove") {
				const input = await body().catch(() => ({})) as any;
				const ok = typeof input?.card === "string" && typeof input?.line === "string" && removeMemoryLine(pdir, input.card, input.line.slice(0, 2000));
				onProactive();
				return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "line not found" } };
			}
			// The bell page's chat box: talk to For you (queued if it is open, else it starts with this message).
			if (method === "POST" && path === "/api/foryou/chat") {
				const text = String((await body().catch(() => ({})) as any)?.text ?? "").trim().slice(0, 8000);
				if (!text) return { status: 400, body: { error: "empty" } };
				try { if (!hub.queue(forYouSession.id, text)) await (options.start ?? startForYou)(text); } catch (error) { return failed(error); }
				return { status: 200, body: { ok: true } };
			}
			// A card answer (phone or Mac): first answer wins. Do it / Discuss / Something else run in For you;
			// a session button hands the loop to that session (live: queued there; "new": a session in its project).
			const cardMatch = path.match(/^\/api\/foryou\/([A-Za-z0-9_-]{1,40})\/card$/);
			if (method === "POST" && cardMatch) {
				const input = await body().catch(() => ({})) as any;
				const answer = String(input?.answer ?? "") as CardAnswer;
				const r = answerCard(cardMatch[1], answer, { choice: typeof input?.choice === "number" ? input.choice : undefined, to: typeof input?.to === "string" ? input.to : undefined, live: live(), text: typeof input?.text === "string" ? input.text : undefined, by: input?.by === "mac" ? "mac" : "phone", dir });
				if (!r) { onProactive(); return { status: 409, body: { error: "This card was already answered" } }; }
				try {
					if (r.here && !hub.queue(forYouSession.id, r.here)) await (options.start ?? startForYou)(r.here);
					if (r.into) await (options.act ?? ((x: string, _f?: boolean, i?: string) => actItem(x, { dir, send: hub.queue, live: live(), into: i })))(r.item.id, false, r.into, undefined);
				} catch (error) { onProactive(); return failed(error); }
				onProactive();
				return { status: 200, body: { ok: true } };
			}
			// Swipe away a stale line of work: retire it (hidden), like the judge does.
			const lm = method === "POST" && path.match(/^\/api\/foryou\/line\/([A-Za-z0-9_-]{1,60})\/hide$/);
			const am = method === "POST" && path.match(/^\/api\/foryou\/line\/([A-Za-z0-9_-]{1,60})\/autonomy$/);
			if (am) { const want = (await body().catch(() => ({})) as any)?.level; const v = setLineAutonomy(am[1], isAutonomy(want) ? want : undefined, dir); onProactive(); return v ? { status: 200, body: { autonomy: v } } : { status: 404, body: { error: "no such line" } }; }
			// The card's chip: brook changes a loop's level; For you hears it and re-routes.
			const im = method === "POST" && path.match(/^\/api\/foryou\/([A-Za-z0-9_-]{1,40})\/autonomy$/);
			if (im && im[1] !== "line") {
				const want = (await body().catch(() => ({})) as any)?.level;
				const r = setItemAutonomy(im[1], want, dir);
				if (!r) return { status: 404, body: { error: "no such loop" } };
				const msg = `[autonomy] brook set loop ${im[1]} to ${r.level}. Re-route it: do = start it now (or hand it to the owner) and report after; prepare = do the work, put the result on the card, wait for OK; discuss = stop any work on it and ask him first.`;
				try { if (!hub.queue(forYouSession.id, msg)) await (options.start ?? startForYou)(msg); } catch { /* For you will see it on its next turn */ }
				onProactive();
				return { status: 200, body: { autonomy: r.level } };
			}
			if (lm) { const ok = hideLine(lm[1], dir); onProactive(); return ok ? { status: 200, body: { ok } } : { status: 404, body: { error: "no such line" } }; }
			const m = path.match(/^\/api\/foryou\/([A-Za-z0-9_-]{1,40})\/(act|dismiss|later|done|now)$/);
			if (method !== "POST" || !m) return undefined;
			const input = await body().catch(() => ({})) as any;
			const [, id, verb] = m;
			if (verb !== "act") {
				const ok = ({ later: laterItem, dismiss: dismissItem, done: doneItem, now: nowItem } as const)[verb as "later"](id, dir);
				onProactive();
				return ok ? { status: 200, body: { ok } } : { status: 404, body: { error: "already handled" } };
			}
			try {
				const focus = input?.focus === true;
				// Phone and pill send nothing: the coordinator gets it. The coordinator's loops tool sends
				// `into` (a session id or "new") and maybe `cwd` to hand it on.
				const into = typeof input?.into === "string" && /^[\w.-]{1,80}$/.test(input.into) ? input.into : undefined;
				const cwd = typeof input?.cwd === "string" && (input.cwd.startsWith("/") || input.cwd.startsWith("~/")) ? input.cwd : undefined;
				const it = await (options.act ?? ((x, f, i, c) => actItem(x, { dir, send: hub.queue, focus: f, live: live(), into: i, cwd: c })))(id, focus, into, cwd);
				onProactive();
				return it ? { status: 202, body: { started: true, session: typeof (it as any).session === "string" ? (it as any).session : "" } } : { status: 404, body: { error: "already handled" } };
			} catch (error) { return failed(error); }
		},
	};
};
