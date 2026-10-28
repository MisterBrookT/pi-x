// Phone speed budgets on a heavy, fixed session (tests/helpers/remote-perf.mjs). `npm run bench:remote` prints the numbers.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { budgets, heavySession, measurePayloads, measureRender, pageGzipKB } from "./helpers/remote-perf.mjs";

test("phone speed stays within budget: page size, opening a heavy session, chat images, render time", async t => {
	const token = "p".repeat(32), hub = await startRemoteHub({ token, port: 0 }), browser = await chromium.launch();
	t.after(async () => { await browser.close(); await hub.close(); });
	const base = `http://127.0.0.1:${hub.port}`;
	const page = pageGzipKB();
	const load = await measurePayloads(base, token, heavySession());
	const render = await measureRender(browser, base, token);
	t.diagnostic(JSON.stringify({ pageGzipKB: page, ...load, ...render }));
	assert.ok(page <= budgets.pageGzipKB, `page ${page} KB > ${budgets.pageGzipKB}`);
	assert.ok(load.openKB <= budgets.openKB, `opening ${load.openKB} KB > ${budgets.openKB} (full would be ${load.fullKB})`);
	assert.ok(load.thumbRatio <= budgets.thumbRatio, `chat images are ${load.thumbRatio} of full size`);
	assert.ok(render.firstMessageMs <= budgets.firstMessageMs, `first message after ${render.firstMessageMs} ms`);
	assert.ok(render.longestTaskMs <= budgets.longestTaskMs, `froze for ${render.longestTaskMs} ms`);
});
