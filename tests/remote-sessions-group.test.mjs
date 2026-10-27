// For you shows the same working spinner as any session while (and only while) it runs a turn;
// the Sessions heading has a "By line" toggle that keeps same-line sessions together and puts unassigned last.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

const tk = "g".repeat(32);
async function setup(t, shot) {
	const hub = await startRemoteHub({ token: tk, port: 0 });
	const browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); });
	const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
	const put = (id, body) => fetch(`${base}/agent/${id}`, { method: "PUT", headers, body: JSON.stringify({ cwd: "/tmp", messages: [{ id: "a", role: "user", text: "hi" }], ...body }) });
	await put("pix-foryou", { name: "for-you", busy: true });
	await put("m1", { name: "minara-1" }); await put("p1", { name: "pix" }); await put("m2", { name: "minara-2" }); await put("z1", { name: "2027" });
	const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
	await page.addInitScript(() => { localStorage.pixRemoteSession = "p1"; });
	await page.goto(`${base}/#token=${tk}`);
	await page.waitForSelector("#sessions [data-id='m2']");
	// Lines come from For you's line data on the Mac; set them directly here.
	await page.evaluate(() => { for (const s of sessions) s.line = { m1: "Kairos launch", m2: "Kairos launch", z1: "PhD / ZJU" }[s.id]; renderList(); });
	return { page, put };
}

test("For you row spins while For you runs a turn, and stops when it goes idle", async t => {
	const { page, put } = await setup(t);
	await page.waitForSelector("#forYouRow .state.working");
	await page.screenshot({ path: "/tmp/fy-busy-after.png" });
	await put("pix-foryou", { name: "for-you", busy: false });
	await page.waitForSelector("#forYouRow .state.working", { state: "detached" });
});

test("By line groups same-line sessions together, unassigned last, and ⌘1–9 follow the visible order", async t => {
	const { page } = await setup(t);
	const groups = () => page.$$eval("#sessions section", ss => ss.map(s => [s.querySelector("h2").textContent, [...s.querySelectorAll("[data-id]")].map(b => b.dataset.id).filter((x, i, a) => a.indexOf(x) === i)]));
	assert.equal((await groups()).length, 1, "default: one Sessions list");
	await page.click("#groupByLine");
	assert.equal(await page.getAttribute("#groupByLine", "aria-pressed"), "true");
	const g = await groups();
	assert.deepEqual(g.map(x => x[0]).at(-1), "No line");
	const kairos = g.find(x => x[0] === "Kairos launch");
	assert.deepEqual(kairos[1].sort(), ["m1", "m2"], "both Kairos sessions, not collapsed to one owner");
	assert.ok(g.find(x => x[0] === "No line")[1].includes("p1"));
	assert.equal(await page.evaluate(() => localStorage.pixGroupByLine), "1");
	const [order, shown] = await page.evaluate(() => [numberedRows().slice(1).map(b => b.dataset.id), [...document.querySelectorAll("#sessions section [data-id]")].map(b => b.dataset.id)].map(a => a.filter((x, i) => a.indexOf(x) === i)));
	assert.deepEqual(order, shown, "number keys match what is on screen");
	await page.screenshot({ path: "/tmp/group-after.png" });
	await page.click("#groupByLine");
	assert.equal((await groups()).length, 1);
});
