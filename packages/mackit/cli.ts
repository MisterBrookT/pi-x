#!/usr/bin/env node
// mackit status [--json] | prune [--dry-run|--yes] | reboot-plan [--json]. Prune is dry-run unless --yes.
import { formatPlan, formatStatus, pruneCandidates, rebootPlan, status } from "./index.ts";

const USAGE = "Usage: mackit status [--json] | prune [--dry-run|--yes] | reboot-plan [--json]\n";

export function main(argv: string[], out = (s: string) => process.stdout.write(s), kill = (pid: number) => process.kill(pid, "SIGTERM")): number {
	const [cmd, ...flags] = argv, json = flags.includes("--json");
	if (cmd === "status") { const s = status(); out(json ? `${JSON.stringify(s)}\n` : `${formatStatus(s)}\n`); return 0; }
	if (cmd === "reboot-plan") { const p = rebootPlan(); out(json ? `${JSON.stringify(p)}\n` : `${formatPlan(p)}\n`); return 0; }
	if (cmd === "prune") {
		const list = pruneCandidates(), yes = flags.includes("--yes");
		if (!list.length) { out("nothing to prune\n"); return 0; }
		for (const c of list) {
			let done = "";
			if (yes) { try { kill(c.pid); done = " stopped"; } catch (e: any) { done = ` failed: ${e?.code ?? e}`; } }
			out(`${c.pid} ${c.reason}${done}\n  ${c.command.slice(0, 120)}\n`);
		}
		if (!yes) out(`dry run, ${list.length} candidate(s). Run with --yes to stop them.\n`);
		return 0;
	}
	process.stderr.write(USAGE);
	return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
