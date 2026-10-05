// Act side of the proactive loop. The daemon (scripts/proactive-daemon.ts) writes alerts to
// ~/.pix/proactive/inbox.jsonl; this shows the pending count and lets brook act on one.
import { appendFileSync, existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { actPrompt, parseInbox, paths, type Item } from "../src/proactive.ts";

export default function proactiveExtension(pi: ExtensionAPI) {
	const P = paths();
	const load = (): Item[] => (existsSync(P.inbox) ? parseInbox(readFileSync(P.inbox, "utf8")) : []);
	const pending = () => load().filter(i => i.status === "pending");
	const mark = (id: string, status: Item["status"]) => appendFileSync(P.inbox, JSON.stringify({ id, status }) + "\n");
	const show = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const n = pending().length;
		ctx.ui.setStatus("pix-proactive", n ? `🔔 ${n} /proactive` : undefined);
	};
	let watching: ExtensionContext | undefined;
	const onChange = () => watching && show(watching);

	pi.on("session_start", (_e, ctx) => {
		show(ctx);
		if (ctx.hasUI) { watching = ctx; watchFile(P.inbox, { interval: 5000 }, onChange); }
	});
	pi.on("session_shutdown", () => { unwatchFile(P.inbox, onChange); watching = undefined; });

	pi.registerCommand("proactive", {
		description: "Act on proactive alerts (pending from the pix daemon)",
		handler: async (arg, ctx) => {
			const list = pending();
			if (!list.length) { ctx.ui.notify("No pending proactive alerts", "info"); return; }
			const pick = arg.trim() === "clear" ? "clear" : await ctx.ui.select("Proactive alerts", [...list.map(i => `${i.id}  ${i.title}  — ${i.why}`), "clear all"]);
			if (!pick) return;
			if (pick === "clear" || pick === "clear all") { list.forEach(i => mark(i.id, "dismissed")); show(ctx); return; }
			const it = list.find(i => pick.startsWith(i.id))!;
			const choice = await ctx.ui.select(it.title, ["Act: prepare the next step", "Dismiss"]);
			if (!choice) return;
			mark(it.id, choice.startsWith("Act") ? "done" : "dismissed");
			show(ctx);
			if (choice.startsWith("Act")) pi.sendUserMessage(actPrompt(it));
		},
	});
}
