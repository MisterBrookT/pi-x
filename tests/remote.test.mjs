import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import registerRemote, { shouldShowRemotePairing } from "../plugins/remote/index.ts";
import { fitRemoteSnapshot, readRemoteToken, startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { prepareRemotePairing, privateServeUrl } from "../plugins/remote/remote-pair.ts";
import { branchMessages, remoteMessages, remoteMedia } from "../plugins/remote/remote-state.ts";
import { remoteAppHtml } from "../plugins/remote/remote-web.ts";
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
  const [message] = remoteMessages([{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "plugins/remote/remote-web.ts" } }] }]);
  assert.equal(message.tools[0].label, "plugins/remote/remote-web.ts");
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

test("the phone can switch a real Pi session's model and thinking level, only among offered choices", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 });
  const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const h = await goalSession(t, () => say("ok"), { tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] });
  await h.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`, id = h.session.sessionManager.getSessionId();
  const get = async () => (await fetch(`${base}/api/sessions/${id}`, { headers })).json();
  const until = async (predicate, what) => { for (let i = 0; i < 100; i++) { const s = await get(); if (predicate(s)) return s; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  const start = await until(s => s.model && s.models?.length > 1, "the phone sees the current model and choices");
  assert.equal(start.model.id, `${h.session.model.provider}/${h.session.model.id}`);
  assert.equal(start.context?.window, h.session.getContextUsage()?.contextWindow, "the phone sees the context window");
  const target = start.models.find(m => m.id !== start.model.id);
  const act = body => fetch(`${base}/api/sessions/${id}/action`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await act({ action: "model", value: "evil/not-offered" })).status, 400, "only offered models");
  assert.equal((await act({ action: "thinking", value: "ultra" })).status, 400, "only offered levels");
  assert.equal((await act({ action: "model", value: target.id })).status, 202);
  await until(s => s.model.id === target.id, "the phone sees the switch");
  assert.equal(`${h.session.model.provider}/${h.session.model.id}`, target.id, "real Pi switched model");
  const after = await get();
  const level = after.thinkingLevels.find(l => l !== after.thinking);
  assert.ok(level, "the test model offers more than one thinking level");
  {
    assert.equal((await act({ action: "thinking", value: level })).status, 202);
    await until(s => s.thinking === level, "the phone sees the new thinking level");
    assert.equal(h.session.thinkingLevel, level, "real Pi switched thinking level");
  }
});

test("the phone sees the current todo plan from a real Pi session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-todo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 });
  const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const { default: registerTodo } = await import("../plugins/todo/index.ts");
  const replies = [
    () => call("todo", { action: "replace", items: [{ text: "Read" }, { text: "Fix" }] }),
    () => say("planned"),
    () => call("todo", { action: "set", id: "1", status: "done" }, "t2"),
    () => say("one done"),
  ];
  const h = await goalSession(t, () => replies.shift()(), { tools: ["todo"], extensions: [registerTodo, pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] });
  await h.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}` };
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/sessions/${h.session.sessionManager.getSessionId()}`, { headers })).json();
  await h.session.prompt("plan");
  await h.session.prompt("continue");
  let todos;
  for (let i = 0; i < 60; i++) { todos = (await get()).todos; if (todos?.[0]?.status === "done") break; await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(todos?.map(x => [x.text, x.status]), [["Read", "done"], ["Fix", "pending"]]);
});

test("live text reaches phones as small stream events, not whole-session updates", async t => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: true, messages: Array.from({ length: 50 }, (_, i) => ({ role: "user", text: "x".repeat(2000) + i })) }) });
  const controller = new AbortController(); t.after(() => controller.abort());
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: controller.signal });
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const nextEvent = async name => { for (;;) { const i = buffer.indexOf("\n\n"); if (i >= 0) { const block = buffer.slice(0, i); buffer = buffer.slice(i + 2); if (block.startsWith(`event: ${name}\n`)) return block; continue; } const { value } = await reader.read(); buffer += decoder.decode(value, { stream: true }); } };
  await nextEvent("sessions");
  const put = await fetch(`${base}/agent/s1/stream`, { method: "PUT", headers: auth, body: JSON.stringify({ streaming: "Hello wor", streamingHtml: "<p>Hello wor</p>" }) });
  assert.equal(put.status, 200);
  const block = await nextEvent("stream");
  assert.ok(block.length < 500, `a stream event carries only the live text (${block.length} bytes)`);
  assert.deepEqual(JSON.parse(block.split("data: ")[1]), { id: "s1", streaming: "Hello wor", streamingHtml: "<p>Hello wor</p>" });
  assert.equal((await (await fetch(`${base}/api/sessions/s1`, { headers: auth })).json()).streaming, "Hello wor", "a phone that opens later still sees it");
  assert.equal((await fetch(`${base}/agent/nope/stream`, { method: "PUT", headers: auth, body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/agent/s1/stream`, { method: "PUT", body: "{}" })).status, 401);
});

