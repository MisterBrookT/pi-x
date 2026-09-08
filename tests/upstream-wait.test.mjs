import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("real upstream registration omits bg_wait but retains delegation and other capabilities across reload", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pix-no-wait-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	const bus = createEventBus();
	for (let reload = 0; reload < 2; reload++) {
		const loaded = await loadExtensions([resolve("extensions/upstream-tools.ts")], dir, bus);
		t.after(() => loaded.runtime.invalidate());
		assert.deepEqual(loaded.errors, []);
		const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
		assert.ok(!tools.includes("bg_wait"), "removed rather than merely disabled by default");
		for (const name of ["subagent", "web_search", "lsp_diagnostics"]) assert.ok(tools.includes(name), name);
		loaded.runtime.invalidate();
	}
});

test("the installed subagent completion notifier wakes without registering any wait tool", async (t) => {
	const registerNotify = await createJiti(import.meta.url).import("../node_modules/pi-subagents/src/runs/background/notify.ts", { default: true });
	const messages = [];
	const pi = { events: createEventBus(), sendMessage: (message, options) => messages.push({ message, options }) };
	const notifier = registerNotify(pi, { currentSessionId: "session", completionOwnerId: "owner" });
	t.after(() => notifier.dispose());
	const accepted = await notifier.deliver({ source: "async", id: "job", agent: "worker", sessionId: "session", completionOwnerId: "owner", success: true, exitCode: 0, summary: "Verified result" });
	assert.equal(accepted, true);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].message.customType, "subagent-notify");
	assert.equal(messages[0].options.triggerTurn, true);
});
