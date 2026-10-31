import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatPlan, formatStatus, pruneCandidates, rebootPlan, status } from "../../packages/mackit/index.ts";

/** /mac [status|prune|prune --yes|reboot-plan]. Prune is a dry run unless --yes. */
export default function mac(pi: ExtensionAPI) {
	pi.registerCommand("mac", {
		description: "Mac health: status, prune (dry run, --yes to stop), reboot-plan",
		getArgumentCompletions: (prefix: string) =>
			["status", "prune", "prune --yes", "reboot-plan"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args: string, ctx: any) => {
			ctx.ui.notify(macText(args), "info");
		},
	});
}

export function macText(args: string, kill = (pid: number) => process.kill(pid, "SIGTERM")): string {
	const [cmd = "status", ...flags] = args.trim().split(/\s+/).filter(Boolean);
	if (cmd === "reboot-plan") return formatPlan(rebootPlan());
	if (cmd === "prune") {
		const list = pruneCandidates(), yes = flags.includes("--yes");
		if (!list.length) return "nothing to prune";
		const lines = list.map((c) => {
			let done = "";
			if (yes) { try { kill(c.pid); done = ", stopped"; } catch (e: any) { done = `, failed: ${e?.code ?? e}`; } }
			return `${c.pid} ${c.reason}${done}`;
		});
		return [...lines, yes ? `${list.length} stopped or tried` : `dry run, ${list.length} candidate(s). /mac prune --yes stops them.`].join("\n");
	}
	return formatStatus(status());
}
