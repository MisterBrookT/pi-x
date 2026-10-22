import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const home = mkdtempSync(join(tmpdir(), "pixh-"));
process.env.PIX_HOME = home;
delete process.env.PIX_CLAUDE_ROUTE;
const k = await jiti.import("../plugins/pix-anthropic/accountkit.ts");
const ids = () => k.plan().map(a => a.id);

test("quota and 429 switch accounts; overload and fast-mode rejections do not", () => {
	assert.equal(k.isQuota(429, "rate_limit_error"), true);
	assert.equal(k.isQuota(400, "You have reached your usage limit"), true);
	assert.equal(k.isQuota(429, "rate_limit_error fast mode"), false);
	assert.equal(k.isQuota(529, "overloaded"), false);
});

const prof = join(home, "claude-minarabench");
writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [{ id: "minarabench", label: "minarabench", configDir: prof }, { id: "own", label: "brook" }] }));

test("auto: minarabench first once its login exists; own until then", () => {
	assert.deepEqual(ids(), ["own"]);
	mkdirSync(prof); writeFileSync(join(prof, ".claude.json"), "{}");
	assert.deepEqual(ids(), ["own", "minarabench"], "tie (both unknown): stay on own");
	k.setActive("minarabench");
	assert.deepEqual(ids(), ["minarabench", "own"]);
});

test("band rule: switch only to a strictly higher band; ties stay; resting goes last", () => {
	const set = (m, o) => { k.recordUsage("minarabench", { left: m, coolUntil: 0 }); k.recordUsage("own", { left: o, coolUntil: 0 }); };
	set(60, 70); assert.equal(ids()[0], "minarabench", "same band 50-74: keep current");
	set(40, 70); assert.equal(ids()[0], "own", "own in a higher band: switch");
	set(70, 60); assert.equal(ids()[0], "own", "back in the same band: stay on own");
	set(80, 60); assert.equal(ids()[0], "minarabench", "strictly higher band: switch back");
	process.env.PIX_ACCOUNT_BAND = "50"; set(30, 80); assert.equal(ids()[0], "own"); set(60, 80); assert.equal(ids()[0], "own", "wider bands: tie stays"); delete process.env.PIX_ACCOUNT_BAND;
	const now = Date.now();
	k.coolDown("own", new Headers({ "retry-after": "600" }), now);
	assert.deepEqual(k.plan(now + 1000).map(a => a.id), ["minarabench", "own"]);
});

test("pinning tries one account only", () => {
	k.setChoice("own"); assert.deepEqual(ids(), ["own"]);
	k.setChoice("minarabench"); assert.deepEqual(ids(), ["minarabench"]);
	k.setChoice("auto");
});

test("% left is the tighter of the 5-hour and weekly windows; footer shows it", () => {
	const u = k.leftFromUsage({ five_hour: { utilization: 63, resets_at: "a" }, seven_day: { utilization: 99, resets_at: "b" }, extra: null });
	assert.deepEqual(u, { left: 1, resetsAt: "b" });
	k.recordUsage("minarabench", { left: 80, coolUntil: 0 });
	assert.equal(k.footerLabel(), "minarabench 80%");
	k.setChoice("own"); assert.match(k.footerLabel(), /^brook \d+% \(pinned\)$/); k.setChoice("auto");
});

