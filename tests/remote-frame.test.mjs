import assert from "node:assert/strict";
import test from "node:test";
import { frameAllowed, frameCheck, privateAddress } from "../plugins/remote/remote-frame.ts";

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
	const pub = async () => ["93.184.216.34"];
	assert.equal((await frameCheck("https://x.test/", async () => new Response("", { headers: { "x-frame-options": "DENY" } }), 5000, pub)).ok, false);
	assert.equal((await frameCheck("https://x.test/", async () => { throw new Error("offline"); }, 5000, pub)).ok, true, "unknown: let the pane try");
});

test("frame check never fetches private hosts, by name, by IP, after DNS, or via a redirect", async () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.1", "169.254.1.1", "100.64.0.1", "100.127.1.1", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(privateAddress(ip), true, ip);
	for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1"]) assert.equal(privateAddress(ip), false, ip);
	const fetched = [], f = async u => { fetched.push(u); return new Response("", { status: 302, headers: { location: "http://127.0.0.1:8787/api/sessions" } }); };
	const look = async h => h === "evil.test" ? ["192.168.1.5"] : ["93.184.216.34"];
	for (const u of ["http://127.0.0.1:8787/", "http://[::1]/", "http://mac.local/", "http://box.tail1.ts.net/", "http://localhost/", "http://evil.test/"]) {
		const r = await frameCheck(u, f, 5000, look);
		assert.equal(r.ok, true); assert.match(r.reason, /not checked/);
	}
	assert.deepEqual(fetched, [], "no private host fetched");
	const r = await frameCheck("https://public.test/", f, 5000, look);
	assert.deepEqual(fetched, ["https://public.test/"], "redirect to the hub is not followed");
	assert.match(r.reason, /not checked/);
});
