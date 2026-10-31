// Mac controls brook turns on by hand from the phone (Settings or a shortcut), never automatically:
// - cover: the privacy cover over the Mac's displays (privacy-cover.swift reads this file; real Mac input turns it off).
// - awake: keep the Mac from idle sleep while on (a caffeinate the hub owns). Default off.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HubPlugin } from "../core/hub-plugin.ts";

export interface MacControls { cover: boolean; awake: boolean }
export const controlsPath = () => process.env.PIX_MAC_CONTROLS || join(homedir(), ".pix", "mac-controls.json");

export function readControls(file = controlsPath()): MacControls {
	try { const j = JSON.parse(readFileSync(file, "utf8")); return { cover: j.cover === true, awake: j.awake === true }; } catch { return { cover: false, awake: false }; }
}
export function writeControls(patch: Partial<MacControls>, file = controlsPath()): MacControls {
	const next = { ...readControls(file), ...patch };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(next)); renameSync(tmp, file);
	return next;
}

export type Caffeinate = () => { kill(): void };
const realCaffeinate: Caffeinate = () => {
	// -i: no idle sleep, -w: ends with this hub. The display may still sleep.
	const c: ChildProcess = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
	c.on("error", () => {});
	return { kill: () => c.kill() };
};

export const macControlsRelayAllowed = (path: string, method: string) => path === "/api/mac" && (method === "GET" || method === "POST");

/** Phone: GET /api/mac reads, POST /api/mac {cover?, awake?} sets. */
export const macControlsHub = (opts: { file?: string; caffeinate?: Caffeinate } = {}): HubPlugin => () => {
	const file = opts.file ?? controlsPath(), start = opts.caffeinate ?? realCaffeinate;
	let held: { kill(): void } | undefined;
	const apply = (c: MacControls) => { if (c.awake && !held) held = start(); else if (!c.awake && held) { held.kill(); held = undefined; } return c; };
	apply(readControls(file));
	// /awake and /cover in any Pi write the file directly; follow it so caffeinate starts or stops within 2 s.
	const follow = setInterval(() => apply(readControls(file)), 2000); follow.unref?.();
	return {
		route(method, path, body) {
			if (path !== "/api/mac") return undefined;
			if (method === "GET") return { status: 200, body: apply(readControls(file)) };
			if (method !== "POST") return undefined;
			return (async () => {
				const b = await body(), patch: Partial<MacControls> = {};
				if (typeof b?.cover === "boolean") patch.cover = b.cover;
				if (typeof b?.awake === "boolean") patch.awake = b.awake;
				return { status: 200, body: apply(writeControls(patch, file)) };
			})();
		},
		close() { clearInterval(follow); held?.kill(); held = undefined; },
	};
};

/** `/awake [on|off]`, `/cover [on|off|toggle]`: no arg toggles. Returns the line to print, or an error. */
export function macCommand(key: keyof MacControls, arg: string, file = controlsPath()): { ok: boolean; text: string } {
	const a = arg.trim().toLowerCase(), label = key === "awake" ? "Keep awake" : "Mac cover";
	if (a && !["on", "off", "toggle", "status"].includes(a)) return { ok: false, text: `Usage: /${key} [on|off|toggle|status]` };
	const now = readControls(file);
	const c = a === "status" ? now : writeControls({ [key]: a === "on" ? true : a === "off" ? false : !now[key] }, file);
	return { ok: true, text: `${label} ${c[key] ? "on" : "off"}` };
}
