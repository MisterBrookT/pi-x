import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
		const definitions = loaded.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
		const diagnostics = definitions.find(tool => tool.name === "lsp_diagnostics");
		assert.deepEqual(diagnostics.promptGuidelines, ["Use configured LSP servers for targeted diagnostics. If a server is unavailable, report that and use the project's checks."]);
		assert.equal(definitions.find(tool => tool.name === "lsp_fix").promptGuidelines.length, 1);
		assert.doesNotMatch(definitions.find(tool => tool.name === "subagent").promptGuidelines.join("\n"), /workflowScript/);
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

test("the supervisor channel is described by when to use it, not by upstream internals", async () => {
	const { supervisorDescription } = await import("../src/subagent-policy.ts");
	assert.match(supervisorDescription, /^Answer a subagent that has paused for a decision/);
	assert.doesNotMatch(supervisorDescription, /pi-intercom|Native/);
	for (const action of ["pending", "reply", "send", "ask", "list", "status"]) assert.ok(supervisorDescription.includes(action), action);
	const source = await readFile(new URL("../extensions/upstream-tools.ts", import.meta.url), "utf8");
	assert.match(source, /tool\.name === "subagent_supervisor"[\s\S]*description: supervisorDescription/, "the override is wired into upstream registration");
});