test("half-written markdown in live text renders as if already closed", async () => {
  const { default: remend } = await import("remend");
  const { renderRemoteMarkdown } = await import("../plugins/remote/remote-markdown.ts");
  assert.match(renderRemoteMarkdown(remend("Hello **wor")), /<strong>wor<\/strong>/);
  assert.match(await readFile(new URL("../plugins/remote/index.ts", import.meta.url), "utf8"), /renderRemoteMarkdown\(remend\(text\)/);
});

test("a hub running older Pix code reports its version and hands over when asked", async () => {
  let retired = false;
  const hub = await startRemoteHub({ token, port: 0, version: "old123", onRetire: () => { retired = true; } });
  try {
    const base = `http://127.0.0.1:${hub.port}`;
    assert.deepEqual(await (await fetch(`${base}/agent/version`, { headers: auth })).json(), { version: "old123" });
    assert.equal((await fetch(`${base}/agent/retire`, { method: "POST", body: "{}" })).status, 401, "only the Mac's own sessions may retire it");
    assert.equal((await fetch(`${base}/agent/retire`, { method: "POST", headers: auth, body: "{}" })).status, 200);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(retired, true);
  } finally { await hub.close(); }
});

test("reload with an unreachable relay returns at once and keeps remote on", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-remote-slowrelay-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const tokenPath = join(dir, "token");
	const probe = await startRemoteHub({ token: "x".repeat(40), port: 0 });
	const port = probe.port;
	await probe.close();
	// Port 1 refuses connections, like a relay the network cannot reach.
	const h = await goalSession(t, () => say("ok"), {
		tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "http://127.0.0.1:1", relayKeyPath: join(dir, "relay-key") })],
	});
	// Remote was on via relay before this reload.
	globalThis.__pixRemoteReloadResume.set(h.session.sessionManager.getSessionId(), { relay: true });
	const started = Date.now();
	await h.session.reload();
	assert.ok(Date.now() - started < 3000, `reload waited ${Date.now() - started}ms for the relay`);
	const secret = (await readFile(tokenPath, "utf8")).trim();
	const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${secret}` } })).json();
	assert.equal(list.length, 1, "remote stays on while the relay retries in the background");
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
});

test("/rc with a slow relay warns but keeps remote on", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pix-remote-rcslow-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const tokenPath = join(dir, "token");
	const probe = await startRemoteHub({ token: "x".repeat(40), port: 0 });
	const port = probe.port;
	await probe.close();
	const h = await goalSession(t, () => say("ok"), {
		tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "http://127.0.0.1:1", relayKeyPath: join(dir, "relay-key") })],
	});
	const notes = [];
	const ui = h.session.extensionRunner.uiContext ?? {};
	const orig = ui.notify?.bind(ui);
	if (ui.notify) ui.notify = (m, l) => { notes.push([l, m]); orig(m, l); };
	await h.session.prompt("/rc");
	const secret = (await readFile(tokenPath, "utf8")).trim();
	const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${secret}` } })).json();
	assert.equal(list.length, 1, "remote stays on and retries instead of failing");
	assert.ok(!notes.some(([l]) => l === "error"), `no error: ${JSON.stringify(notes)}`);
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
});

