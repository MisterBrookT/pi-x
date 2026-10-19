/**
 * Guard for apps whose data macOS can seal (WeChat, DingTalk): a locked Mac or an unanswered privacy prompt
 * makes every read hang. Probe first, in a child that is killed after a few seconds, and skip the source with a
 * clear reason instead of hanging and leaving readers behind. Also clean up reader daemons that piled up.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const appData: Record<string, string> = {
	wechat: join(homedir(), "Library/Containers/com.tencent.xinWeChat/Data/Documents"),
	dingtalk: join(homedir(), "Library/Containers/5ZSL2CJU2T.com.dingtalk.mac/Data"),
};

export type Access = "ok" | "sealed" | "missing";
export interface ProbeDeps { list?: (dir: string, timeoutMs: number) => Promise<"ok" | "timeout" | "missing">; locked?: () => Promise<boolean> }

const listDir = async (dir: string, timeoutMs: number) => {
	try { await run("/bin/ls", [dir], { timeout: timeoutMs, killSignal: "SIGKILL" }); return "ok" as const; }
	catch (e: any) { return e?.killed || e?.signal ? "timeout" as const : "missing" as const; }
};

/** Can this app's data be read right now? "sealed" = it hangs (locked Mac or a pending macOS prompt). */
export async function probeApp(app: keyof typeof appData | string, d: ProbeDeps = {}, timeoutMs = 6000): Promise<Access> {
	const dir = appData[app];
	if (!dir) return "ok";
	const r = await (d.list ?? listDir)(dir, timeoutMs);
	return r === "ok" ? "ok" : r === "timeout" ? "sealed" : "missing";
}

/** The reason shown in the log and on For you's health line. */
export function sealedReason(app: string, locked: boolean): string {
	const name = app === "wechat" ? "WeChat" : app === "dingtalk" ? "DingTalk" : app;
	return locked
		? `${name} data is sealed while the Mac is locked; skipped this round`
		// "Allow" on the prompt lasts only until the checker restarts; Full Disk Access is the lasting fix.
		: `${name} data is blocked: give "Pix Proactive" Full Disk Access (System Settings → Privacy & Security), once; "Allow" on the prompt only lasts until it restarts`;
}

/**
 * wx-cli starts a daemon per failed read; when reads hang they pile up (97 seen). Keep at most one, the newest,
 * and kill any older than maxAgeSec. Returns how many were killed.
 */
export async function reapWxDaemons(maxAgeSec = 900, d: { ps?: () => Promise<string>; kill?: (pid: number) => void } = {}): Promise<number> {
	const ps = d.ps ?? (async () => (await run("/bin/ps", ["-axo", "pid=,etimes=,command="], { maxBuffer: 1 << 22 })).stdout);
	const kill = d.kill ?? ((pid: number) => { try { process.kill(pid, "SIGKILL"); } catch {} });
	const rows = (await ps().catch(() => "")).split("\n").map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
		.map(m => ({ pid: Number(m![1]), age: Number(m![2]), cmd: m![3] })).filter(r => /wx-cli[^ ]*\/bin\/wx(\s|$)/.test(r.cmd));
	rows.sort((a, b) => a.age - b.age);
	const doomed = rows.filter((r, i) => i > 0 || r.age > maxAgeSec);
	for (const r of doomed) kill(r.pid);
	return doomed.length;
}
