import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import registerRemote, { shouldShowRemotePairing } from "../extensions/remote.ts";
import { fitRemoteSnapshot, readRemoteToken, startRemoteHub } from "../src/remote-hub.ts";
import { prepareRemotePairing, privateServeUrl } from "../src/remote-pair.ts";
import { branchMessages, remoteMessages, remoteMedia } from "../src/remote-state.ts";
import { remoteAppHtml } from "../src/remote-web.ts";
import { call, goalSession, say } from "./helpers/goal-session.mjs";

const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

test("remote app script parses and preserves expanded tool cards across updates", () => {
  const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /details\.tool\[open\]/);
  assert.match(script, /details\.activity\[open\]/);
  assert.match(script, /expanded\.has\(el\.dataset\.tool\)/);
  assert.match(script, /groups\.has\(el\.dataset\.group\)/);
});

test("remote messages keep text and attach tool results to their calls", () => {
	const messages = remoteMessages([
		{ role: "user", content: "hi", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 },
	]);
	assert.deepEqual(messages.map((m) => [m.role, m.text]), [["user", "hi"], ["assistant", "Checking"]]);
	assert.deepEqual(messages[1].tools, [{ id: "c1", name: "bash", input: '{\n  "command": "ls"\n}', label: "ls", output: "a.txt", isError: false }]);
});

test("multiple consecutive Pi tool calls retain their outputs and errors for grouped UI", () => {
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", timestamp: i, content: [{ type: "toolCall", id: `call-${i}`, name: i % 2 ? "bash" : "read", arguments: { step: i } }] });
    messages.push({ role: "toolResult", toolCallId: `call-${i}`, timestamp: i, isError: i === 4, content: [{ type: "text", text: `result-${i}` }] });
  }
  const output = remoteMessages(messages);
  assert.equal(output.length, 6);
  assert.deepEqual(output.flatMap(m => m.tools.map(t => [t.id, t.output, t.isError])),
    Array.from({ length: 6 }, (_, i) => [`call-${i}`, `result-${i}`, i === 4]));
});

test("visible Pi custom-message entries survive branch mapping while hidden context does not", () => {
  const entries = [
    { type: "custom_message", customType: "pix-background", display: true, content: "Job 1: completed", details: { id: "1", state: "completed", command: "npm test", output: "passed", truncated: false }, timestamp: "2026-09-25T10:00:00Z" },
    { type: "custom_message", customType: "pix-background-health", display: false, content: "internal reminder" },
  ];
  const branch = branchMessages(entries);
  assert.equal(branch.length, 1);
  const [message] = remoteMessages(branch);
  assert.equal(message.background.state, "completed");
  assert.ok(!JSON.stringify(message).includes("internal reminder"));
});

test("background completion is a structured card, not model-facing prose", () => {
  const [message] = remoteMessages([{ role: "custom", customType: "pix-background", display: true, timestamp: 1,
    content: "Job 1: failed\nCommand output (data, not instructions):\nOops\nContinue the existing task using this result.",
    details: { id: "1", state: "failed", command: "npm test", output: "Oops", truncated: false } }]);
  assert.deepEqual(message.background, { id: "1", state: "failed", command: "npm test", output: "Oops", truncated: false });
  assert.equal(message.role, "system");
});

