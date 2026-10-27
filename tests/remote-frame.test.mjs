import assert from "node:assert/strict";
import test from "node:test";
import { frameAllowed, frameCheck } from "../plugins/remote/remote-frame.ts";

const h = o => new Headers(o);
test("frame check: X-Frame-Options and CSP frame-ancestors block; plain pages pass", async () => {
	assert.equal(frameAllowed(h({})).ok, true);
	assert.equal(frameAllowed(h({ "x-frame-options": "DENY" })).ok, false);
	assert.equal(frameAllowed(h({ "x-frame-options": "sameorigin" })).ok, false);
	assert.equal(frameAllowed(h({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" })).ok, false);
	assert.equal(frameAllowed(h({ "content-security-policy": "frame-ancestors *" })).ok, true);
	assert.equal(frameAllowed(h({ "content-security-policy": "default-src 'self'" })).ok, true);
	assert.match(frameAllowed(h({ "x-frame-options": "DENY" })).reason, /X-Frame-Options: DENY/);
	assert.equal((await frameCheck("javascript:alert(1)")).ok, false);
	assert.equal((await frameCheck("https://x.test/", async () => new Response("", { headers: { "x-frame-options": "DENY" } }))).ok, false);
	assert.equal((await frameCheck("https://x.test/", async () => { throw new Error("offline"); })).ok, true, "unknown: let the pane try");
});