test("interactive Pi turns remote on with whatever is paired; other modes and subagents stay off", async () => {
  const { remoteAutostartMode: m } = await import("../plugins/remote/index.ts");
  const both = { relay: true, tailnet: true };
  assert.equal(m({ env: {}, mode: "tui", ...both }), "relay");
  assert.equal(m({ env: {}, mode: "tui", relay: false, tailnet: true }), "tailnet");
  assert.equal(m({ env: {}, mode: "tui", relay: false, tailnet: false }), undefined, "nothing paired");
  for (const mode of ["print", "json", "rpc"]) assert.equal(m({ env: {}, mode, ...both }), undefined, mode);
  assert.equal(m({ env: { PI_SUBAGENT_CHILD: "1" }, mode: "tui", ...both }), undefined);
  assert.equal(m({ env: { PI_SUBAGENT_DEPTH: "1" }, mode: "tui", ...both }), undefined);
  assert.equal(m({ env: { PIX_REMOTE_AUTOSTART: "0" }, mode: "tui", ...both }), undefined);
  assert.equal(m({ env: { PIX_REMOTE_AUTOSTART: "tailnet" }, mode: "tui", ...both }), "tailnet");
  assert.equal(m({ env: { PIX_REMOTE_AUTOSTART: "relay" }, mode: "rpc", relay: true, tailnet: false }), "relay", "phone-launched Pi keeps explicit mode");
  assert.equal(m({ env: { PIX_REMOTE_AUTOSTART: "relay" }, mode: "tui", relay: false, tailnet: false }), "tailnet");
});

test("regression (lost messages): a phone retry with the same id is queued once (double-submit / retry after a lost reply)", async (t) => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", messages: [] }) });
  const post = (cid, text) => fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ cid, text }) });
  assert.equal((await post("cid-aaaaaaaa", "hello")).status, 202);
  const dup = await (await post("cid-aaaaaaaa", "hello")).json();
  assert.equal(dup.duplicate, true, "the retry is acknowledged, not queued again");
  assert.equal((await post("cid-bbbbbbbb", "hello")).status, 202, "a new message with the same text is a new message");
  assert.deepEqual(await (await fetch(`${base}/agent/s1/next`, { headers: auth })).json(), { prompts: ["hello", "hello"] });
});

test("regression (lost on reconnect): a message that arrives while the Mac's poll is dropping is kept for the next poll", async (t) => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", messages: [] }) });
  // The Mac's long poll dies (sleep, network change) without the hub noticing yet.
  const ac = new AbortController();
  const dead = fetch(`${base}/agent/s1/next`, { headers: auth, signal: ac.signal }).catch(() => {});
  await new Promise(r => setTimeout(r, 30));
  ac.abort(); await dead;
  // Race: the phone's message lands on that dead poll before its close is processed.
  await fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ cid: "cid-cccccccc", text: "survives" }) });
  assert.deepEqual(await (await fetch(`${base}/agent/s1/next`, { headers: auth })).json(), { prompts: ["survives"] });
});