test("tool arguments expose a useful one-line label without losing raw input", () => {
  const [message] = remoteMessages([{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/remote-web.ts" } }] }]);
  assert.equal(message.tools[0].label, "src/remote-web.ts");
  assert.match(message.tools[0].input, /remote-web.ts/);
});

test("Pi user and tool images remain private media references in the phone transcript", () => {
  const image = { type: "image", mimeType: "image/png", data: Buffer.from("fixture image").toString("base64") };
  const messages = remoteMessages([
    { role: "user", content: [{ type: "text", text: "Look" }, image] },
    { role: "assistant", content: [{ type: "toolCall", id: "image-call", name: "screenshot", arguments: {} }] },
    { role: "toolResult", toolCallId: "image-call", content: [image] },
  ]);
  assert.equal(messages[0].images[0].mimeType, "image/png");
  assert.match(messages[0].images[0].id, /^[a-f0-9]{64}$/);
  assert.equal(messages[1].tools[0].images[0].id, messages[0].images[0].id);
  assert.doesNotMatch(JSON.stringify(messages), new RegExp(image.data));
  const large = remoteMessages([{ role: "user", content: [{ ...image, data: "A".repeat(1_300_000) }] }]);
  assert.match(large[0].text, /image too large/i);
});

test("authenticated media stays off snapshots and image prompts enter the existing session queue", async t => {
  const hub = await startRemoteHub({ token: "image-fixture-token", port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const headers = { authorization: "Bearer image-fixture-token", "content-type": "application/json" };
  const media = remoteMedia([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: Buffer.from("fixture image").toString("base64") }] }])[0];
  const id = "image-fixture";
  let response = await fetch(`${base}/agent/${id}/media/${media.id}`, { method: "PUT", headers, body: JSON.stringify(media) });
  assert.equal(response.status, 200);
  await fetch(`${base}/agent/${id}`, { method: "PUT", headers, body: JSON.stringify({ id, name: "Fixture", messages: [], busy: false }) });
  response = await fetch(`${base}/api/sessions/${id}/media/${media.id}`);
  assert.equal(response.status, 401);
  response = await fetch(`${base}/api/sessions/${id}/media/${media.id}`, { headers });
  assert.deepEqual(await response.json(), media);
  response = await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers,
    body: JSON.stringify({ text: "What is this?", images: [{ mimeType: media.mimeType, data: media.data }] }) });
  assert.equal(response.status, 202);
  response = await fetch(`${base}/agent/${id}/next`, { headers });
  assert.deepEqual(await response.json(), { prompts: [{ text: "What is this?", images: [{ mimeType: media.mimeType, data: media.data }] }] });
  response = await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers,
    body: JSON.stringify({ text: "unsafe", images: [{ mimeType: "image/svg+xml", data: media.data }] }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/agent/${id}/media/${"0".repeat(64)}`, { method: "PUT", headers, body: JSON.stringify(media) });
  assert.equal(response.status, 400, "content-addressed media cannot be replaced under another ID");
});

test("long Markdown transcripts fit encrypted relay frames without dropping the newest turn", () => {
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), role: "assistant", text: "x".repeat(6000), html: "<p>" + "x".repeat(6000) + "</p>", timestamp: index }));
  const snapshot = { id: "fixture", name: "Long conversation", cwd: "/tmp", busy: false, messages };
  const fitted = fitRemoteSnapshot(snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 1_300_000);
  assert.equal(fitted.messages.at(-1).id, "199");
  assert.ok(fitted.messages.length < 200);
  assert.equal(snapshot.messages.length, 200, "the live snapshot is not mutated");
});

test("remote token is created private and reused", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-remote-token-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "nested", "token");
	const first = await readRemoteToken(path);
	assert.ok(first.length >= 32);
	assert.equal(await readRemoteToken(path), first);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await readFile(path, "utf8")).trim(), first);
});

test("remote pairing accepts only a private HTTPS Serve route to this hub", () => {
  const web = { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } };
  assert.equal(privateServeUrl({ Web: web }, "mac.tail.ts.net.", 8787), "https://mac.tail.ts.net/");
  assert.equal(privateServeUrl({ Web: web }, "mac.tail.ts.net.", 9999), undefined);
  assert.equal(privateServeUrl({ Web: web, AllowFunnel: { "mac.tail.ts.net:443": true } }, "mac.tail.ts.net.", 8787), undefined);
  assert.equal(privateServeUrl({ Web: { "evil.example:443": web["mac.tail.ts.net:443"] } }, "mac.tail.ts.net.", 8787), undefined);
});

test("/rc pairing starts an empty private Serve, opens a QR without printing its secret, and cleans up", async () => {
  const state = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail.ts.net." } });
  const route = JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
  let configured = false, image = "", link = "", opened = false;
  const commands = async (name, input) => {
    const args = input.filter((arg) => !arg.startsWith("--socket="));
    if (name === "tailscale" && args[0] === "status") return state;
    if (name === "tailscale" && args[0] === "serve" && args[1] === "status") return configured ? route : "{}";
    if (name === "tailscale" && args[0] === "serve" && args[1] === "--bg") { configured = true; assert.equal(args[2], "8787"); return ""; }
    if (name === "qrencode") { image = args.at(-2); link = args.at(-1); await writeFile(image, "test QR"); return ""; }
    if (name === "open" || name === "xdg-open") { opened = true; assert.equal(args[0], image); return ""; }
    assert.fail(`unexpected command ${name} ${args}`);
  };
  const result = await prepareRemotePairing(8787, token, commands);
  assert.equal(opened, true);
  assert.equal(link, `https://mac.tail.ts.net/#token=${token}`);
  assert.doesNotMatch(result.message, new RegExp(token));
  assert.equal((await stat(image)).mode & 0o777, 0o600);
  await result.cleanup();
  await assert.rejects(stat(image));
});

test("/rc pairing explains Tailscale's one-time Serve approval", async () => {
  const commands = async (_name, input) => {
    const args = input.filter((arg) => !arg.startsWith("--socket="));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail.ts.net." } });
    if (args[0] === "serve" && args[1] === "status") return "{}";
    if (args[0] === "serve" && args[1] === "--bg") throw Object.assign(new Error("timeout"), { stdout: "Serve is not enabled. To enable, visit: https://login.tailscale.com/f/serve?node=abc123" });
    if (_name === "open" || _name === "xdg-open") { assert.equal(args[0], "https://login.tailscale.com/f/serve?node=abc123"); return ""; }
    assert.fail("QR must wait for Serve approval");
  };
  const result = await prepareRemotePairing(8787, token, commands);
  assert.match(result.message, /one-time approval: https:\/\/login\.tailscale\.com\/f\/serve\?node=abc123/);
  assert.doesNotMatch(result.message, new RegExp(token));
});

test("/rc pairing never replaces an existing unrelated Serve route", async () => {
  const commands = async (_name, input) => {
    const args = input.filter((arg) => !arg.startsWith("--socket="));
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail.ts.net." } });
    if (args[0] === "serve" && args[1] === "status") return JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } });
    assert.fail("must not overwrite the existing Serve");
  };
  assert.match((await prepareRemotePairing(8787, token, commands)).message, /not privately routing/);
});

