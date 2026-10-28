/**
 * WeChat 4.x recipes (screen mode: OCR + real input; WeChat has no accessibility tree).
 * wechat-send: open the exact chat → type → check title + input box → Enter → read back, in one call.
 */
import { TargetMismatchError, type CuaApi } from "../computer-script.ts";
import { type ScreenCapture, type ScreenOperations, draftVisible, headerLines, nearMisses, normalizeName, pickExactResult, titleMatches } from "../computer-screen.ts";
import type { Recipe } from "./index.ts";

export const APP = "WeChat";

/** brook's rule (message skill): every agent-sent message ends with exactly this line, any language. */
export const SIGNATURE = "this message is sent by brook’s agent, he will review it latter, any problem could find him";
export const signed = (text: string): string => text.trimEnd().endsWith(SIGNATURE) ? text : `${text}\n\n${SIGNATURE}`;

/** No exact contact, or the wrong chat is open. Nothing was sent. */
export class Refused extends Error {}

const need = (screen: ScreenOperations | undefined) => {
	if (!screen) throw new Error("WeChat recipes need screen mode (macOS).");
	return screen;
};

export const clearDraft = async (screen: ScreenOperations) => {
	await screen.keys(["cmd", "a"], APP);
	await screen.keys(["backspace"], APP);
};

const hasResultSections = (c: ScreenCapture) => c.lines.some((l) => /^(most used|contacts|group chats|chat history|联系人|群聊|最常使用|聊天记录)$/i.test(l.text.trim()));

/** Search, and open only a result whose name reads exactly `chat`. */
export const openChat = async (cua: CuaApi, screen: ScreenOperations, chat: string, findOnly = false) => {
	let s = await cua.observe({ app: APP, mode: "screen" });
	s = await s.act({ action: "keypress", keys: ["cmd", "f"] });
	s = await s.act({ action: "typeText", text: chat });
	await screen.sleep?.(1200);
	s = await cua.observe({ app: APP, mode: "screen" });
	let results = await screen.capture(APP);
	// ⌘F does not always focus WeChat's search (10-28: the query never appeared and every name was refused).
	// No result sections means the search box is not open: click the "Search" box in the sidebar header and type again.
	if (!hasResultSections(results)) {
		const box = headerLines(results, 80).find((l) => /^(search|搜索)$/i.test(l.text.trim()));
		if (box) {
			await screen.click(results.window.x + box.x + box.w / 2, results.window.y + box.y + box.h / 2);
			await screen.sleep?.(400);
			s = await cua.observe({ app: APP, mode: "screen" });
			s = await s.act({ action: "typeText", text: chat });
			await screen.sleep?.(1200);
			s = await cua.observe({ app: APP, mode: "screen" });
			results = await screen.capture(APP);
		}
	}
	let hit = pickExactResult(results, chat);
	// Search results can lag behind the first capture; look once more before refusing.
	if (!hit) {
		await screen.sleep?.(1200);
		results = await screen.capture(APP);
		hit = pickExactResult(results, chat);
	}
	if (!hit) {
		await screen.keys(["escape"], APP);
		const near = nearMisses(results, chat).filter((t) => !/^(search|most used|group chats|contacts|chat history)/i.test(t));
		throw new Refused(`no contact or group reads exactly '${chat}'.${near.length ? ` Close matches: ${near.map((n) => `'${n}'`).join(", ")}.` : ""} Nothing opened, nothing sent.`);
	}
	if (findOnly) {
		await screen.keys(["escape"], APP);
		return s;
	}
	const ref = s.text.split("\n").find((row) => row.includes(JSON.stringify(hit.text)) && row.includes(`(${Math.round(hit.x + hit.w / 2)},${Math.round(hit.y + hit.h / 2)})`))?.split(" ")[0];
	s = await s.act(ref ? { action: "click", ref } : { action: "click", x: Math.round(hit.x + hit.w / 2), y: Math.round(hit.y + hit.h / 2) });
	await screen.sleep?.(800);
	if (!titleMatches(await screen.capture(APP), chat)) throw new Refused(`the opened chat is not '${chat}'. Nothing sent.`);
	return s;
};

const str = (v: unknown, name: string) => {
	const s = typeof v === "string" ? v : "";
	if (!s.trim()) throw new Error(`${name} is required`);
	return s;
};

export const wechatFind: Recipe = {
	about: 'wechat-find {to}: is there a contact/group named exactly `to`? Opens nothing. → {found: true} or throws with close matches',
	async run({ cua, screen }, args) {
		await openChat(cua, need(screen), normalizeName(str(args.to, "to")), true);
		return { found: true };
	},
};

export const wechatSend: Recipe = {
	about: "wechat-send {to, text}: open the exact chat, type, check title + input box, Enter (needs the user's confirm), read back. → {sent, readBack}",
	async run({ cua, screen: sc }, args) {
		const screen = need(sc);
		const chat = normalizeName(str(args.to, "to"));
		const msg = signed(str(args.text, "text"));
		const s = await openChat(cua, screen, chat);
		await clearDraft(screen);
		// One act: the runner re-checks the title and that the box shows `msg` right before Enter.
		await s.act([{ action: "typeText", text: msg }, { action: "keypress", keys: ["Enter"] }], undefined, { target: { title: chat } });
		await screen.activate(APP);
		await screen.sleep?.(800);
		const after = await screen.capture(APP);
		const head = msg.split("\n")[0].replace(/\s+/g, "").slice(0, 12);
		const readBack = titleMatches(after, chat) && !draftVisible(after, msg) && after.lines.some((l) => l.y < after.window.h * 0.75 && l.text.replace(/\s+/g, "").includes(head));
		return { sent: true, readBack, chat };
	},
};

export { TargetMismatchError };
