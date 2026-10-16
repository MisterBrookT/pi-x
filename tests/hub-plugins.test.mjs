import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { registerHubPlugin } from "../plugins/core/hub-plugin.ts";

const auth = { authorization: `Bearer ${"t".repeat(32)}` };

test("a plugin adds its own routes, phone events and session fields to the hub", async t => {
	const seen = [];
	const plugin = hub => ({
		initial: () => [["demo", { n: 1 }]],
		summary: id => id === "s1" ? { demo: true } : undefined,
		sessionJoined: id => seen.push(id),
		route: (method, path) => method === "GET" && path === "/api/demo" ? { status: 200, body: { live: hub.liveSessions().map(s => s.id) } } : undefined,
	});
	const hub = await startRemoteHub({ token: "t".repeat(32), port: 0, plugins: [plugin] });
	t.after(() => hub.close());
	const base = `http://127.0.0.1:${hub.port}`;
	await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "s1", cwd: "/tmp", busy: false, messages: [] }) });
	assert.deepEqual(await (await fetch(`${base}/api/demo`, { headers: auth })).json(), { live: ["s1"] });
	assert.deepEqual(await (await fetch(`${base}/api/extras`, { headers: auth })).json(), [["demo", { n: 1 }]]);
	assert.equal((await (await fetch(`${base}/api/sessions`, { headers: auth })).json())[0].demo, true);
	assert.deepEqual(seen, ["s1"]);
	assert.equal((await fetch(`${base}/api/foryou`, { headers: auth })).status, 404, "without the For you plugin the hub has no For you");
});

test("the relay forwards a plugin's routes only once that plugin registered", () => {
	assert.ok(!relayAllowed("/api/plugin-x", "GET"));
	registerHubPlugin("plugin-x", () => ({}), (path, method) => method === "GET" && path === "/api/plugin-x");
	assert.ok(relayAllowed("/api/plugin-x", "GET"));
	assert.ok(!relayAllowed("/api/plugin-x", "POST"));
});

test("plugins never import another plugin; shared code lives in core", () => {
	const root = new URL("../plugins/", import.meta.url).pathname;
	const bad = [];
	for (const name of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
		for (const file of readdirSync(join(root, name), { recursive: true }).filter(f => /\.ts$/.test(f))) {
			for (const m of readFileSync(join(root, name, file), "utf8").matchAll(/from\s+["']\.\.\/([\w-]+)\//g))
				if (m[1] !== "core" && m[1] !== name) bad.push(`${name}/${file} -> ${m[1]}`);
		}
	}
	assert.deepEqual([...new Set(bad)], ALLOWED);
});
// Desktop is a phone-only part of remote (no Pi extension of its own), so remote may use it.
const ALLOWED = ["remote/remote-hub.ts -> desktop", "remote/remote-web.ts -> desktop"];
