import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationRequiredError, TargetMismatchError, createCuaRuntime, outlineHasTitle, urlMatches } from "../plugins/computer/computer-script.ts";
import { keystrokeScript, normalizeName, screenOutline, titleMatches } from "../plugins/computer/computer-screen.ts";

const line = (text, x, y, w = 80, h = 16) => ({ text, x, y, w, h });

/** A fake WeChat: a search list, and a header that shows whichever chat was clicked. */
const fakeWeChat = ({ opens = (name) => name } = {}) => {
	const log = [];
	let title = "brookkk";
	let draft = "";
	const results = [line("Most used", 40, 60), line("浙大 李老师 报销", 120, 100), line("VAG 报销小分队", 120, 140)];
	const capture = async () => ({
		app: "WeChat",
		window: { x: 100, y: 50, w: 1000, h: 760 },
		lines: [line(title, 260, 20), ...results, ...(draft ? [line(draft, 300, 700)] : [])],
	});
	const screen = {
		activate: async (app) => log.push(`activate ${app}`),
		capture,
		click: async (x, y) => {
			log.push(`click ${x},${y}`);
			const hit = results.find((r) => Math.abs(100 + r.x + r.w / 2 - x) < 2 && Math.abs(50 + r.y + r.h / 2 - y) < 2);
			if (hit) title = opens(hit.text);
		},
		keys: async (keys) => {
			log.push(`keys ${keys.join("+")}`);
			if (keys.join("+") === "Enter" && draft) { log.push(`SENT ${title}: ${draft}`); draft = ""; }
		},
		paste: async (text) => { log.push(`paste ${text}`); draft = text; },
	};
	return { screen, log };
};

const ops = new Proxy({}, { get: () => async () => { throw new Error("AX backend must not be called in screen mode"); } });

test("screen mode lists OCR lines as @t refs with window-relative centers", async () => {
	const { screen } = fakeWeChat();
	const { cua } = createCuaRuntime({ operations: ops, screen });
	const s = await cua.observe({ app: "WeChat", mode: "screen" });
	assert.match(s.text, /no accessibility tree/);
	assert.match(s.text, /@t3 "浙大 李老师 报销" \(160,108\)/);
	assert.match(await s.search({ text: "VAG" }), /@t4 "VAG 报销小分队"/);
});

test("screen mode: click by ref, paste, and an Enter aimed at the right chat sends after confirm", async () => {
	const { screen, log } = fakeWeChat();
	const asked = [];
	const { cua } = createCuaRuntime({ operations: ops, screen, confirm: async (s) => (asked.push(s), true) });
	let s = await cua.observe({ app: "WeChat", mode: "screen" });
	s = await s.act({ action: "click", ref: "@t3" }); // 浙大 李老师 报销
	s = await s.act({ action: "typeText", text: "hi" }, { text: "hi" });
	await s.act({ action: "keypress", keys: ["Enter"] }, undefined, { target: { title: "浙大 李老师 报销\r" } });
	assert.ok(log.includes("click 260,158"), log.join("\n"));
	assert.ok(log.includes("SENT 浙大 李老师 报销: hi"));
	assert.equal(asked.length, 1);
});

test("screen mode refuses Enter when the open chat is not the target, and never presses it", async () => {
	// The 2026-10-19 incident: the search opened the group, not the private chat.
	const { screen, log } = fakeWeChat({ opens: () => "VAG 报销小分队(73)" });
	const { cua } = createCuaRuntime({ operations: ops, screen, confirm: async () => true });
	let s = await cua.observe({ app: "WeChat", mode: "screen" });
	s = await s.act({ action: "click", ref: "@t3" });
	s = await s.act({ action: "typeText", text: "hi" });
	await assert.rejects(
		() => s.act({ action: "keypress", keys: ["Enter"] }, undefined, { target: { title: "浙大 李老师 报销" } }),
		(e) => e instanceof TargetMismatchError && /VAG/.test(e.message),
	);
	assert.ok(!log.some((l) => l.startsWith("SENT") || l === "keys Enter"));
});

