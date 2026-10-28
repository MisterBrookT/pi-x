import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState } from "../plugins/foryou/proactive.ts";

test("saveState writes cursors at once and atomically (no temp file left)", () => {
	const d = mkdtempSync(join(tmpdir(), "pix-state-"));
	const f = join(d, "state.json");
	saveState(f, { "wechat:a@chatroom": "36410" });
	assert.equal(JSON.parse(readFileSync(f, "utf8"))["wechat:a@chatroom"], "36410");
	assert.deepEqual(readdirSync(d), ["state.json"]);
});

test("daemon saves state on every cursor move, so a mid-tick restart does not judge the same batch twice (10-28 07:14)", () => {
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /const mark = \(\) => \{[^\n]*saveState\(P\.state, state\)/);
});

test("health: an old error for a chat no longer in the recent list is dropped; one still listed stays", async () => {
	const { trackHealth } = await import("../plugins/foryou/proactive.ts");
	const old = {
		"WeChat: Aur0raL": { source: "WeChat: Aur0raL", since: "2026-10-15", times: 1, error: "Command failed: wechat-cli msg get_message talker : x limit :3" },
		"WeChat: 龙哥": { source: "WeChat: 龙哥", since: "2026-10-26", times: 2, error: "boom" },
		Gmail: { source: "Gmail", since: "2026-10-26", times: 3, error: "login expired" },
	};
	const next = trackHealth(old, [], [], "2026-10-28", ["WeChat: 龙哥", "WeChat"]);
	assert.deepEqual(Object.keys(next).sort(), ["Gmail", "WeChat: 龙哥"]);
	assert.deepEqual(Object.keys(trackHealth(old, [], [], "2026-10-28")).length, 3, "without a current list nothing is pruned");
});

test("daemon runs the read-only WeChat screen check and reports a failure as a health problem", () => {
	const src = readFileSync(new URL("../plugins/foryou/daemon.ts", import.meta.url), "utf8");
	assert.match(src, /\[script, "check"\]/);
	assert.match(src, /failed\.push\(\{ source: "WeChat screen"/);
	assert.doesNotMatch(src, /\[script, "(find|send|sendnow|prepare)"/);
});
