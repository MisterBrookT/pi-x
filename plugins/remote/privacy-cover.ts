// Privacy cover while brook uses the phone: see privacy-cover.swift. This side marks the phone as active
// (each relayed phone request pushes "until" 60 s ahead in ~/.pix/phone-active) and keeps the helper running.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "privacy-cover.swift");
export const phoneActivePath = () => process.env.PIX_PHONE_ACTIVE || join(homedir(), ".pix", "phone-active");
export const phoneActiveMs = 60_000;

/** Mark the phone active until now + phoneActiveMs. Writes at most every 5 s. Returns whether it wrote. */
let lastWrite = -Infinity;
export function markPhoneActive(now = Date.now(), path = phoneActivePath()): boolean {
	if (now - lastWrite < 5_000) return false;
	lastWrite = now;
	try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(now + phoneActiveMs)); return true; } catch { return false; }
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
	return () => { stopped = true; child?.kill(); child = undefined; try { writeFileSync(phoneActivePath(), "0"); } catch {} };
}
