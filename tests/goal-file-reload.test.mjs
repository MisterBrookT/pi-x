import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { goalSession, say } from "./helpers/goal-session.mjs";

test("file-based reload replaces the old input-pause handler and preserves the goal", { timeout: 20000 }, async t => {
	const dir = await mkdtemp(join(tmpdir(), "pix-goal-reload-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "goal.ts");
	// Use the production source through Pi's real file loader, not a retained
	// factory import. Absolute dependencies let the fixture live outside the repo.
	const current = (await readFile(new URL("../extensions/goal.ts", import.meta.url), "utf8"))
		.replaceAll('"../src/', `"${fileURLToPath(new URL("../src/", import.meta.url))}`);
	const anchor = '\tpi.on("agent_start",';
	assert.ok(current.includes(anchor));
	const legacy = current.replace(anchor, '\tpi.on("input", (event, ctx) => { if (event.source !== "extension") pause("User input; use /goal resume when ready.", ctx); });\n' + anchor);
	await writeFile(path, legacy);
	const pendingExtension = pi => pi.events.on("pix:background-state:query", query => { query.running += 1; });
	const h = await goalSession(t, () => say("Waiting on existing work."), { goalExtensionPath: path, extensions: [pendingExtension] });
	await h.session.prompt("/goal Keep this goal through a code update.");
	await h.until(() => h.settledCount() === 1);
	await h.session.prompt("Check progress.");
	await h.until(() => h.settledCount() === 2);
	assert.equal(h.state().status, "paused", "the legacy handler reproduces the reported bug");
	assert.match(h.state().reason, /User input/);
	await h.session.prompt("/goal resume");
	await h.until(() => h.settledCount() === 3);
	const before = structuredClone(h.state());

	await writeFile(path, current);
	await h.session.reload();
	assert.deepEqual(h.state(), before);
	await h.session.prompt("Check progress again after reload.");
	await h.until(() => h.settledCount() === 4);
	assert.deepEqual(h.state(), before, "new input must not invoke the removed handler");
	assert.deepEqual(h.extensionErrors, []);
});