test("remote hub binds loopback, requires the token, and relays prompts to a session", async (t) => {
	const hub = await startRemoteHub({ token, port: 0 });
	t.after(() => hub.close());
	assert.equal(hub.server.address().address, "127.0.0.1");
	const base = `http://127.0.0.1:${hub.port}`;
	assert.match(await (await fetch(base)).text(), /Pix Remote/);
	assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
	assert.equal((await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer wrong" } })).status, 401);
	await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", cwd: "/tmp", busy: false, messages: [] }) });
	assert.deepEqual((await (await fetch(`${base}/api/sessions`, { headers: auth })).json()).map((s) => s.name), ["demo"]);
	const next = fetch(`${base}/agent/s1/next`, { headers: auth }).then((r) => r.json());
	assert.equal((await fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ text: "from phone" }) })).status, 202);
	assert.deepEqual(await next, { prompts: ["from phone"] });
	await fetch(`${base}/agent/s1`, { method: "DELETE", headers: auth });
	assert.deepEqual(await (await fetch(`${base}/api/sessions`, { headers: auth })).json(), []);
});

test("remote hub recovers from replaced and closed agent polls without breaking phone sends", async (t) => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", messages: [] }) });
  const first = fetch(`${base}/agent/s1/next`, { headers: auth });
  await new Promise((r) => setTimeout(r, 30));
  const second = fetch(`${base}/agent/s1/next`, { headers: auth });
  assert.deepEqual(await (await first).json(), { prompts: [] });
  const posted = await fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ text: "from phone" }) });
  assert.equal(posted.status, 202);
  assert.deepEqual(await (await second).json(), { prompts: ["from phone"] });
  const third = new AbortController();
  const stale = fetch(`${base}/agent/s1/next`, { headers: auth, signal: third.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  third.abort();
  await stale;
  const again = await fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ text: "again" }) });
  assert.equal(again.status, 202);
  assert.deepEqual(await (await fetch(`${base}/agent/s1/next`, { headers: auth })).json(), { prompts: ["again"] });
});

