import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const home = mkdtempSync(join(tmpdir(), "pixh-"));
process.env.PIX_HOME = home;
delete process.env.PIX_CLAUDE_ROUTE;
const k = await jiti.import("../plugins/pix-anthropic/accountkit.ts");
const f = await jiti.import("../plugins/pix-anthropic/failover.ts");
const ids = () => k.plan().map(a => a.id);

test("quota and 429 switch accounts; overload and fast-mode rejections do not", () => {
	assert.equal(k.isQuota(429, "rate_limit_error"), true);
	assert.equal(k.isQuota(400, "You have reached your usage limit"), true);
	assert.equal(k.isQuota(429, "rate_limit_error fast mode"), false);
	assert.equal(k.isQuota(529, "overloaded"), false);
});

test("auto: minarabench first; own login when the proxy has no key", () => {
	assert.deepEqual(ids(), ["own"]);
	writeFileSync(join(home, "cliproxy-key"), "k\n");
	assert.deepEqual(ids(), ["minara", "own"]);
});

test("auto: an account below the threshold or resting goes last", () => {
	k.recordUsage("minara", { left: 15 });
	assert.deepEqual(ids(), ["own", "minara"], "15% < 20% threshold");
	writeFileSync(join(home, "accounts.json"), JSON.stringify({ threshold: 10 }));
	assert.deepEqual(ids(), ["minara", "own"], "knob lowers the bar");
	const now = Date.now();
	k.coolDown("minara", new Headers({ "retry-after": "600" }), now);
	assert.deepEqual(k.plan(now + 1000).map(a => a.id), ["own", "minara"]);
	assert.deepEqual(k.plan(now + 601_000).map(a => a.id), ["minara", "own"]);
});

test("pinning tries one account only; old 'proxy' name still works", () => {
	k.setChoice("own"); assert.deepEqual(ids(), ["own"]);
	k.setChoice("proxy"); assert.deepEqual(ids(), ["minara"]);
	k.setChoice("auto");
});

test("% left is the tighter of the 5-hour and weekly windows; footer shows it", () => {
	const u = k.leftFromUsage({ five_hour: { utilization: 63, resets_at: "a" }, seven_day: { utilization: 99, resets_at: "b" }, extra: null });
	assert.deepEqual(u, { left: 1, resetsAt: "b" });
	k.recordUsage("minara", { left: 80, coolUntil: 0 });
	assert.equal(k.footerLabel(), "minarabench 80%");
	k.setChoice("own"); assert.equal(k.footerLabel(), "brook (pinned)"); k.setChoice("auto");
});

test("proxy wire: token swapped for the proxy key; undated model ids mapped", () => {
	assert.deepEqual(f.proxyHeaders({ Authorization: "Bearer own", "X-Api-Key": "own", "anthropic-version": "1" }, "pk"), { "anthropic-version": "1", authorization: "Bearer pk" });
	assert.match(f.proxyBody('{"model":"claude-haiku-4-5"}'), /20251001/);
});
