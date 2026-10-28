// Opening a session sends tool rows as short previews; a tapped row loads its full text. Phone in a real browser.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";

test("first load is light (tool text cut), a tapped tool row shows the full output", async t => {
	const tk = "l".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 });
	const browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); });
	const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
	const big = "line of output\n".repeat(2000) + "THE END";
	const messages = [{ id: "u", role: "user", text: "go" }, { id: "a", role: "assistant", text: "done", tools: [{ id: "toolu_1", name: "bash", label: "ls", input: "ls", output: big }] }];
	await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: false, messages }) });
	const light = await (await fetch(`${base}/api/sessions/s1?tail=5&light=1`, { headers })).json();
	const lt = light.messages[1].tools[0];
	assert.ok(lt.cut && lt.output.length <= 400, "tool output is a short preview");
	assert.ok(JSON.stringify(light).length < 3000);
	assert.ok(relayAllowed("/api/sessions/s1/tool/toolu_1", "GET"), "the relay lets the phone fetch it");
	const page = await browser.newPage({ viewport: { width: 402, height: 874 }, hasTouch: true });
	await page.goto(`${base}/#token=${tk}`);
	await page.waitForSelector("#messages .msg");
	await page.evaluate(() => { for (const d of document.querySelectorAll("details")) d.open = true; });
	await page.waitForFunction(() => document.querySelector('details.tool[data-tool="toolu_1"]')?.textContent.includes("THE END"), null, { timeout: 5000 });
});
