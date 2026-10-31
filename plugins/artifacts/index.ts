// Pin docs, links and files a session made for brook to that session (see core/artifacts.ts).
// Agents call the `pin` tool; obvious cases (a Feishu doc created by lark-cli, a deploy URL) are pinned automatically.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lineOf, openLoopIdsHeldBy } from "../core/pin-ended.ts";
import { artifactsLabel, detectArtifacts, goodTitle, loadArtifacts, pinsFull, pinArtifact, redactUrl, unpinArtifact } from "../core/artifacts.ts";

export default function (pi: ExtensionAPI) {
	let session = "";
	pi.on("session_start", (_e, ctx) => { session = ctx.sessionManager.getSessionId(); });

	pi.registerTool({
		name: "pin", label: "Pin",
		description: "Pin something you made or deployed for brook to this session so he can find it later: a doc you created, a deployed page, a file you wrote. Shows in the footer and on the phone. At most 2 pins per session: a 3rd is refused and you get the 2 existing ones, so unpin one (action=unpin, url) and pin again, or skip. title is required: semantic, 1-3 words (\"Kairos docs\"), never an id, token, URL slug or cut-off sentence.",
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("list")])),
			title: Type.Optional(Type.String({ maxLength: 120, description: "Semantic label, 1-3 words (Kairos docs, PR #10); required to pin" })),
			url: Type.Optional(Type.String({ maxLength: 2000, description: "https URL or absolute/~ file path" })),
		}),
		async execute(_id, p, _signal, _update, ctx) {
			const id = session || ctx.sessionManager.getSessionId();
			const pin = p.action !== "list" && p.action !== "unpin" && !!p.url;
			if (pin && !goodTitle(p.title)) return { content: [{ type: "text", text: `Not pinned: give a semantic title of 1-3 words (e.g. "Kairos docs"), not an id, token, URL slug or cut-off sentence.` }], details: { refused: "title" } };
			const full = pin ? pinsFull(id, p.url!) : [];
			if (full.length) return { content: [{ type: "text", text: `Not pinned: this session already has ${full.length} pins (the most). Unpin one with action=unpin and its url, then pin again, or skip.\n${full.map(x => `- ${x.title}: ${redactUrl(x.url)}`).join("\n")}` }], details: { refused: "full", pins: full.map(x => ({ title: x.title, url: x.url })) } };
			const items = !pin ? (p.action === "unpin" && p.url ? unpinArtifact(id, p.url) : loadArtifacts(id)) : pinArtifact(id, { title: p.title, url: p.url!, loops: openLoopIdsHeldBy(id), line: lineOf(id) });
			const text = items.length ? `${artifactsLabel(items)}\n${items.map(x => `- ${x.title}: ${redactUrl(x.url)}`).join("\n")}` : "Nothing pinned.";
			return { content: [{ type: "text", text }], details: { count: items.length } };
		},
	} as any);

	pi.on("tool_result", (event: any) => {
		if (event.isError || !session || event.toolName !== "bash") return;
		const out = (event.content ?? []).map((c: any) => c?.type === "text" ? c.text : "").join("\n");
		// Auto-pins need a real title and room; otherwise they are skipped (never a token title, never a retire).
		for (const a of detectArtifacts(String(event.input?.command ?? ""), out)) if (goodTitle(a.title) && !pinsFull(session, a.url).length) pinArtifact(session, { ...a, loops: openLoopIdsHeldBy(session), line: lineOf(session) });
	});
}