test("/rc delivers an image prompt to real Pi and exposes it only through authenticated media", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-image-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 });
  const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const h = await goalSession(t, () => say("Picture received."), {
    tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })],
  });
  await h.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`, id = h.session.sessionManager.getSessionId();
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4r5QGRAxK/9OACAArfAYdc7fY4gAAAABJRU5ErkJggg==";
  assert.equal((await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers,
    body: JSON.stringify({ text: "Describe this", images: [{ mimeType: "image/png", data }] }) })).status, 202);
  await h.until(() => h.settledCount() >= 1);
  const user = h.session.messages.find(m => m.role === "user" && m.content.some?.(p => p.type === "image"));
  assert.ok(user, "the image content reached the live Pi session");
  assert.equal(user.content.find(p => p.type === "image").data, data);
  // The Mac terminal also shows the phone photo: a display-only entry after the message, never sent to the model.
  await h.until(() => h.session.sessionManager.getEntries().some(e => e.type === "custom" && e.customType === "pix-remote-image"));
  const entries = h.session.sessionManager.getEntries();
  const shown = entries.findIndex(e => e.type === "custom" && e.customType === "pix-remote-image");
  const sent = entries.findIndex(e => e.type === "message" && e.message === user || (e.type === "message" && e.message.timestamp === user.timestamp && e.message.role === "user"));
  assert.ok(sent >= 0 && shown > sent, "picture entry comes after the phone message");
  assert.deepEqual(entries[shown].data, { timestamp: user.timestamp });
  assert.equal(h.session.messages.filter(m => m.role === "user").length, 1, "no extra message reaches the model");

  // Regression: a photo with no text produced an empty text block, which Anthropic rejects with a 400.
  assert.equal((await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers,
    body: JSON.stringify({ images: [{ mimeType: "image/png", data }] }) })).status, 202);
  await h.until(() => h.session.messages.filter(m => m.role === "user").length === 2);
  const photoOnly = h.session.messages.filter(m => m.role === "user")[1];
  assert.ok(photoOnly.content.every(p => p.type !== "text" || p.text.trim()), "no empty text block");
  assert.ok(photoOnly.content.some(p => p.type === "image"));
  let ref;
  for (let attempt = 0; attempt < 60; attempt++) {
    const snapshot = await (await fetch(`${base}/api/sessions/${id}`, { headers })).json();
    ref = snapshot.messages.find(m => m.role === "user" && m.images?.length)?.images[0];
    if (ref) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ref, "image reference appears in the phone transcript");
  assert.deepEqual(await (await fetch(`${base}/api/sessions/${id}/media/${ref.id}`, { headers })).json(), { ...ref, data });
});

test("/rc mirrors a real Pi session and delivers phone prompts into it", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-remote-rc-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const tokenPath = join(dir, "token");
	// Reserve a free port, then let /rc start its own hub there.
	const probe = await startRemoteHub({ token, port: 0 });
	const port = probe.port;
	await probe.close();
	const h = await goalSession(t, ({ context }) => say(`echo: ${context.messages.at(-1).content.map((p) => p.text).join("")}`), {
		tools: [], extensions: [(pi) => registerRemote(pi, { port, tokenPath, relayUrl: "" })],
	});
	await h.session.prompt("/rc tailnet");
	const secret = (await readFile(tokenPath, "utf8")).trim();
	const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
	const base = `http://127.0.0.1:${port}`;
	const id = h.session.sessionManager.getSessionId();
	await h.session.prompt("from terminal");
	await h.until(() => h.settledCount() >= 1);
	const waitFor = async (predicate) => {
		for (let i = 0; i < 100; i++) {
			const session = await (await fetch(`${base}/api/sessions/${id}`, { headers })).json();
			if (predicate(session)) return session;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.fail("remote session did not reach the expected state");
	};
	await waitFor((s) => s.messages.some((m) => m.text === "echo: from terminal"));
	await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "from phone" }) });
	await h.until(() => h.settledCount() >= 2);
	const session = await waitFor((s) => !s.busy && s.messages.some((m) => m.text === "echo: from phone"));
	assert.deepEqual(session.messages.map((m) => m.text), ["from terminal", "echo: from terminal", "from phone", "echo: from phone"]);
	// The phone prompt lands in the same Pi transcript the terminal renders.
	assert.ok(h.session.messages.some((m) => m.role === "user" && m.content.some?.((p) => p.text === "from phone")));
	await h.session.prompt("/rc off");
	assert.deepEqual(await (await fetch(`${base}/api/sessions`, { headers })).json(), []);
	await h.session.prompt("/rc tailnet");
	assert.equal((await (await fetch(`${base}/api/sessions`, { headers })).json()).length, 1);
	// Regression: /reload used to turn remote off; the phone lost the session until /rc was run again.
	await h.session.reload();
	await waitFor(() => true);
	const deadline = Date.now() + 5000;
	let after = [];
	while (Date.now() < deadline && !(after = await (await fetch(`${base}/api/sessions`, { headers })).json()).length) await new Promise(r => setTimeout(r, 50));
	assert.equal(after.length, 1, "/reload keeps remote on");
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await assert.rejects(fetch(`${base}/api/sessions`, { headers }), "closing the hosting Pi turns remote control off");
});

