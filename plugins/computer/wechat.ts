/**
 * WeChat through screen mode: the same runtime, guard, and confirm rules as
 * the `computer` tool, as a CLI for the wechat skill.
 *
 *   node wechat.ts find "<chat>"              exact contact/group match? opens nothing
 *   node wechat.ts prepare "<chat>" "<text>"  open the exact chat, check title, paste; does NOT send
 *   node wechat.ts send                       check title again, then Enter (brook confirmed already)
 *   node wechat.ts cancel                     clear the draft
 *
 * Exit: 0 ok, 2 blocked (locked / no window), 3 refused (no exact match / wrong chat).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetMismatchError, createCuaRuntime, type ComputerOperations, type CuaApi } from "./computer-script.ts";
import { type ScreenOperations, macScreenOperations, normalizeName, pickExactResult, titleMatches } from "./computer-screen.ts";

const APP = "WeChat";
const STATE = join(process.env.TMPDIR ?? tmpdir(), "wechat-send");
const PENDING = join(STATE, "pending");

/** Same rule as Feishu: every outbound message ends with its own signature line. */
export const signed = (text: string): string => {
	const sig = /[\u4e00-\u9fa5]/.test(text) ? "这条消息来自 brook 的 agent。" : "Sent by brook's agent.";
	return text.endsWith(sig) ? text : `${text}\n\n${sig}`;
};

const noBackend = new Proxy({}, {
	get: () => async () => {
		throw new Error("WeChat runs in screen mode only.");
	},
}) as ComputerOperations;

export class Refused extends Error {}

const open = async (cua: CuaApi, screen: ScreenOperations, chat: string, findOnly = false) => {
	let s = await cua.observe({ app: APP, mode: "screen" });
	s = await s.act({ action: "keypress", keys: ["cmd", "f"] });
	s = await s.act({ action: "typeText", text: chat });
	await screen.sleep?.(1200);
	s = await cua.observe({ app: APP, mode: "screen" });
	const hit = pickExactResult(await screen.capture(APP), chat);
	if (!hit) {
		await screen.keys(["escape"]);
		throw new Refused(`no contact or group reads exactly '${chat}'. Nothing opened, nothing sent.`);
	}
	if (findOnly) {
		await screen.keys(["escape"]);
		return s;
	}
	const ref = s.text.split("\n").find((row) => row.includes(JSON.stringify(hit.text)) && row.includes(`(${Math.round(hit.x + hit.w / 2)},${Math.round(hit.y + hit.h / 2)})`))?.split(" ")[0];
	s = await s.act(ref ? { action: "click", ref } : { action: "click", x: Math.round(hit.x + hit.w / 2), y: Math.round(hit.y + hit.h / 2) });
	await screen.sleep?.(800);
	if (!titleMatches(await screen.capture(APP), chat)) throw new Refused(`the opened chat is not '${chat}'. Nothing sent.`);
	return s;
};

const clearDraft = async (screen: ScreenOperations) => {
	await screen.keys(["cmd", "a"]);
	await screen.keys(["backspace"]);
};

export const runWeChat = async (argv: string[], screen: ScreenOperations, out: (line: string) => void): Promise<number> => {
	const [mode, rawChat, text] = argv;
	// The CLI is the confirmation: brook approved recipient + text before `send`.
	const { cua } = createCuaRuntime({ operations: noBackend, screen, confirm: async () => mode === "send" });
	mkdirSync(STATE, { recursive: true });
	try {
		if (mode === "find") {
			await open(cua, screen, normalizeName(rawChat ?? ""), true);
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
		if (mode === "send") {
			if (!existsSync(PENDING)) {
				out("[BLOCKED] nothing prepared");
				return 2;
			}
			const chat = readFileSync(PENDING, "utf8").split("\n")[0];
			const s = await cua.observe({ app: APP, mode: "screen" });
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
		out("usage: find <chat> | prepare <chat> <text> | send | cancel");
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
