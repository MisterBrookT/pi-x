/**
 * Screen mode: apps that publish no accessibility tree (WeChat 4.x, games,
 * canvas apps) are read with OCR and driven with real mouse and key events.
 *
 * A screen state lists OCR lines as `@t` refs with window-relative centers, so
 * a script can click by ref exactly like an AX element. Coordinates are in
 * points, window-relative; `click` converts to absolute screen points.
 *
 * Pure helpers are separate from the macOS implementation so the rules (title
 * match, line refs, key mapping) are tested without a screen.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScreenLine {
	text: string;
	/** Window-relative, points. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ScreenCapture {
	app: string;
	window: { x: number; y: number; w: number; h: number };
	lines: ScreenLine[];
	/** Path of the window screenshot. */
	image?: string;
}

export interface ScreenOperations {
	/** Bring the app forward; must refuse when the screen is locked or the app has no window. */
	activate(app: string): Promise<void>;
	capture(app: string): Promise<ScreenCapture>;
	/** Absolute screen points. */
	click(x: number, y: number): Promise<void>;
	/** One chord, e.g. ["cmd", "f"] or ["Enter"]. Sent to the app's process, so it need not be in front. */
	keys(keys: string[], app?: string): Promise<void>;
	/** Type text through the clipboard (every type saved and restored). Works for any script, incl. CJK. */
	paste(text: string, app?: string): Promise<void>;
	/** True when keys and paste reach `app` in the background, so only clicks and captures need it in front. */
	background?: boolean;
	sleep?(ms: number): Promise<void>;
}

/** Strip stray carriage returns and outer whitespace: names copied from chat exports carry `\r`. */
export const normalizeName = (value: string): string => value.replace(/\r/g, "").trim();

/** Header band height (points): window titles and chat titles sit here. */
export const HEADER_BAND = 50;

