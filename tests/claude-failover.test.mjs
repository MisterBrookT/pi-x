import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const home = mkdtempSync(join(tmpdir(), "pixh-"));
process.env.PIX_HOME = home;
const f = await jiti.import("../plugins/pix-anthropic/failover.ts");

test("quota and 429 fail over; overload and fast-mode rejections do not", () => {
	assert.equal(f.isQuota(429, "rate_limit_error"), true);
	assert.equal(f.isQuota(400, "You have reached your usage limit"), true);
	assert.equal(f.isQuota(429, "rate_limit_error fast mode"), false);
	assert.equal(f.isQuota(529, "overloaded"), false);
	assert.equal(f.isQuota(400, "invalid model"), false);
});

test("route file switches accounts; auto uses proxy only while the own login is out", () => {
	f.resetExhausted();
	assert.equal(f.route(), "auto");
	assert.equal(f.useProxyFirst(), false);
	assert.equal(f.mayFailOver(), false, "no key, no failover");
	writeFileSync(join(home, "cliproxy-key"), "k\n");
	assert.equal(f.mayFailOver(), true);
	const now = Date.now();
	f.markExhausted(new Headers({ "retry-after": "600" }), now);
	assert.equal(f.useProxyFirst(now + 1000), true);
	assert.equal(f.useProxyFirst(now + 601_000), false);
	f.setRoute("proxy"); assert.equal(f.useProxyFirst(), true);
	f.setRoute("own"); assert.equal(f.useProxyFirst(), false); assert.equal(f.mayFailOver(), false);
	f.setRoute("auto");
});

test("proxy headers swap brook's token for the proxy key", () => {
	const h = f.proxyHeaders({ Authorization: "Bearer own", "X-Api-Key": "own", "anthropic-version": "2023-06-01" }, "pk");
	assert.deepEqual(h, { "anthropic-version": "2023-06-01", authorization: "Bearer pk" });
});

test("undated older model ids get cliproxy's dated id; newer ids pass through", () => {
	assert.match(f.proxyBody('{"model":"claude-haiku-4-5","x":1}'), /claude-haiku-4-5-20251001/);
	assert.equal(f.proxyBody('{"model":"claude-opus-5-5"}'), '{"model":"claude-opus-5-5"}');
});
