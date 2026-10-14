// Runs readDingTalk in a child process so a blocked macOS app-data read (TCC prompt, hung scandir/open)
// cannot freeze the proactive daemon. The parent owns the temp dir, so cleanup still happens after SIGKILL.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDingTalk, type DingChat } from "./dingtalk-local.ts";

export const dingWorkerTimeoutMs = 60_000;
const self = fileURLToPath(import.meta.url);

export function readDingTalkIsolated(root?: string, account?: string, opts: { timeoutMs?: number; workerPath?: string } = {}): Promise<DingChat[]> {
	const timeoutMs = opts.timeoutMs ?? dingWorkerTimeoutMs;
	const dir = mkdtempSync(join(tmpdir(), "pix-dingtalk-"));
	return new Promise<DingChat[]>((resolve, reject) => {
		const child = spawn(process.execPath, [opts.workerPath ?? self, "--dingtalk-worker", dir, root ?? "", account ?? ""], { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [], err: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
		child.stdout.on("data", b => out.push(b));
		child.stderr.on("data", b => err.push(b));
		child.on("error", e => { clearTimeout(timer); reject(new Error(`DingTalk reader failed to start: ${e.message}`)); });
		child.on("close", code => {
			clearTimeout(timer);
			if (timedOut) return reject(new Error(`DingTalk local read timed out after ${timeoutMs}ms; grant pix App Data / Full Disk Access permission for DingTalk`));
			if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim().split("\n").pop() || `DingTalk reader exited with code ${code}`));
			try { resolve(JSON.parse(Buffer.concat(out).toString())); } catch { reject(new Error("DingTalk reader returned invalid output")); }
		});
	}).finally(() => rmSync(dir, { recursive: true, force: true }));
}

if (process.argv[1] === self && process.argv[2] === "--dingtalk-worker") {
	const [, , , dir, root, account] = process.argv;
	try {
		process.stdout.write(JSON.stringify(readDingTalk(root || undefined, account || undefined, dir)));
	} catch (e) {
		// Only the message: never a stack or data that might include decrypted content.
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exitCode = 1;
	}
}