test("regression (question + following message): answering a question by typing, then sending another message, delivers both", async (t) => {
  const { QUESTION_OPEN, QUESTION_ANSWER, QUESTION_CLOSE } = await import("../plugins/core/question-events.ts");
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-q-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "token");
  const probe = await startRemoteHub({ token, port: 0 }); const port = probe.port; await probe.close();
  let bus;
  const h = await goalSession(t, ({ context }) => say(`echo: ${context.messages.at(-1).content.map((p) => p.text ?? "").join("")}`), {
    tools: [], extensions: [(pi) => { bus = pi.events; }, (pi) => registerRemote(pi, { port, tokenPath, relayUrl: "" })],
  });
  await h.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`, id = h.session.sessionManager.getSessionId();
  const answers = [];
  bus.on(QUESTION_ANSWER, d => { answers.push(d.answer); setTimeout(() => bus.emit(QUESTION_CLOSE, { id: d.id }), 300); });
  bus.emit(QUESTION_OPEN, { id: "q1", question: "Which?", options: [{ label: "A" }] });
  const post = (cid, text) => fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers, body: JSON.stringify({ cid, text }) });
  await post("cid-q1aaaaaa", "my own answer");
  await new Promise(r => setTimeout(r, 80));
  await post("cid-q1bbbbbb", "and one more thing");   // sent before the picker has closed
  await h.until(() => h.session.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("and one more thing")));
  assert.deepEqual(answers, ["my own answer"], "the second message is not swallowed as another answer");
  await new Promise(r => setTimeout(r, 400)); // let the picker's close land before teardown
  await h.until(() => h.settledCount() >= 1);
});

test("regression (retry after timeout): the phone retries a send whose reply was lost, with the same id, so the Mac gets it exactly once", async (t) => {
  const { chromium, devices } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", cwd: "/tmp", messages: [] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  // First try: the hub receives it, but the reply is lost on the way back (iOS backgrounding, relay drop).
  let tries = 0;
  await page.route("**/api/sessions/s1/prompt", async route => {
    tries++;
    const res = await route.fetch();
    if (tries === 1) return route.abort("failed");
    return route.fulfill({ response: res });
  });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator("#input").fill("did it arrive?");
  await page.locator("#send").click();
  for (let i = 0; i < 100 && tries < 2; i++) await page.waitForTimeout(100);
  await page.waitForFunction(() => !document.querySelector("#composerStatus").textContent.includes("Sending"), null, { timeout: 15000 });
  const got = await (await fetch(`${base}/agent/s1/next`, { headers: auth })).json();
  assert.equal(tries >= 2, true, "retried");
  assert.deepEqual(got.prompts, ["did it arrive?"], "queued exactly once");
  assert.doesNotMatch(await page.locator("#composerStatus").textContent(), /Not sent/);
});

test("regression (Image unavailable after reconnect): the hub tells a session when it has none of its images, so they are uploaded again", async (t) => {
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const put = async () => (await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "demo", messages: [] }) })).json();
  assert.equal((await put()).fresh, true, "a hub that just started has no images from this session");
  const media = remoteMedia([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: Buffer.from("fixture image").toString("base64") }] }])[0];
  await fetch(`${base}/agent/s1/media/${media.id}`, { method: "PUT", headers: auth, body: JSON.stringify(media) });
  assert.equal((await put()).fresh, false, "once uploaded, the session is not asked again");
});

test("regression (blank page after send): when the transcript shrinks under the reader, the page jumps to the newest message instead of showing nothing", async (t) => {
  const { chromium, devices } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const long = Array.from({ length: 60 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "message " + i + " " + "words ".repeat(120) }));
  const put = messages => fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", busy: true, messages }) });
  await put(long);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector("#messages .msg");
  // The reader is scrolled up in a long chat; then the Mac sends a much shorter window (a reload, a compaction, the snapshot cap).
  // iOS keeps a stale scroll offset while momentum or the keyboard settles; reproduce "no message in view" directly:
  // a tall gap above the messages and the reader scrolled into it.
  await page.evaluate(() => { const c = document.getElementById("chat"); c.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 })); const gap = document.createElement("style"); gap.id = "gap"; gap.textContent = "#messages{padding-top:30000px}"; document.head.append(gap); c.scrollTop = 0; });
  await page.evaluate(() => { setFollow(false); renderChat(false); });
  await page.waitForTimeout(100);
  const visible = await page.evaluate(() => { const r = document.getElementById("chat").getBoundingClientRect(); return [...document.querySelectorAll("#messages .msg")].some(e => { const b = e.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }); });
  assert.equal(visible, true, "some message is on screen");
});

test("regression (Resume session popped up over For you): a slow past-session list does not open after brook moved on", async (t) => {
  const { chromium, devices } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  for (const id of ["s1", "s2"]) await fetch(`${base}/agent/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: id, cwd: "/tmp", messages: [] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  let release;
  await page.route("**/api/past", async route => { await new Promise(r => { release = r; }); await route.fulfill({ json: [{ path: "/x.jsonl", name: "old chat", cwd: "~", modified: Date.now() }] }); });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector('#sessions .row[data-id="s2"]', { state: "attached" });
  await page.evaluate(() => { setDrawer(true); document.getElementById("resumeSession").click(); });
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !release; i++) await page.waitForTimeout(50);
  await page.evaluate(() => open("s2"));
  release();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.getElementById("sheet").hidden), true, "no Resume sheet over the session");
});