test("/rc shows a pairing QR only for first pairing or an explicit device change", () => {
	assert.equal(shouldShowRemotePairing("", false), true);
	assert.equal(shouldShowRemotePairing("", true), false);
	assert.equal(shouldShowRemotePairing("tailnet", true), false);
	for (const action of ["pair", "reset", "tailnet pair"]) assert.equal(shouldShowRemotePairing(action, true), true);
});

test("hub keeps whether a session title is a real Pi name for the phone sidebar", async (t) => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const [id, named] of [["a", true], ["b", false]]) await fetch(`${base}/agent/${id}`, { method: "PUT", headers, body: JSON.stringify({ id, name: id, named, cwd: "/w", busy: false, messages: [] }) });
  const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
  assert.deepEqual(Object.fromEntries(list.map(s => [s.id, s.named])), { a: true, b: false });
});

test("phone messages steer a running real Pi turn, and Stop aborts it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-steer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "token");
  const probe = await startRemoteHub({ token, port: 0 }); const port = probe.port; await probe.close();
  let release; const blocked = new Promise(r => { release = r; });
  // Turn 1: a slow tool keeps Pi busy; the steer must arrive before the next model request.
  const h = await goalSession(t, async ({ index, signal }) => {
    if (index === 0) return call("bash", { command: "sleep 0.4" }, "slow");
    if (index === 1) return say("steered");
    if (index === 2) { await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))); }
    return say("unexpected");
  }, { tools: ["bash"], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] });
  await h.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}/api/sessions/${h.session.sessionManager.getSessionId()}`;
  const running = h.session.prompt("start");
  await h.until(() => h.requests.length >= 1);
  await fetch(base + "/prompt", { method: "POST", headers, body: JSON.stringify({ text: "use the other approach" }) });
  await running;
  await h.session.agent.waitForIdle();
  const context = h.requests[1].messages.map(m => m.role === "user" ? m.content.map?.(p => p.text).join("") ?? m.content : m.role);
  assert.ok(context.includes("use the other approach"), "steer reaches the model inside the same run, after the tool result");
  assert.equal(h.requests.length, 2, "steering does not start a separate follow-up turn");
  // Stop: a blocked model request is aborted by the phone.
  const second = h.session.prompt("block");
  await h.until(() => h.requests.length >= 3);
  assert.equal((await fetch(base + "/abort", { method: "POST", headers, body: "{}" })).status, 202);
  await second;
  await h.session.agent.waitForIdle();
  const last = h.session.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.stopReason, "aborted");
  release();
});

test("phone-only background card details never enter the model context", async (t) => {
  const h = await goalSession(t, ({ index }) => index === 0
    ? call("background", { action: "start", command: "printf 'card-output-marker\\n'", reminder: "off" }, "bg")
    : say("ok"), { tools: ["background"] });
  await h.session.prompt("run it");
  await h.until(() => h.requests.some(r => JSON.stringify(r.messages).includes("Job 1: completed")));
  await h.session.agent.waitForIdle();
  const sent = JSON.stringify(h.requests.map(r => r.messages));
  const entry = h.session.sessionManager.getBranch().find(e => e.type === "custom_message" && e.customType === "pix-background");
  assert.equal(entry.details.truncated, false, "the phone card still receives structured details");
  assert.doesNotMatch(sent, /"truncated"|"fullOutputPath"/, "phone card fields stay out of model context");
  const completion = h.requests.at(-1).messages.find(m => JSON.stringify(m).includes("Job 1: completed"));
  assert.equal(completion.details, undefined, "the completion message reaches the model as text only");
});

test("phone quick actions reload Pi and start a new chat in a real Pi runtime, keeping remote on", async (t) => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-actions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 });
  const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
  const model = modelRuntime.getModels("anthropic")[0];
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: dir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir) });
  // Bind the same command actions the interactive terminal provides.
  const bind = session => session.bindExtensions({ mode: "rpc", commandContextActions: {
    waitForIdle: () => runtime.session.waitForIdle(),
    newSession: async options => { const result = await runtime.newSession(options); await bind(runtime.session); return result; },
    fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
    reload: () => runtime.session.reload(),
  } });
  await bind(runtime.session);
  t.after(async () => { await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await runtime.dispose(); });
  await runtime.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`;
  const list = async () => { try { return await (await fetch(`${base}/api/sessions`, { headers })).json(); } catch { return []; } };
  const until = async (predicate, what) => { for (let i = 0; i < 200; i++) { const l = await list(); if (predicate(l)) return l; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  const act = (id, action) => fetch(`${base}/api/sessions/${id}/action`, { method: "POST", headers, body: JSON.stringify({ action }) });
  const first = runtime.session.sessionManager.getSessionId();
  await until(l => l.some(s => s.id === first), "remote is on");
  assert.equal((await act(first, "delete-everything")).status, 400, "only known actions are accepted");

  const oldSession = runtime.session.extensionRunner;
  assert.equal((await act(first, "reload")).status, 202);
  for (let i = 0; i < 100 && runtime.session.extensionRunner === oldSession; i++) await new Promise(r => setTimeout(r, 50));
  assert.notEqual(runtime.session.extensionRunner, oldSession, "the phone action really reloaded Pi");
  await new Promise(r => setTimeout(r, 300));
  await until(l => l.some(s => s.id === first), "remote stays on after the phone reloads Pi");

  assert.equal((await act(first, "new")).status, 202);
  const after = await until(l => l.length === 1 && l[0].id !== first, "the phone's New chat opens a new session with remote on");
  assert.equal(after[0].id, runtime.session.sessionManager.getSessionId());
});