test("screen mode refuses an irreversible key with no target at all", async () => {
	const { screen, log } = fakeWeChat();
	const { cua } = createCuaRuntime({ operations: ops, screen, confirm: async () => true });
	const s = await cua.observe({ app: "WeChat", mode: "screen" });
	await assert.rejects(() => s.act({ action: "keypress", keys: ["Enter"] }), TargetMismatchError);
	assert.ok(!log.includes("keys Enter"));
});

test("screen mode: the target check passes but a declined confirm still blocks the send", async () => {
	const { screen, log } = fakeWeChat();
	const { cua } = createCuaRuntime({ operations: ops, screen, confirm: async () => false });
	const s = await cua.observe({ app: "WeChat", mode: "screen" });
	await assert.rejects(() => s.act({ action: "keypress", keys: ["Enter"] }, undefined, { target: { title: "brookkk" } }), ConfirmationRequiredError);
	assert.ok(!log.includes("keys Enter"));
});

test("cmd+Enter-free chords like cmd+f are not treated as sends", async () => {
	const { screen, log } = fakeWeChat();
	const { cua } = createCuaRuntime({ operations: ops, screen });
	const s = await cua.observe({ app: "WeChat", mode: "screen" });
	await s.act({ action: "keypress", keys: ["cmd", "f"] });
	assert.ok(log.includes("keys cmd+f"));
});

test("AX mode: an irreversible press is checked against the window title", async () => {
	const operations = {
		observe: async () => ({ content: [{ type: "text", text: '@e1 AXWindow "Mail — Draft to Bob"\n@e9 AXButton "Send"' }], details: { stateId: "S1" } }),
		act: async () => ({ content: [{ type: "text", text: "ok" }], details: { stateId: "S2" } }),
	};
	const { cua } = createCuaRuntime({ operations, confirm: async () => true });
	const s = await cua.observe();
	await assert.rejects(() => s.act({ action: "press", ref: "@e9" }, undefined, { target: { title: "Mail — Draft to Alice" } }), TargetMismatchError);
	const next = await s.act({ action: "press", ref: "@e9" }, undefined, { target: { title: "Mail — Draft to Bob" } });
	assert.equal(next.id, "S2");
});

test("browser mode: an irreversible press is checked against the page URL", async () => {
	let href = "https://evil.example/pay";
	const acted = [];
	const operations = {
		launchBrowser: async () => ({ content: [{ type: "text", text: '@e1 webarea "Shop"\n@e9 button "Pay"' }], details: { stateId: "B1" } }),
		evaluateBrowser: async () => ({ content: [{ type: "text", text: `Evaluation value: ${JSON.stringify(href)}` }], details: { stateId: "B2" } }),
		act: async (p) => (acted.push(p), { content: [{ type: "text", text: "ok" }], details: { stateId: "B3" } }),
	};
	const { cua } = createCuaRuntime({ operations, confirm: async () => true });
	const page = await cua.launchBrowser("https://shop.example/cart");
	await assert.rejects(() => page.act({ action: "press", ref: "@e9" }, undefined, { target: { url: "https://shop.example/cart" } }), /evil\.example/);
	assert.equal(acted.length, 0);
	href = "https://shop.example/cart/checkout";
	await page.act({ action: "press", ref: "@e9" }, undefined, { target: { url: "https://shop.example/cart" } });
	assert.equal(acted.length, 1);
});

test("title and URL rules: exact, not substring; \\r stripped; same origin", () => {
	const cap = (t) => ({ app: "x", window: { x: 0, y: 0, w: 1000, h: 800 }, lines: [line(t, 300, 10)] });
	assert.equal(titleMatches(cap("浙大 李老师 报销"), "浙大 李老师 报销\r"), true);
	assert.equal(titleMatches(cap("VAG 报销小分队(73)"), "VAG 报销小分队"), false);
	assert.equal(titleMatches(cap("浙大 李老师 报销 群"), "浙大 李老师 报销"), false);
	assert.equal(normalizeName(" a\r\n"), "a");
	assert.equal(outlineHasTitle('@e1 window "Notes"\n@e2 button "Notes"', "Notes"), true);
	assert.equal(outlineHasTitle('@e2 button "Notes"', "Notes"), false);
	assert.equal(urlMatches("https://a.com/x/y", "https://a.com/x"), true);
	assert.equal(urlMatches("https://a.com/xy", "https://a.com/x"), false);
	assert.equal(urlMatches("https://b.com/x", "https://a.com/x"), false);
	assert.match(screenOutline(cap("t")), /@t1 "t"/);
});

