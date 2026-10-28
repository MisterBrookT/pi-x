// Session footer pins: only the newest 3 (short labels like "PR #10"), the rest behind "+N" which opens the full list;
// pins whose job ended (their loops closed, PR merged) drop into +N.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifactLinks, artifactShort, footerPins, loadArtifacts, pinArtifact } from "../plugins/core/artifacts.ts";
import { pinEnded, prDone } from "../plugins/core/pin-ended.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

test("short labels: PR #10, Issue #4, titles cut at a word", () => {
	assert.equal(artifactShort({ title: "Fix the wallet picker race on reconnect", url: "https://github.com/a/b/pull/10" }), "PR #10");
	assert.equal(artifactShort({ title: "x", url: "https://github.com/a/b/issues/4" }), "Issue #4");
	assert.equal(artifactShort({ title: "Docs preview", url: "https://x.pages.dev" }), "Docs preview");
	assert.equal(artifactShort({ title: "Kairos backtest results and chart notes", url: "https://x" }), "Kairos backtest");
});

test("newest 3 live pins, ended ones behind +N; the Mac footer shows +N as plain text", () => {
	const d = mkdtempSync(join(tmpdir(), "pins-")), p = mkdtempSync(join(tmpdir(), "pro-"));
	writeFileSync(join(p, "inbox.jsonl"), [{ id: "L1", status: "onit", session: "s" }, { id: "L2", status: "onit", session: "s" }, { id: "L2", status: "done" }].map(x => JSON.stringify(x)).join("\n"));
	pinArtifact("s", { title: "Old", url: "https://a" }, d, 1);
	pinArtifact("s", { title: "Docs preview", url: "https://b", loops: ["L1"] }, d, 2);
	pinArtifact("s", { title: "Merged fix", url: "https://github.com/o/r/pull/7" }, d, 3);
	pinArtifact("s", { title: "Report for the closed loop", url: "https://c", loops: ["L2"] }, d, 4);
	const gh = (url, done) => done(url.endsWith("/7") ? "MERGED" : "OPEN");
	prDone("https://github.com/o/r/pull/7", gh); // fill the cache (gh answers at once here)
	const ended = pinEnded(p, gh), items = loadArtifacts("s", d);
	// 4 pinned: the 4th retired the oldest ("Old"); of the 3 live ones, 2 ended (merged PR, closed loop).
	assert.equal(items.find(x => x.title === "Old").retired, true, "at most 3 live pins per session");
	assert.deepEqual(footerPins(items, ended).shown.map(x => x.title), ["Docs preview"]);
	assert.equal(footerPins(items, ended).more, 3);
	assert.deepEqual(artifactLinks(items, "/Users/b", ended), [{ label: "Docs preview", url: "https://b" }, { label: "+3", url: "" }]);
	const three = loadArtifacts("s", d).slice(1).map(({ retired, ...x }) => x);
	assert.deepEqual(artifactLinks(three, "/Users/b").map(l => l.label), ["Report for the", "PR #7", "Docs preview"], "3 pins: all 3 shown, no +N");
});

for (const [layout, viewport] of [["iPhone", { width: 402, height: 874 }], ["iPad", { width: 1180, height: 820 }], ["monitor", { width: 1920, height: 1080 }]]) {
	test(`phone (${layout}): footer shows the newest 3 short pins and +N; +N (or the pin chip) opens the full list, ended ones muted`, async t => {
		const token = "p".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
		t.after(async () => { await browser.close(); await hub.close(); });
		const base = `http://127.0.0.1:${hub.port}`;
		const pinned = [
			{ title: "Fix the wallet picker race on reconnect", short: "PR #10", url: "https://github.com/a/b/pull/10", kind: "link" },
			{ title: "Docs preview", short: "Docs preview", url: "https://docs.pages.dev", kind: "link" },
			{ title: "Kairos backtest results and chart notes", short: "Kairos backtest", url: "https://byterum.feishu.cn/docx/A", kind: "doc" },
			{ title: "Merged fix", short: "PR #7", url: "https://github.com/a/b/pull/7", kind: "link", ended: true },
			{ title: "Old note", short: "Old note", url: "https://old", kind: "link" },
		];
		await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "work", named: true, cwd: "/tmp", busy: false, pinned, messages: [{ id: "m", role: "user", text: "hello" }] }) });
		const page = await browser.newPage({ viewport, hasTouch: layout !== "monitor" });
		const errors = []; page.on("pageerror", e => errors.push(e.message));
		await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
		await page.goto(`${base}/#token=${token}`);
		await page.getByText("hello").waitFor();
		if (layout === "iPhone") {
			await page.locator("#pinnedChip").click();
		} else {
			const f = page.locator("#piFooter .pf-pins");
			assert.deepEqual(await f.locator(".pf-pin").allTextContents(), ["PR #10", "Docs preview", "Kairos backtest", "+2"]);
			assert.equal(await f.locator(".pf-sep").count() + (await f.textContent()).split("·").length - 1, 0, "no dot separators");
			const fb = await f.boundingBox(); assert.ok(fb.x + fb.width <= viewport.width + 1);
			await page.screenshot({ path: `.shots/pins-${layout}.png` });
			await f.getByRole("button", { name: "2 more pinned" }).click();
		}
		const rows = page.locator("#sheetBody .pin-row");
		await rows.first().waitFor();
		assert.equal(await rows.count(), 5, "full list");
		assert.equal(await page.locator("#sheetBody .pin-row.ended").count(), 1);
		assert.match(await page.locator("#sheetTitle").textContent(), /^Pinned in work$/);
		if (layout === "iPhone") await page.screenshot({ path: `.shots/pins-${layout}.png` });
		assert.deepEqual(errors, []);
	});
}

test("main line first: the main line's pins win the 3 footer spots over newer pins from other lines", () => {
	const items = [
		{ title: "Kairos docs", url: "https://k1", kind: "link", at: 1, line: "kairos-launch" },
		{ title: "Arena", url: "https://k2", kind: "link", at: 2, line: "kairos-launch" },
		{ title: "Pix a", url: "https://p1", kind: "link", at: 3, line: "pix" },
		{ title: "Pix b", url: "https://p2", kind: "link", at: 4, line: "pix" },
	];
	assert.deepEqual(footerPins(items, () => false, 3, "kairos-launch").shown.map(x => x.title), ["Arena", "Kairos docs", "Pix b"]);
	assert.deepEqual(footerPins(items, () => false, 3).shown.map(x => x.title), ["Pix b", "Pix a", "Arena"], "no main line: newest");
});
