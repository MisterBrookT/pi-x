// Phone performance kit: one heavy, fixed session and the measurements the phone feels.
// Used by tests/remote-perf.test.mjs (budgets) and scripts/bench-remote.mjs (numbers, plus a live mode).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { remoteAppHtml } from "../../plugins/remote/remote-web.ts";
import { remoteRelayWebScript } from "../../plugins/remote/remote-relay-web.ts";

/** Budgets: what "fast enough" means on the phone. A test fails when a change crosses one. */
export const budgets = {
	pageGzipKB: 260,          // the page itself, compressed
	openKB: 60,               // opening the heavy session (light, last 5 turns)
	thumbRatio: 0.34,         // chat image copy vs original
	firstMessageMs: 1500,     // page load to first message, CPU slowed 4x
	longestTaskMs: 200,       // longest freeze while loading or on an update, CPU slowed 4x
};

/** A big busy session like a real loop: many turns, many tools with long output, a few big images. */
export function heavySession({ turns = 40, toolsPerTurn = 8, outputChars = 3000, images = 6 } = {}) {
	const messages = [], media = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ id: "u" + i, role: "user", text: `Turn ${i}: please check the logs and fix it` });
		const tools = Array.from({ length: toolsPerTurn }, (_, j) => ({ id: `toolu_${i}_${j}`, name: j % 2 ? "read" : "bash", label: `step ${j} of turn ${i}`, input: JSON.stringify({ command: "grep -rn something ".repeat(20) }), output: `out ${i}.${j}\n`.repeat(Math.ceil(outputChars / 9)).slice(0, outputChars) }));
		messages.push({ id: "a" + i, role: "assistant", text: "Here is what I found. ".repeat(30), tools });
	}
	const png = join(mkdtempSync(join(tmpdir(), "pix-perf-")), "img.png");
	for (let k = 0; k < images; k++) {
		// Noisy 600x400 PNG, like a screenshot that compresses badly (~700 KB base64).
		execFileSync("python3", ["-c", `
import zlib,struct,random
random.seed(${k});w,h=600,400
raw=b''.join(b'\\0'+bytes(random.getrandbits(8) for _ in range(w*3)) for _ in range(h))
def ch(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
open('${png}','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,1))+ch(b'IEND',b''))`]);
		const data = readFileSync(png).toString("base64");
		const id = createHash("sha256").update("image/png").update(data).digest("hex");
		media.push({ id, mimeType: "image/png", data });
		const at = messages.length - 2 - k * 2;
		messages[at] = { ...messages[at], images: [{ id, mimeType: "image/png" }] };
	}
	return { snapshot: { name: "heavy", cwd: "/tmp", busy: false, messages }, media };
}

export const pageGzipKB = () => Math.round(gzipSync(remoteAppHtml + remoteRelayWebScript).length / 1024);

/** Put the heavy session into a hub, then measure what the phone downloads. */
export async function measurePayloads(base, token, fixture) {
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	await fetch(`${base}/agent/heavy`, { method: "PUT", headers, body: JSON.stringify(fixture.snapshot) });
	for (const m of fixture.media) await fetch(`${base}/agent/heavy/media/${m.id}`, { method: "PUT", headers, body: JSON.stringify(m) });
	const kb = async path => Math.round((await (await fetch(base + path, { headers })).text()).length / 1024);
	const fullKB = await kb("/api/sessions/heavy?tail=5"), openKB = await kb("/api/sessions/heavy?tail=5&light=1");
	let thumb = 0, full = 0;
	for (const m of fixture.media) { thumb += await kb(`/api/sessions/heavy/media/${m.id}?thumb=1`); full += await kb(`/api/sessions/heavy/media/${m.id}`); }
	return { fullKB, openKB, imagesKB: full, thumbsKB: thumb, thumbRatio: +(thumb / full).toFixed(2) };
}

/** Load the phone page with the CPU slowed 4x (a phone is slower than a Mac): time to first message, freezes. */
export async function measureRender(browser, base, token, { width = 402, height = 874 } = {}) {
	const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 761 });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	await page.addInitScript(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: "longtask", buffered: true }); });
	const t0 = Date.now();
	await page.goto(`${base}/#token=${token}`);
	await page.waitForSelector("#messages .msg");
	const firstMessageMs = Date.now() - t0;
	await page.waitForTimeout(1500);
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	const snap = await (await fetch(`${base}/api/sessions/heavy`, { headers })).json();
	await fetch(`${base}/agent/heavy`, { method: "PUT", headers, body: JSON.stringify({ ...snap, busy: true }) });
	await page.waitForTimeout(1500);
	const longestTaskMs = Math.round(Math.max(0, ...await page.evaluate(() => window.__lt)));
	await page.close();
	return { firstMessageMs, longestTaskMs };
}