test("key chords map to System Events lines", () => {
	assert.equal(keystrokeScript(["Enter"]), 'tell application "System Events" to key code 36');
	assert.equal(keystrokeScript(["cmd", "f"]), 'tell application "System Events" to keystroke "f" using {command down}');
	assert.throws(() => keystrokeScript(["cmd"]));
});

test("WeChat search: only an exact Contacts/Group/Most-used row is picked, never web or chat history", async () => {
	const { pickExactResult } = await import("../plugins/computer/computer-screen.ts");
	const cap = (lines) => ({ app: "WeChat", window: { x: 0, y: 0, w: 1000, h: 800 }, lines });
	const results = cap([
		line("Group Chats", 40, 60), line("VAG 报销小分队", 120, 90),
		line("Chat History", 40, 200), line("浙大 李老师 报销", 120, 230),
		line("Contacts", 40, 300), line("浙大 李老师 报销", 120, 330),
	]);
	assert.equal(pickExactResult(results, "浙大 李老师 报销\r").y, 330);
	assert.equal(pickExactResult(results, "浙大 李老师"), undefined);
	assert.equal(pickExactResult(cap([line("Chat History", 40, 60), line("brookkk", 120, 90)]), "brookkk"), undefined);
});

/** A fuller fake WeChat for the CLI: cmd+f opens search; typing filters; clicking a row opens it. */
const fakeWeChatApp = ({ opensAs, flipAfterPaste, dropDraft, cmdFDead } = {}) => {
	const log = [];
	let title = "brookkk", searching = false, query = "", draft = "";
	const sentLines = [];
	const rows = () => !searching ? [] : [
		line("Most used", 40, 60), line("brookkk", 120, 90),
		line("Group Chats", 40, 130), line("VAG 报销小分队", 120, 160),
		line("Contacts", 40, 200), line("浙大 李老师 报销", 120, 230),
	].filter((l) => l.x === 40 || l.text.includes(query) || query.includes("报销") && l.text.includes("报销"));
	const screen = {
		activate: async () => {},
		capture: async () => ({ app: "WeChat", window: { x: 0, y: 0, w: 1000, h: 800 }, lines: [line("Search", 100, 22), line(title, 300, 20), ...rows(), ...sentLines.map((t, i) => line(t, 500, 400 + i * 30)), ...(draft ? [line(draft.split("\n")[0], 300, 700)] : [])] }),
		click: async (x, y) => {
			const hit = rows().find((r) => r.x !== 40 && Math.abs(r.x + r.w / 2 - x) < 2 && Math.abs(r.y + r.h / 2 - y) < 2);
			if (hit) { title = opensAs?.(hit.text) ?? hit.text; searching = false; log.push(`open ${hit.text}`); }
			if (!searching && x >= 100 && x <= 200 && y >= 15 && y <= 45) { searching = true; query = ""; log.push("click search"); }
			if (draft === "" && y > 600) log.push("click box");
		},
		keys: async (k, app) => {
			const c = k.join("+");
			log.push(`key ${c}${app ? ` →${app}` : ""}`);
			if (c === "cmd+f" && !cmdFDead) { searching = true; query = ""; }
			else if (c === "escape") searching = false;
			else if (c === "backspace") draft = "";
			else if (c === "Enter" && draft) { log.push(`SENT ${title}: ${draft}`); sentLines.push(draft.split("\n")[0]); draft = ""; }
		},
		paste: async (t, app) => { log.push(`paste${app ? ` →${app}` : ""}`); if (searching) query = t; else draft = dropDraft?.() ? "" : t; if (flipAfterPaste && !searching) title = flipAfterPaste; },
		background: true,
	};
	return { screen, log };
};

