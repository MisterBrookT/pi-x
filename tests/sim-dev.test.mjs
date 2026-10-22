import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

test("sim dev server: serves the phone page fresh with a reload hook, no service worker, and proxies the hub", async () => {
	const hub = createServer((req, res) => res.end(`hub ${req.url}`)).listen(0, "127.0.0.1");
	await new Promise(r => hub.once("listening", r));
	const port = 18000 + Math.floor(Math.random() * 1000);
	const child = spawn(process.execPath, ["scripts/sim-dev.mjs"], { env: { ...process.env, PIX_SIM_PORT: String(port), PIX_HUB_PORT: String(hub.address().port) } });
	try {
		await new Promise((r, j) => { child.stdout.on("data", d => /sim dev/.test(d) && r()); child.once("exit", j); });
		const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		assert.match(html, /\/__sim\/reload/);
		assert.doesNotMatch(html, /navigator\.serviceWorker\.register\(/);
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/x?y=1`)).text(), "hub /api/x?y=1");
	} finally { child.kill(); hub.close(); }
});
