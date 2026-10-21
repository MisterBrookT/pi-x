// Privacy cover while brook uses the phone: see privacy-cover.swift. This side marks the phone as active
// (each relayed phone request pushes "until" ahead in ~/.pix/phone-active) and keeps the helper running.
// "In use" = the Pix page is open and visible on the phone. The page pings presence every 10 s while visible
// (also while brook just reads) and says "hidden" when he locks the phone or leaves the app, which clears the
// cover at once. If pings stop without a goodbye (iOS froze the page), it expires PIX_COVER_HOLD_SEC (45 s) later.
// Real Mac input lifts it at once.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "privacy-cover.swift");
export const phoneActivePath = () => process.env.PIX_PHONE_ACTIVE || join(homedir(), ".pix", "phone-active");
export const phoneActiveMs = (() => { const s = Number(process.env.PIX_COVER_HOLD_SEC); return (Number.isFinite(s) && s > 0 ? s : 45) * 1000; })();

/** Mark the phone active until now + phoneActiveMs. Writes at most every 5 s. Returns whether it wrote. */
let lastWrite = -Infinity;
export function markPhoneActive(now = Date.now(), path = phoneActivePath()): boolean {
	if (now - lastWrite < 5_000) return false;
	lastWrite = now;
	try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(now + phoneActiveMs)); return true; } catch { return false; }
}
/** The phone page went hidden (locked, other app): drop the cover now. */
export function markPhoneGone(path = phoneActivePath()): void {
	lastWrite = -Infinity;
	try { writeFileSync(path, "0"); } catch {}
}
/** What a relayed phone request says about use: presence pings carry "visible"/"hidden". */
export function phoneUse(path: string, method: string, body: string): "here" | "gone" {
	if (path.split("?")[0] === "/api/push" && method === "POST" && /"presence"\s*:\s*"hidden"/.test(body)) return "gone";
	if (/^\/api\/here\?v=0\b/.test(path)) return "gone";
	return "here";
}
/** For tests: forget the write throttle. */
export const resetPhoneActive = () => { lastWrite = -Infinity; };

/** Compile the helper once per source version into ~/.pix/bin. */
async function binary(): Promise<string | undefined> {
	if (process.platform !== "darwin" || !existsSync(source)) return undefined;
	const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
	const out = join(homedir(), ".pix", "bin", `pix-cover-${hash}`);
	if (existsSync(out)) return out;
	mkdirSync(dirname(out), { recursive: true });
	return new Promise(res => execFile("swiftc", ["-O", source, "-o", out], { timeout: 180_000 }, e => res(e ? undefined : out)));
}

/** Start the cover helper (no-op off macOS or with PIX_PRIVACY_COVER=0). Returns a stop function. */
export function startPrivacyCover(log: (s: string) => void = () => {}): () => void {
	if (process.env.PIX_PRIVACY_COVER === "0") return () => {};
	let child: ChildProcess | undefined, stopped = false;
	void binary().then(bin => {
		if (!bin || stopped) return;
		child = spawn(bin, [phoneActivePath()], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout?.on("data", d => log(`privacy cover: ${String(d).trim()}`));
		child.stderr?.on("data", d => log(String(d).trim()));
		child.on("exit", () => { child = undefined; });
	});
	// Stopping one hub's helper must not clear the shared phone-active mark: another Pi may be covering.
	return () => { stopped = true; child?.kill(); child = undefined; };
}