test("wechat CLI: prepare opens the exact private chat (not the group), send re-checks and sends", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp();
	const out = [];
	assert.equal(await runWeChat(["prepare", "浙大 李老师 报销\r", "已提交"], screen, (l) => out.push(l)), 0, out.join("\n"));
	assert.deepEqual(log.filter((l) => /^(open|SENT)/.test(l)), ["open 浙大 李老师 报销"]);
	assert.equal(await runWeChat(["send"], screen, (l) => out.push(l)), 0, out.join("\n"));
	assert.equal(log.find((l) => l.startsWith("SENT")), "SENT 浙大 李老师 报销: 已提交\n\nthis message is sent by brook’s agent, he will review it latter, any problem could find him");
});

test("wechat CLI: if the click lands in another chat, prepare refuses and nothing is sent", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp({ opensAs: () => "VAG 报销小分队(73)" });
	const out = [];
	assert.equal(await runWeChat(["prepare", "浙大 李老师 报销", "hi"], screen, (l) => out.push(l)), 3);
	assert.match(out.join("\n"), /\[REFUSED\]/);
	assert.equal(await runWeChat(["send"], screen, (l) => out.push(l)), 2, "nothing pending after a refusal");
	assert.ok(!log.some((l) => l.startsWith("SENT")));
});

test("wechat CLI: no exact match refuses without opening anything", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp();
	const out = [];
	assert.equal(await runWeChat(["prepare", "File Transfer", "hi"], screen, (l) => out.push(l)), 3);
	assert.equal(log.filter((l) => /^(open|SENT|paste →WeChat$)/.test(l) && !l.startsWith("paste")).length, 0);
});

test("sendnow: one call opens, types, checks title + box, sends, and reads back; keys go to WeChat in the background", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp();
	const out = [];
	assert.equal(await runWeChat(["sendnow", "brookkk", "hello"], screen, (l) => out.push(l)), 0, out.join("\n"));
	assert.match(out.join("\n"), /^\[SENT\] 'brookkk': read back/);
	assert.deepEqual(log.filter((l) => l.startsWith("SENT")), ["SENT brookkk: hello\n\nthis message is sent by brook’s agent, he will review it latter, any problem could find him"]);
	assert.ok(log.includes("key Enter →WeChat"), "keys are posted to the app's process");
	assert.ok(log.includes("paste →WeChat"));
});

test("sendnow refuses when the chat changes between typing and Enter, and clears the draft", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp({ flipAfterPaste: "VAG 报销小分队(73)" });
	const out = [];
	assert.equal(await runWeChat(["sendnow", "浙大 李老师 报销", "hi"], screen, (l) => out.push(l)), 3, out.join("\n"));
	assert.match(out.join("\n"), /not "浙大 李老师 报销".*Draft cleared/);
	assert.ok(!log.some((l) => l.startsWith("SENT")));
	assert.ok(log.includes("key backspace →WeChat"));
});

test("sendnow refuses when the input box does not show what was typed", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp({ dropDraft: () => true });
	const out = [];
	assert.equal(await runWeChat(["sendnow", "brookkk", "hello"], screen, (l) => out.push(l)), 3);
	assert.match(out.join("\n"), /input box does not show/);
	assert.ok(!log.some((l) => l.startsWith("SENT")));
});

test("no exact match suggests close names", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen } = fakeWeChatApp();
	const out = [];
	assert.equal(await runWeChat(["prepare", "浙大 李老师", "hi"], screen, (l) => out.push(l)), 3);
	assert.match(out.join("\n"), /Close matches: '浙大 李老师 报销'/);
	const { nearMisses } = await import("../plugins/computer/computer-screen.ts");
	const cap = { app: "x", window: { x: 0, y: 0, w: 1000, h: 800 }, lines: [line("brookk", 0, 0), line("Search", 0, 0), line("brookkk 2", 0, 0)] };
	assert.deepEqual(nearMisses(cap, "brookkk").slice(0, 2).sort(), ["brookk", "brookkk 2"]);
});

test("key chords map to background key codes", async () => {
	const { keyArgs } = await import("../plugins/computer/computer-screen.ts");
	assert.deepEqual(keyArgs(["cmd", "v"]), ["code", "9", "cmd"]);
	assert.deepEqual(keyArgs(["Enter"]), ["code", "36"]);
	assert.deepEqual(keyArgs(["command", "shift", "a"]), ["code", "0", "cmd", "shift"]);
});