test("regression (blank page while typing): when the chat area resizes (keyboard, attached image) with nothing in view, it jumps back to the newest message", async (t) => {
  const { chromium, devices } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const long = Array.from({ length: 40 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", text: "message " + i + " " + "words ".repeat(80) }));
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: long }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector("#messages .msg");
  // Stale scroll in an empty gap (what iOS leaves when the keyboard opens), then only the chat's size changes; no new messages.
  await page.evaluate(() => { const g = document.createElement("style"); g.textContent = "#messages{padding-top:30000px}"; document.head.append(g); setFollow(false); document.getElementById("chat").scrollTop = 0; });
  await page.evaluate(() => { document.documentElement.style.setProperty("--keyboard-offset", "300px"); });
  await page.waitForTimeout(200);
  const visible = await page.evaluate(() => { const r = document.getElementById("chat").getBoundingClientRect(); return [...document.querySelectorAll("#messages .msg")].some(e => { const b = e.getBoundingClientRect(); return b.bottom > r.top && b.top < r.bottom; }); });
  assert.equal(visible, true);
});

test("two helpers show as one row ('2 workers'), tap to see each", async (t) => {
  const { chromium, devices } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", busy: true, messages: [{ id: "a", role: "user", text: "hi" }], helpers: [{ id: "h1", agent: "worker", tools: 15, idleMs: 33000, task: "A" }, { id: "h2", agent: "worker", tools: 10, idleMs: 540000, task: "B" }] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  const row = page.locator("#helpers > details");
  await row.first().waitFor();
  assert.equal(await row.count(), 1);
  assert.match(await row.locator("summary").first().textContent(), /2 workers\s*· 25 tools · active 33s ago/);
  await row.locator("summary").first().click();
  assert.equal(await page.locator("#helpers .helper-list .helper").count(), 2);
});

test("no green or orange status dots anywhere on the phone page (design.md: calm first)", async () => {
  const { remoteWebPage } = await import("../plugins/remote/remote-web.ts").catch(() => ({}));
  const src = (await import("node:fs")).readFileSync(new URL("../plugins/remote/remote-web.ts", import.meta.url), "utf8");
  for (const c of ["#34c759", "#ff9f0a", "#3a9b5c", "52,199,89"]) assert.ok(!src.includes(c), "no " + c);
  assert.match(src, /\.dot,\.helper \.dot,\.tl-pdot,\.ln-dot\{display:none!important\}/);
});

test("iPad / wide: drag the sessions edge to resize (remembered), ⌘B hides sessions, ⌘E docks files beside the chat", async (t) => {
  const { chromium } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: [{ id: "a", role: "user", text: "hi" }] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.on("pageerror", e => { throw e; });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector("#messages .msg");
  const listW = () => page.evaluate(() => Math.round(document.querySelector(".list").getBoundingClientRect().width));
  const edge = await listW();
  await page.mouse.move(edge - 2, 400); await page.mouse.down(); await page.mouse.move(250, 400, { steps: 5 }); await page.mouse.up();
  assert.ok(Math.abs((await listW()) - 250) <= 2, "resized by drag");
  await page.reload(); await page.waitForSelector("#messages .msg");
  assert.ok(Math.abs((await listW()) - 250) <= 2, "width remembered");
  await page.keyboard.press("Meta+b");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".list").isVisible(), false, "⌘B hides sessions");
  await page.keyboard.press("Meta+b");
  assert.equal(await page.locator(".list").isVisible(), true);
  await page.keyboard.press("Meta+Shift+L");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".list").isVisible(), false, "⌘⇧L hides sessions, like Otty");
  await page.keyboard.press("Meta+Shift+L");
  await page.keyboard.press("Meta+Shift+I");
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.body.classList.contains("files-open")), true, "⌘⇧I opens files, like Otty");
  await page.keyboard.press("Meta+Shift+I");
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({ main: document.querySelector(".main").getBoundingClientRect().right, files: document.getElementById("filesPanel").getBoundingClientRect().left, shade: getComputedStyle(document.getElementById("shade")).opacity }));
  assert.ok(r.main <= r.files + 1, "files sit beside the chat, not over it");
  assert.equal(r.shade, "0", "no grey shade over the chat");
});

test("⌘⇧L slides the sessions panel out instead of snapping (wide screens)", async (t) => {
  const { chromium } = await import("playwright");
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "pix", cwd: "/tmp", messages: [{ id: "a", role: "user", text: "hi" }] }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector("#messages .msg");
  await page.keyboard.press("Meta+Shift+L");
  const mid = await page.evaluate(() => document.querySelector(".list").getBoundingClientRect().right);
  assert.ok(mid > 5, "still partly on screen right after the key: it animates");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".list").isVisible(), false, "hidden at the end");
  assert.ok(await page.evaluate(() => document.querySelector(".main").getBoundingClientRect().left) < 2, "chat takes the full width");
});
