/**
 * WeChat and DingTalk data is sealed while the Mac is locked, so the checker unlocks it first,
 * typing the Mac login brook saved in Keychain for the phone's Mac screen. The password only
 * goes through an environment variable to osascript; it is never logged or put in a prompt.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function isLocked(): Promise<boolean> {
	try {
		const { stdout } = await run("ioreg", ["-n", "Root", "-d1", "-a"], { timeout: 10_000, maxBuffer: 4 << 20 });
		return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(stdout);
	} catch { return false; }
}

export interface UnlockDeps { locked?: () => Promise<boolean>; password?: () => Promise<string | undefined>; type?: (password: string) => Promise<void>; wait?: (ms: number) => Promise<void> }

/** "open" (was not locked), "unlocked", "no-login" (nothing saved), or "failed". */
export async function ensureUnlocked(d: UnlockDeps = {}): Promise<"open" | "unlocked" | "no-login" | "failed"> {
	const locked = d.locked ?? isLocked;
	const wait = d.wait ?? (ms => new Promise(r => setTimeout(r, ms)));
	if (!(await locked())) return "open";
	const pass = await (d.password ?? savedPassword)();
	if (!pass) return "no-login";
	await (d.type ?? typePassword)(pass);
	await wait(4000);
	return (await locked()) ? "failed" : "unlocked";
}

async function typePassword(password: string): Promise<void> {
	await run("caffeinate", ["-u", "-t", "2"]).catch(() => {});
	await new Promise(r => setTimeout(r, 1500));
	await run("osascript", ["-e", 'tell application "System Events" to keystroke (system attribute "PIX_UNLOCK")', "-e", "delay 0.3", "-e", 'tell application "System Events" to key code 36'],
		{ env: { ...process.env, PIX_UNLOCK: password }, timeout: 20_000 }).catch(() => {});
}

/** The Mac login item the phone's Mac screen saves (desktop plugin): JSON {username,password}. */
async function savedPassword(): Promise<string | undefined> {
	try {
		const { stdout } = await run("security", ["find-generic-password", "-s", "fun.brooktang.pix.desktop", "-w"], { timeout: 10_000 });
		const v = JSON.parse(stdout.trim());
		return typeof v?.password === "string" && v.password ? v.password : undefined;
	} catch { return undefined; }
}
