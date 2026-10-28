// Pin docs, links and files a session made for brook to that session (see core/artifacts.ts).
// Agents call the `pin` tool; obvious cases (a Feishu doc created by lark-cli, a deploy URL) are pinned automatically.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openLoopIdsHeldBy } from "../core/pin-ended.ts";
import { artifactsLabel, detectArtifacts, loadArtifacts, pinArtifact, redactUrl, unpinArtifact } from "../core/artifacts.ts";

export default function (pi: ExtensionAPI) {
	let session = "";
	pi.on("session_start", (_e, ctx) => { session = ctx.sessionManager.getSessionId(); });

	pi.registerTool({
		name: "pin", label: "Pin",
		description: "Pin something you made or deployed for brook to this session so he can find it later: a doc you created, a deployed page, a file you wrote. Shows in the footer (\"Docs 2 · Links 3\") and on the phone. Use action=unpin with the url to remove.",
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("list")])),
			title: Type.Optional(Type.String({ maxLength: 120, description: "Short label, 1-3 words (Docs preview, PR #10), not a long title" })),
			url: Type.Optional(Type.String({ maxLength: 2000, description: "https URL or absolute/~ file path" })),
		}),
		async execute(_id, p, _signal, _update, ctx) {
			const id = session || ctx.sessionManager.getSessionId();
			const items = p.action === "list" || !p.url ? loadArtifacts(id) : p.action === "unpin" ? unpinArtifact(id, p.url) : pinArtifact(id, { title: p.title, url: p.url, loops: openLoopIdsHeldBy(id) });
			const text = items.length ? `${artifactsLabel(items)}\n${items.map(x => `- ${x.title}: ${redactUrl(x.url)}`).join("\n")}` : "Nothing pinned.";
			return { content: [{ type: "text", text }], details: { count: items.length } };
		},
	} as any);

	pi.on("tool_result", (event: any) => {
		if (event.isError || !session || event.toolName !== "bash") return;
		const out = (event.content ?? []).map((c: any) => c?.type === "text" ? c.text : "").join("\n");
		for (const a of detectArtifacts(String(event.input?.command ?? ""), out)) pinArtifact(session, { ...a, loops: openLoopIdsHeldBy(session) });
	});
}
