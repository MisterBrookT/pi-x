// Pix behavior settings: one small JSON file (~/.pix/behavior.json) that every plugin reads live,
// so a change in Settings (phone or Mac /behavior) applies to the next question, tick or idle check.
// The old env vars still work as the fallback when a setting was never changed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Knob { key: string; label: string; help: string; unit: string; env: string; def: number; min: number; max: number; /** Value that turns it off, shown as "Off". */ off?: number; choices: number[] }

/** The knobs brook can change. Order = order in Settings. */
export const KNOBS: Knob[] = [
	{ key: "questionTimeoutMin", label: "Questions auto-pick after", help: "If you don't answer, Pi takes the first option.", unit: "min", env: "PIX_QUESTION_TIMEOUT_MIN", def: 5, min: 0, max: 1440, off: 0, choices: [0, 2, 5, 15, 30] },
	{ key: "autoCloseHours", label: "Close idle sessions after", help: "A session with nothing open quits on its own; its history stays in Resume.", unit: "h", env: "PIX_AUTOCLOSE_HOURS", def: 24, min: 0, max: 720, off: 0, choices: [0, 6, 12, 24, 48, 168] },
	{ key: "fastBudget", label: "For you quick checks per hour", help: "How many times an hour For you may judge new messages right away.", unit: "", env: "PIX_FAST_BUDGET", def: 20, min: 0, max: 200, off: 0, choices: [0, 5, 10, 20, 40] },
];

export const behaviorFile = () => process.env.PIX_BEHAVIOR_FILE || join(homedir(), ".pix", "behavior.json");

export function readBehavior(file = behaviorFile()): Record<string, number> {
	try { const v = JSON.parse(readFileSync(file, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

/** The value in force: the settings file, else the env var, else the default. */
export function behavior(key: string, env: NodeJS.ProcessEnv = process.env, file = behaviorFile()): number {
	const k = KNOBS.find(x => x.key === key);
	if (!k) throw new Error(`unknown behavior ${key}`);
	const saved = existsSync(file) ? readBehavior(file)[key] : undefined;
	if (typeof saved === "number" && Number.isFinite(saved)) return clamp(k, saved);
	const raw = env[k.env];
	if (raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw))) return clamp(k, Number(raw));
	return k.def;
}
const clamp = (k: Knob, v: number) => Math.max(k.min, Math.min(k.max, v));

export function setBehavior(key: string, value: number, file = behaviorFile()): number {
	const k = KNOBS.find(x => x.key === key);
	if (!k || typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad setting");
	const all = { ...readBehavior(file), [key]: clamp(k, value) };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n"); renameSync(tmp, file);
	return all[key]!;
}

export const behaviorRows = (env: NodeJS.ProcessEnv = process.env, file = behaviorFile()) => KNOBS.map(k => ({ ...k, value: behavior(k.key, env, file) }));

/** "5 min", "Off", "24 h". */
export const behaviorLabel = (k: Knob, v: number) => k.off !== undefined && v === k.off ? (k.key === "questionTimeoutMin" ? "Off, wait" : "Off") : `${v}${k.unit ? " " + k.unit : ""}`;

import type { HubPlugin } from "./hub-plugin.ts";
/** Phone: GET /api/behavior lists the knobs; POST /api/behavior {key, value} saves one. */
export const behaviorRelayAllowed = (path: string, method: string) => path === "/api/behavior" && (method === "GET" || method === "POST");
export const behaviorHub = (): HubPlugin => () => ({
	route(method, path, body) {
		if (path !== "/api/behavior") return undefined;
		if (method === "GET") return { status: 200, body: { knobs: behaviorRows() } };
		if (method !== "POST") return undefined;
		return (async () => {
			const b = await body();
			try { return { status: 200, body: { key: b?.key, value: setBehavior(String(b?.key), Number(b?.value)), knobs: behaviorRows() } }; }
			catch { return { status: 400, body: { error: "unknown setting or value" } }; }
		})();
	},
});