/** OCR lines inside the header band, top to bottom. */
export const headerLines = (capture: ScreenCapture, band = HEADER_BAND): ScreenLine[] =>
	capture.lines.filter((line) => line.y < band && line.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * The target title must appear as one exact header line. Exact, not
 * substring: "VAG 报销小分队" must never satisfy "浙大 李老师 报销", and a group
 * title with a member count, "Name(73)", is not the private chat "Name".
 */
export const titleMatches = (capture: ScreenCapture, title: string): boolean => {
	const want = normalizeName(title);
	return headerLines(capture).some((line) => normalizeName(line.text) === want);
};

const center = (line: ScreenLine) => ({ x: Math.round(line.x + line.w / 2), y: Math.round(line.y + line.h / 2) });

/** The outline a screen state shows the model: one `@tN "text" (x,y)` per OCR line. */
export const screenOutline = (capture: ScreenCapture): string => {
	const head = `screen ${JSON.stringify(capture.app)} window ${capture.window.w}x${capture.window.h} (no accessibility tree; OCR lines, window-relative points)`;
	const rows = capture.lines.map((line, index) => {
		const c = center(line);
		return `@t${index + 1} ${JSON.stringify(line.text)} (${c.x},${c.y})`;
	});
	return [head, ...rows].join("\n");
};

/** Resolve a `@tN` ref to its line. */
export const lineForRef = (capture: ScreenCapture, ref: string): ScreenLine | undefined => {
	const match = /^@t(\d+)$/.exec(ref);
	return match ? capture.lines[Number(match[1]) - 1] : undefined;
};

/** Absolute screen point for a ref or window-relative x/y. */
export const pointFor = (capture: ScreenCapture, at: { ref?: string; x?: number; y?: number }) => {
	if (at.ref) {
		const line = lineForRef(capture, at.ref);
		if (!line) throw new Error(`Unknown screen ref ${at.ref}; look again.`);
		const c = center(line);
		return { x: capture.window.x + c.x, y: capture.window.y + c.y };
	}
	if (at.x === undefined || at.y === undefined) throw new Error("Screen click needs a @t ref or window-relative x/y.");
	return { x: capture.window.x + at.x, y: capture.window.y + at.y };
};

/** Keys that commit something in a chat or form: treated as irreversible in screen mode. */
export const COMMIT_KEYS = /^(enter|return|kp_enter)$/i;

// ---------------------------------------------------------------- macOS

const run = (file: string, args: string[], input?: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = execFile(file, args, { timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${file} failed: ${String(stderr || error.message).trim()}`));
			else resolve(stdout);
		});
		if (input !== undefined) child.stdin?.end(input);
	});

const osa = (...lines: string[]) => run("osascript", lines.flatMap((line) => ["-e", line]));

const NATIVE = join(dirname(fileURLToPath(import.meta.url)), "native");
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pix-computer");

/**
 * The app's main window from System Events' flat "x,y,w,h,…" list of every window: the largest. Window 1 can be a
 * small pop-up (10-28: WeChat's 84×77 float came first, so OCR read nothing).
 */
export const mainWindow = (flat: string): [number, number, number, number] => {
	const n = flat.split(",").map(Number);
	const count = Math.floor(n.length / 4);
	// System Events lists all positions first, then all sizes, when asked for {position, size} of every window.
	let best: [number, number, number, number] = [n[0], n[1], n[2 * count] ?? n[2], n[2 * count + 1] ?? n[3]];
	for (let i = 0; i < count; i += 1) {
		const c: [number, number, number, number] = [n[2 * i], n[2 * i + 1], n[2 * count + 2 * i], n[2 * count + 2 * i + 1]];
		if (c[2] * c[3] > best[2] * best[3]) best = c;
	}
	return best;
};

/** Build a small Swift helper once (rebuilt when its source changes). */
const helper = async (name: "ocr" | "click" | "keys" | "clip" | "appshot"): Promise<string> => {
	const src = join(NATIVE, `${name}.swift`);
	const bin = join(CACHE, name);
	if (!existsSync(bin) || statSync(src).mtimeMs > statSync(bin).mtimeMs) {
		mkdirSync(CACHE, { recursive: true });
		await run("swiftc", ["-O", "-o", bin, src]);
	}
	return bin;
};

const KEY_CODES: Record<string, number> = { enter: 36, return: 36, escape: 53, esc: 53, backspace: 51, delete: 51, tab: 48, space: 49, up: 126, down: 125, left: 123, right: 124 };
const MODIFIERS: Record<string, string> = { cmd: "command down", command: "command down", shift: "shift down", alt: "option down", option: "option down", ctrl: "control down", control: "control down" };

/** One chord as `keys <pid> code …` arguments, for posting to a process in the background. */
export const keyArgs = (keys: string[]): string[] => {
	const mods = keys.map((k) => k.toLowerCase()).filter((k) => MODIFIERS[k]).map((k) => ({ command: "cmd", option: "alt", control: "ctrl" })[k] ?? k);
	const main = keys.filter((k) => !MODIFIERS[k.toLowerCase()]);
	if (main.length !== 1) throw new Error(`A key chord needs exactly one non-modifier key: ${keys.join("+")}`);
	const key = main[0].toLowerCase();
	const code = KEY_CODES[key] ?? LETTER_CODES[key];
	if (code === undefined) throw new Error(`No key code for ${main[0]}`);
	return ["code", String(code), ...mods];
};

/** US-layout virtual key codes for letters and digits used in chords (cmd+a, cmd+v, cmd+f …). */
const LETTER_CODES: Record<string, number> = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46 };

/** One chord as an AppleScript System Events line. */
export const keystrokeScript = (keys: string[]): string => {
	const mods = keys.filter((k) => MODIFIERS[k.toLowerCase()]).map((k) => MODIFIERS[k.toLowerCase()]);
	const main = keys.filter((k) => !MODIFIERS[k.toLowerCase()]);
	if (main.length !== 1) throw new Error(`A key chord needs exactly one non-modifier key: ${keys.join("+")}`);
	const key = main[0];
	const using = mods.length ? ` using {${mods.join(", ")}}` : "";
	const code = KEY_CODES[key.toLowerCase()];
	return code !== undefined
		? `tell application "System Events" to key code ${code}${using}`
		: `tell application "System Events" to keystroke ${JSON.stringify(key.toLowerCase())}${using}`;
};

const pngWidth = (path: string): number => readFileSync(path).readUInt32BE(16);

export const macScreenOperations = (): ScreenOperations => {
	const dir = mkdtempSync(join(tmpdir(), "pix-screen-"));
	let shots = 0;
	const pids = new Map<string, string>();
	const pidOf = async (app: string) => {
		const known = pids.get(app);
		if (known) return known;
		const pid = (await osa(`tell application "System Events" to get unix id of first process whose name is ${JSON.stringify(app)}`)).trim();
		if (!/^\d+$/.test(pid)) throw new Error(`${app} is not running.`);
		pids.set(app, pid);
		return pid;
	};
	/** Keys go to the app's process (works while it is behind; verified with WeChat 4.x), else the front app. */
	const chord = async (keys: string[], app?: string) => {
		if (app) await run(await helper("keys"), [await pidOf(app), ...keyArgs(keys)]);
		else await osa(keystrokeScript(keys));
	};
	return {
		background: true,
		async activate(app) {
			const click = await helper("click");
			const locked = await run(click, ["locked"]).then(() => true, () => false);
			if (locked) throw new Error("The Mac screen is locked; screen-mode apps cannot be read.");
			await osa(`tell application ${JSON.stringify(app)} to reopen`, `tell application ${JSON.stringify(app)} to activate`);
			for (let i = 0; i < 10; i += 1) {
				const front = (await osa('tell application "System Events" to get name of first process whose frontmost is true')).trim();
				if (front === app) return;
				await new Promise((r) => setTimeout(r, 300));
			}
			throw new Error(`${app} did not come to the front.`);
		},
		async capture(app) {
			// A background window captures blank, so read the region while the app is frontmost.
			const all = (await osa(`tell application "System Events" to tell process ${JSON.stringify(app)} to get {position, size} of every window`)).replace(/\s/g, "");
			const [x, y, w, h] = mainWindow(all);
			shots += 1;
			const image = join(dir, `shot-${shots}.png`);
			// The app's own windows, so the Pix privacy cover (which hides the screen) cannot blank the picture; else the region.
			const own = await run(await helper("appshot"), [await pidOf(app), String(x), String(y), String(w), String(h), image]).then(() => true, () => false);
			if (!own) await run("screencapture", ["-x", `-R${x},${y},${w},${h}`, image]);
			const scale = pngWidth(image) / w;
			const ocr = await helper("ocr");
			const lines = (await run(ocr, [image]))
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as ScreenLine)
				.map((l) => ({ text: normalizeName(l.text), x: Math.round(l.x / scale), y: Math.round(l.y / scale), w: Math.round(l.w / scale), h: Math.round(l.h / scale) }))
				.sort((a, b) => a.y - b.y || a.x - b.x);
			return { app, window: { x, y, w, h }, lines, image };
		},
		async click(x, y) {
			// System Events "click at" is refused by some apps (WeChat: -25208); post a real HID click.
			await run(await helper("click"), [String(Math.round(x)), String(Math.round(y))]);
		},
		async keys(keys, app) {
			await chord(keys, app);
		},
		async paste(text, app) {
			// Save every pasteboard item and type (images, files, rich text), not just plain text.
			const clip = await helper("clip");
			const saved = join(dir, `clip-${Date.now()}.plist`);
			const kept = await run(clip, ["save", saved]).then(() => true, () => false);
			try {
				await run("pbcopy", [], text);
				await chord(["cmd", "v"], app);
				await new Promise((r) => setTimeout(r, 400));
			} finally {
				if (kept) await run(clip, ["restore", saved]).catch(() => {});
			}
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	};
};

// ---------------------------------------------------------------- WeChat search

const RESULT_SECTIONS = new Set(["contacts", "group chats", "联系人", "群聊", "最常使用", "most used", "frequently used", "top hits"]);
const OTHER_SECTIONS = new Set(["internet search results", "chat history", "搜索网络结果", "聊天记录", "official accounts", "公众号", "mini programs", "小程序", "more", "更多"]);

/**
 * The search result that reads exactly `name` under a Contacts / Group Chats /
 * Most used header, never the first hit, never web or chat-history rows.
 */
export const pickExactResult = (capture: ScreenCapture, name: string): ScreenLine | undefined => {
	const want = normalizeName(name);
	const key = (line: ScreenLine) => line.text.trim().toLowerCase();
	const heads = capture.lines.filter((l) => RESULT_SECTIONS.has(key(l)) || OTHER_SECTIONS.has(key(l)) || key(l).startsWith("view all"));
	const section = (line: ScreenLine) => {
		const above = heads.filter((h) => h.y < line.y && Math.abs(h.x - line.x) < 120);
		return above.length ? key(above.reduce((a, b) => (b.y > a.y ? b : a))) : "";
	};
	return capture.lines
		.filter((l) => normalizeName(l.text) === want && l.x < capture.window.w * 0.45 && l.y > 30 && RESULT_SECTIONS.has(section(l)))
		.sort((a, b) => a.y - b.y)[0];
};

/**
 * OCR lines that nearly match `name`, best first: one contains the other, or they share most characters.
 * Shown when an exact match fails, so the caller can correct a name instead of guessing.
 */
export const nearMisses = (capture: ScreenCapture, name: string, limit = 3): string[] => {
	const want = normalizeName(name);
	const chars = new Set([...want.replace(/\s+/g, "")]);
	if (!chars.size) return [];
	const scored = new Map<string, number>();
	for (const line of capture.lines) {
		const text = normalizeName(line.text);
		if (!text || text === want || text.length > want.length * 3 + 8) continue;
		const own = new Set([...text.replace(/\s+/g, "")]);
		const shared = [...chars].filter((c) => own.has(c)).length;
		const score = text.includes(want) || want.includes(text) ? 1 + shared / chars.size : shared / Math.max(chars.size, own.size);
		if (score >= 0.5) scored.set(text, Math.max(scored.get(text) ?? 0, score));
	}
	return [...scored].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
};

export const firstLine = (text: string) => normalizeName(text.split("\n").find((l) => l.trim()) ?? "");
/** The typed text's first line is on screen in the lower (input) part of the window. */
export const draftVisible = (capture: ScreenCapture, text: string): boolean => {
	const want = firstLine(text).replace(/\s+/g, "");
	if (!want) return true;
	const probe = want.slice(0, 12);
	return capture.lines.some((l) => l.y > capture.window.h * 0.75 && l.text.replace(/\s+/g, "").includes(probe));
};
