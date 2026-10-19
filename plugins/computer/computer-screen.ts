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
	/** One chord, e.g. ["cmd", "f"] or ["Enter"]. */
	keys(keys: string[]): Promise<void>;
	/** Type text through the clipboard (restored afterwards). Works for any script, incl. CJK. */
	paste(text: string): Promise<void>;
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

/** Build a small Swift helper once (rebuilt when its source changes). */
const helper = async (name: "ocr" | "click"): Promise<string> => {
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
	return {
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
			const bounds = (await osa(`tell application "System Events" to tell process ${JSON.stringify(app)} to get {position, size} of window 1`)).replace(/\s/g, "");
			const [x, y, w, h] = bounds.split(",").map(Number);
			shots += 1;
			const image = join(dir, `shot-${shots}.png`);
			await run("screencapture", ["-x", `-R${x},${y},${w},${h}`, image]);
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
		async keys(keys) {
			await osa(keystrokeScript(keys));
		},
		async paste(text) {
			const old = await run("pbpaste", []).catch(() => "");
			await run("pbcopy", [], text);
			await osa(keystrokeScript(["cmd", "v"]));
			await new Promise((r) => setTimeout(r, 400));
			await run("pbcopy", [], old);
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
