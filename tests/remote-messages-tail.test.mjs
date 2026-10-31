import assert from "node:assert/strict";
import test from "node:test";
import { remoteMessages } from "../plugins/remote/remote-state.ts";

test("remoteMessages renders only from `from` but keeps full-branch ids and tool pairing (long sessions pushed in ~1 s)", () => {
	const msgs = [];
	for (let i = 0; i < 300; i++) {
		msgs.push({ role: "user", content: `ask ${i}`, timestamp: i });
		msgs.push({ role: "assistant", content: [{ type: "text", text: `**ok** ${i}` }, { type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: "ls" } }], timestamp: i });
		msgs.push({ role: "toolResult", toolCallId: `t${i}`, toolName: "bash", content: [{ type: "text", text: "out" }], timestamp: i });
	}
	const full = remoteMessages(msgs).slice(-50), tail = remoteMessages(msgs, undefined, msgs.length - 150).slice(-50);
	assert.deepEqual(tail, full);
});
