// Privacy cover over the Mac's displays: see privacy-cover.swift. Manual only: brook turns it on from phone
// Settings or its shortcut (mac-controls.ts writes ~/.pix/mac-controls.json); nothing on the phone turns it
// on by itself. Real Mac input turns it off again.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlsPath } from "./mac-controls.ts";

export const coverSource = join(dirname(fileURLToPath(import.meta.url)), "privacy-cover.swift");

/** Compile the helper once per source version into ~/.pix/bin. */
export async function coverBinary(): Promise<string | undefined> {
	if (process.platform !== "darwin" || !existsSync(coverSource)) return undefined;
	const hash = createHash("sha256").update(readFileSync(coverSource)).digest("hex").slice(0, 12);
	const out = join(homedir(), ".pix", "bin", `pix-cover-${hash}`);
	if (existsSync(out)) return out;
	mkdirSync(dirname(out), { recursive: true });
	return new Promise(res => execFile("swiftc", ["-O", coverSource, "-o", out], { timeout: 180_000 }, e => res(e ? undefined : out)));
}

/** Start the cover helper (no-op off macOS or with PIX_PRIVACY_COVER=0). Returns a stop function. */
export function startPrivacyCover(log: (s: string) => void = () => {}): () => void {
	if (process.env.PIX_PRIVACY_COVER === "0") return () => {};
	let child: ChildProcess | undefined, stopped = false;
	void coverBinary().then(bin => {
		if (!bin || stopped) return;
		child = spawn(bin, [controlsPath()], { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout?.on("data", d => log(`privacy cover: ${String(d).trim()}`));
		child.stderr?.on("data", d => log(String(d).trim()));
		child.on("exit", () => { child = undefined; });
	});
	// Stopping one hub's helper never changes the shared toggle: another Pi may be covering.
	return () => { stopped = true; child?.kill(); child = undefined; };
}
