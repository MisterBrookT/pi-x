/**
 * WeChat through screen mode: the same runtime, guard, and confirm rules as
 * the `computer` tool, as a CLI for the wechat skill.
 *
 *   node wechat.ts find "<chat>"              exact contact/group match? opens nothing
 *   node wechat.ts prepare "<chat>" "<text>"  open the exact chat, check title, paste; does NOT send
 *   node wechat.ts send                       check title again, then Enter (routine reply or brook confirmed)
 *   node wechat.ts sendnow "<chat>" "<text>"  all in one (routine reply or brook confirmed): open, type, check title + box, Enter, read back
 *   node wechat.ts cancel                     clear the draft
 *
 * Exit: 0 ok, 2 blocked (locked / no window), 3 refused (no exact match / wrong chat).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetMismatchError, createCuaRuntime, type ComputerOperations } from "./computer-script.ts";
import { type ScreenCapture, type ScreenOperations, draftVisible, macScreenOperations, normalizeName } from "./computer-screen.ts";
import { APP, Refused, clearDraft as clear, openChat, signed } from "./recipes/wechat.ts";

export { Refused, signed };
const STATE = join(process.env.TMPDIR ?? tmpdir(), "wechat-send");
const PENDING = join(STATE, "pending");

const noBackend = new Proxy({}, {
	get: () => async () => {
		throw new Error("WeChat runs in screen mode only.");
	},
}) as ComputerOperations;

const open = openChat;
const clearDraft = (screen: ScreenOperations) => clear(screen);

/** Why a WeChat capture is not WeChat (no sidebar Search box), or "" when it looks right. */
export const ocrProblem = (c: ScreenCapture): string => {
	if (!c.lines.length) return "OCR read nothing";
	const search = c.lines.some((l) => /^(search|搜索)$/i.test(l.text.trim()) && l.x < c.window.w * 0.45 && l.y < 80);
	return search ? "" : `no Search box in the WeChat window; OCR read: ${c.lines.slice(0, 4).map((l) => l.text).join(" / ").slice(0, 80)}`;
};

export const runWeChat = async (argv: string[], screen: ScreenOperations, out: (line: string) => void): Promise<number> => {
	const [mode, rawChat, text] = argv;
	// The CLI is the confirmation: brook approved recipient + text before `send`.
	const { cua } = createCuaRuntime({ operations: noBackend, screen, confirm: async () => mode === "send" || mode === "sendnow" });
	mkdirSync(STATE, { recursive: true });
	try {
		if (mode === "check") {
			// Read-only health check: one capture, no activate, no keys. Junk OCR (the privacy-cover wallpaper read,
			// "StU/Font/eCrazU", 10-28) fails loudly instead of every exact-name search being refused.
			const why = ocrProblem(await screen.capture(APP));
			if (why) { out(`[BLOCKED] WeChat screen read is broken: ${why}`); return 2; }
			out("[OK] WeChat screen read looks right");
			return 0;
		}
		if (mode === "find") {
			await cua.recipe("wechat-find", { to: rawChat });
			out(`[FOUND] exact '${normalizeName(rawChat ?? "")}' (not opened)`);
			return 0;
		}
		if (mode === "prepare") {
			const chat = normalizeName(rawChat ?? "");
			if (!chat || !text) throw new Error("usage: prepare <chat> <text>");
			const msg = signed(text);
			let s = await open(cua, screen, chat);
			await clearDraft(screen);
			s = await s.act({ action: "typeText", text: msg });
			writeFileSync(PENDING, `${chat}\n${msg}`);
			out(`[PREPARED] draft pasted in '${chat}', not sent.`);
			out("Confirm recipient + exact text with brook, then: send");
			return 0;
		}
		// One call, focus held once: open → type → check title + input box → Enter → read back.
		// Only for a recipient and text brook has already confirmed.
		if (mode === "sendnow") {
			if (!normalizeName(rawChat ?? "") || !text) throw new Error("usage: sendnow <chat> <text>");
			const r = (await cua.recipe("wechat-send", { to: rawChat, text })) as { readBack: boolean; chat: string };
			out(r.readBack ? `[SENT] '${r.chat}': read back in the chat, input box empty.` : `[SENT?] Enter pressed in '${r.chat}', but the read-back did not find the message. Check WeChat.`);
			return r.readBack ? 0 : 4;
		}
		if (mode === "send") {
			if (!existsSync(PENDING)) {
				out("[BLOCKED] nothing prepared");
				return 2;
			}
			const chat = readFileSync(PENDING, "utf8").split("\n")[0];
			const msg = readFileSync(PENDING, "utf8").split("\n").slice(1).join("\n");
			const s = await cua.observe({ app: APP, mode: "screen" });
			if (msg && !draftVisible(await screen.capture(APP), msg)) {
				await clearDraft(screen);
				throw new TargetMismatchError(`the input box no longer shows the prepared text. Draft cleared, nothing sent.`);
			}
			try {
				await s.act({ action: "keypress", keys: ["Enter"] }, undefined, { target: { title: chat } });
			} catch (error) {
				if (error instanceof TargetMismatchError) await clearDraft(screen);
				throw error;
			} finally {
				rmSync(PENDING, { force: true });
			}
			out(`[SENT?] Enter pressed in chat '${chat}'. Verify with a read-back.`);
			return 0;
		}
		if (mode === "cancel") {
			await cua.observe({ app: APP, mode: "screen" });
			await clearDraft(screen);
			rmSync(PENDING, { force: true });
			out("[CANCELLED] draft cleared");
			return 0;
		}
		out("usage: check | find <chat> | prepare <chat> <text> | send | cancel");
		return 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Refused || error instanceof TargetMismatchError) {
			rmSync(PENDING, { force: true });
			out(`[REFUSED] ${message}`);
			return 3;
		}
		out(`[BLOCKED] ${message}`);
		return 2;
	}
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const screen = macScreenOperations();
	let previous = "";
	try {
		const { execFileSync } = await import("node:child_process");
		previous = execFileSync("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true']).toString().trim();
	} catch {}
	const code = await runWeChat(process.argv.slice(2), screen, (line) => console.log(line));
	if (previous && previous !== APP) {
		const { execFileSync } = await import("node:child_process");
		try {
			execFileSync("osascript", ["-e", `tell application ${JSON.stringify(previous)} to activate`]);
		} catch {}
	}
	process.exit(code);
}