test("cua.recipe runs saved recipes inside the same runner; unknown names list what exists", async () => {
	const { createCuaRuntime } = await import("../plugins/computer/computer-script.ts");
	const { screen, log } = fakeWeChatApp();
	const declined = createCuaRuntime({ operations: {}, screen, confirm: async () => false });
	await assert.rejects(declined.cua.recipe("wechat-send", { to: "brookkk", text: "hi" }), /declined/i, "the irreversible-act confirm still applies");
	assert.ok(!log.some((l) => l.startsWith("SENT")));
	const ok = createCuaRuntime({ operations: {}, screen, confirm: async () => true });
	assert.deepEqual(await ok.cua.recipe("wechat-send", { to: "brookkk", text: "hi" }), { sent: true, readBack: true, chat: "brookkk" });
	await assert.rejects(ok.cua.recipe("nope"), /No recipe "nope"[\s\S]*wechat-send/);
});


test("screen capture reads the app's own windows, so the Pix privacy cover cannot blank it (WeChat OCR read the wallpaper, 10-28)", async () => {
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../plugins/computer/computer-screen.ts", import.meta.url), "utf8");
	assert.match(src, /helper\("appshot"\)/, "capture goes through the per-app helper first");
	const swift = readFileSync(new URL("../plugins/computer/native/appshot.swift", import.meta.url), "utf8");
	assert.match(swift, /kCGWindowOwnerPID/, "only the app's windows");
	assert.match(swift, /"-l\\\(part\.id\)"/, "each captured by window id, pop-ups included");
});

test("wechat find: when cmd+f does not focus search (WeChat in the background), click the Search box and type again", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const { screen, log } = fakeWeChatApp({ cmdFDead: true });
	const out = [];
	assert.equal(await runWeChat(["find", "brookkk"], screen, (l) => out.push(l)), 0, out.join("\n"));
	assert.ok(log.includes("click search"), log.join("\n"));
	assert.ok(!log.some((l) => /^(open|SENT)/.test(l)), "find opens nothing");
});

test("wechat check: real WeChat OCR passes; the privacy-cover wallpaper read (StU/Font/eCrazU) fails loudly; nothing typed", async () => {
	const { runWeChat } = await import("../plugins/computer/wechat.ts");
	const log = [];
	const mk = (lines) => ({ activate: async () => log.push("activate"), capture: async () => ({ app: "WeChat", window: { x: 0, y: 0, w: 1164, h: 866 }, lines }), click: async () => log.push("click"), keys: async () => log.push("keys"), paste: async () => log.push("paste"), background: true });
	const out = [];
	assert.equal(await runWeChat(["check"], mk([line("Search", 100, 22), line("浙大 wenzhen师兄", 300, 20)]), (l) => out.push(l)), 0);
	assert.equal(await runWeChat(["check"], mk([line("StU", 500, 400), line("Font", 520, 430), line("eCrazU", 560, 460)]), (l) => out.push(l)), 2);
	assert.match(out.at(-1), /BLOCKED.*StU/);
	assert.equal(await runWeChat(["check"], mk([]), (l) => out.push(l)), 0, "blank = WeChat in the background: skip, not an alarm");
	assert.match(out.at(-1), /SKIP/);
	assert.deepEqual(log, []);
});

test("capture picks the app's largest window, not a small pop-up listed first", async () => {
	const { mainWindow } = await import("../plugins/computer/computer-screen.ts");
	assert.deepEqual(mainWindow("523,809,259,131,84,77,1164,866"), [259, 131, 1164, 866]);
	assert.deepEqual(mainWindow("259,131,1164,866"), [259, 131, 1164, 866]);
});

test("screen tools run under a bare launchd PATH (screencapture lives in /usr/sbin)", async () => {
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../plugins/computer/computer-screen.ts", import.meta.url), "utf8");
	assert.match(src, /PATH: `\$\{process\.env\.PATH \?\? ""\}:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin`/);
});
