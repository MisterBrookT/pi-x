import assert from "node:assert/strict";
import test from "node:test";
import mac from "../plugins/mac/index.ts";

test("/mac registers and notifies a status screen", async () => {
	const cmds = {};
	mac({ registerCommand: (n, c) => { cmds[n] = c; } });
	assert.ok(cmds.mac);
	assert.deepEqual(cmds.mac.getArgumentCompletions("pr").map((o) => o.value), ["prune", "prune --yes"]);
	const notes = [];
	await cmds.mac.handler("", { ui: { notify: (t) => notes.push(t) } });
	assert.match(notes[0], /^(fine|reboot soon|reboot now)/);
});
