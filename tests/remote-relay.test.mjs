import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { webcrypto, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayRoom, sealRelayFrame, openRelayFrame, rotateRelayKey, readRelayOrigin } from "../plugins/remote/remote-relay-agent.ts";
import { remoteRelayWebScript } from "../plugins/remote/remote-relay-web.ts";
import { remoteAppHtml } from "../plugins/remote/remote-web.ts";

const browser = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, EventTarget, MessageEvent, setTimeout, clearTimeout, console, Response, Blob, DecompressionStream });
vm.runInContext(remoteRelayWebScript, browser);
const evaluate = (expression) => vm.runInContext(expression, browser);

test("phone and Mac derive the same opaque room and AES key; frames work in both directions", async () => {
  const secret = randomBytes(32).toString("base64url");
  browser.secret = secret;
  const room = await evaluate("relayIdentity(secret).then(({room,key})=>{relayKey=key;return room})");
  assert.equal(room, relayRoom(secret));
  const outbound = await evaluate("relaySeal({kind:'request',id:'1',path:'/api/sessions',method:'GET',body:''})");
  assert.deepEqual(openRelayFrame(secret, outbound), { kind: "request", id: "1", path: "/api/sessions", method: "GET", body: "" });
  browser.frame = sealRelayFrame(secret, { kind: "event", event: "sessions", data: [{ id: "live" }] });
  assert.equal(JSON.stringify(await evaluate("relayOpen(frame)")), JSON.stringify({ kind: "event", event: "sessions", data: [{ id: "live" }] }));
});

test("wrong keys and modified encrypted frames cannot be opened", () => {
  const secret = randomBytes(32).toString("base64url");
  const frame = sealRelayFrame(secret, { kind: "request", body: "private text" });
  assert.throws(() => openRelayFrame("different", frame));
  const altered = JSON.parse(frame);
  const bytes = Buffer.from(altered.data, "base64url"); bytes[0] ^= 1;
  altered.data = bytes.toString("base64url");
  assert.throws(() => openRelayFrame(secret, JSON.stringify(altered)));
  assert.ok(!frame.includes("private text"));
});

test("relay origin is private local configuration, not a bundled personal domain", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-relay-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "relay.json");
  const previous = process.env.PIX_REMOTE_RELAY_URL;
  delete process.env.PIX_REMOTE_RELAY_URL;
  t.after(() => { if (previous === undefined) delete process.env.PIX_REMOTE_RELAY_URL; else process.env.PIX_REMOTE_RELAY_URL = previous; });
  assert.equal(await readRelayOrigin(path), "");
  await writeFile(path, JSON.stringify({ origin: "https://example.org/" }));
  assert.equal(await readRelayOrigin(path), "https://example.org");
  await writeFile(path, JSON.stringify({ origin: "http://example.org" }));
  await assert.rejects(readRelayOrigin(path), /HTTPS origin/);
  process.env.PIX_REMOTE_RELAY_URL = "https://other.example";
  assert.equal(await readRelayOrigin(path), "https://other.example");
});

test("rotation invalidates prior QR keys and preserves file privacy", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-relay-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "key");
  const first = await rotateRelayKey(path);
  const second = await rotateRelayKey(path);
  assert.notEqual(relayRoom(first), relayRoom(second));
  assert.equal((await readFile(path, "utf8")).trim(), second);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("relay uses the same mobile UI but does not send its pairing key as a bearer token", () => {
  assert.match(remoteAppHtml, /paired\?relayApi\(path,opts\)/);
  assert.match(remoteAppHtml, /paired\?relayConnect\(token\)/);
  assert.match(remoteRelayWebScript, /#|relayIdentity/);
});

test("the largest phone photo prompt fits the relay request and encrypted frame limits", async () => {
  const { relayRequestLimit, relayFrameLimit } = await import("../plugins/remote/remote-relay-agent.ts");
  // Regression: phone accepted ~1 MB photos but the Mac agent rejected bodies over 100 KB as "Prompt too long".
  const photo = "A".repeat(1_000_000), text = "x".repeat(100_000);
  const body = JSON.stringify({ text, images: [{ mimeType: "image/jpeg", data: photo }] });
  assert.ok(body.length <= relayRequestLimit, `${body.length} > ${relayRequestLimit}`);
  const frame = sealRelayFrame("k".repeat(43), { kind: "request", id: crypto.randomUUID(), path: "/api/sessions/x/prompt", method: "POST", body });
  assert.ok(frame.length <= relayFrameLimit, `${frame.length} > ${relayFrameLimit}`);
});

test("the Mac notices a relay link that silently died and reconnects", async t => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  await new Promise(r => server.once("listening", r));
  let connections = 0;
  server.on("connection", socket => {
    connections++;
    // First link answers nothing (like a socket left over after sleep); later links answer pings.
    if (connections > 1) socket.on("message", data => { if (String(data) === "ping") socket.send("pong"); });
  });
  const states = [];
  const { startRemoteRelayAgent } = await import("../plugins/remote/remote-relay-agent.ts");
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret: "s".repeat(43), localBase: "http://127.0.0.1:9", localToken: "x", heartbeatMs: 50, onState: s => states.push(s) });
  t.after(() => agent.stop());
  await agent.ready;
  for (let i = 0; i < 160 && connections < 2; i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(states.includes("stale"), "dead link is detected");
  assert.equal(connections, 2, "and replaced");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(connections, 2, "a link that answers pings is kept");
});

test("a dead relay link that never finishes closing is replaced at once, not after the close handshake", async t => {
  // Seen 10-27: 'stale' logged 83 times over 22 min before 'closed', so the phone got no progress the whole time.
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const raw = [];
  t.after(() => { for (const s of raw) s.destroy(); server.close(); });
  await new Promise(r => server.once("listening", r));
  let connections = 0;
  server.on("connection", (socket, req) => {
    connections++;
    if (connections === 1) { raw.push(req.socket); req.socket.pause(); return; } // black hole: no pong, no close reply
    socket.on("message", data => { if (String(data) === "ping") socket.send("pong"); });
  });
  const { startRemoteRelayAgent } = await import("../plugins/remote/remote-relay-agent.ts");
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret: "s".repeat(43), localBase: "http://127.0.0.1:9", localToken: "x", heartbeatMs: 50 });
  t.after(() => agent.stop());
  await agent.ready;
  for (let i = 0; i < 120 && connections < 2; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(connections, 2, "reconnects within a few heartbeats even though the old socket never closes");
});

test("the Mac relays live-text stream events to the phone", async t => {
  const { WebSocketServer } = await import("ws");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const { startRemoteRelayAgent, openRelayFrame } = await import("../plugins/remote/remote-relay-agent.ts");
  const token = "r".repeat(32), secret = "s".repeat(43), auth = { authorization: `Bearer ${token}` };
  const hub = await startRemoteHub({ token, port: 0 });
  t.after(() => hub.close());
  await fetch(`http://127.0.0.1:${hub.port}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: true, messages: [] }) });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  await new Promise(r => server.once("listening", r));
  const frames = [];
  server.on("connection", socket => socket.on("message", data => { const text = String(data); if (text === "ping") return socket.send("pong"); try { frames.push(openRelayFrame(secret, text)); } catch {} }));
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret, localBase: `http://127.0.0.1:${hub.port}`, localToken: token });
  t.after(() => agent.stop());
  await agent.ready;
  await new Promise(r => setTimeout(r, 200));
  await fetch(`http://127.0.0.1:${hub.port}/agent/s1/stream`, { method: "PUT", headers: auth, body: JSON.stringify({ streaming: "Hi", streamingHtml: "<p>Hi</p>" }) });
  for (let i = 0; i < 80 && !frames.some(f => f.event === "stream"); i++) await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(frames.find(f => f.event === "stream")?.data, { id: "s1", streaming: "Hi", streamingHtml: "<p>Hi</p>" });
});

test("frames are compressed before encryption and the phone opens them", async () => {
  const secret = randomBytes(32).toString("base64url");
  browser.secret = secret;
  await evaluate("relayIdentity(secret).then(({key})=>{relayKey=key})");
  const big = { kind: "event", event: "session", data: { messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: "assistant", text: "the same long answer text ".repeat(20) })) } };
  const frame = sealRelayFrame(secret, big);
  assert.ok(frame.length < JSON.stringify(big).length / 4, `compressed: ${frame.length}`);
  browser.frame = frame;
  assert.equal(JSON.stringify(await evaluate("relayOpen(frame)")), JSON.stringify(big));
  assert.deepEqual(openRelayFrame(secret, frame), big);
});

test("on hello the Mac sends only the shown session, tailed, not every transcript", async t => {
  const { WebSocketServer } = await import("ws");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const { startRemoteRelayAgent, relayTail } = await import("../plugins/remote/remote-relay-agent.ts");
  const token = "r".repeat(32), secret = "s".repeat(43), auth = { authorization: `Bearer ${token}` };
  const { forYouHub } = await import("../plugins/foryou/hub.ts");
  const fyDir = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "pix-relay-fy-"));
  const hub = await startRemoteHub({ token, port: 0, plugins: [forYouHub({ dir: fyDir })] });
  t.after(() => hub.close());
  // 25 turns of 4 messages: a user prompt, then assistant/tool messages.
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, role: i % 4 ? "assistant" : "user", text: `msg ${i}` }));
  for (const id of ["a", "b", "c"]) await fetch(`http://127.0.0.1:${hub.port}/agent/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: id, cwd: "/tmp", busy: false, messages }) });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  await new Promise(r => server.once("listening", r));
  const frames = [];
  server.on("connection", socket => {
    socket.on("message", data => { const text = String(data); if (text === "ping") return socket.send("pong"); try { frames.push(openRelayFrame(secret, text)); } catch {} });
    setTimeout(() => socket.send(sealRelayFrame(secret, { kind: "hello", active: "b" })), 100);
  });
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret, localBase: `http://127.0.0.1:${hub.port}`, localToken: token });
  t.after(() => agent.stop());
  await agent.ready;
  for (let i = 0; i < 80 && !frames.some(f => f.event === "session"); i++) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 150));
  const sent = frames.filter(f => f.event === "session").map(f => f.data);
  assert.deepEqual(sent.map(s => s.id), ["b"], "only the session on screen");
  const order = frames.filter(f => f.kind === "event").map(f => f.event);
  assert.ok(order.indexOf("session") < order.lastIndexOf("foryou"), "the shown session arrives before For you, so a returning phone updates first");
  assert.equal(relayTail, 5, "relay defaults to five whole turns");
  assert.equal(sent[0].messages.length, relayTail * 4, "whole turns, not a message count");
  assert.equal(sent[0].messages[0].role, "user", "starts at a user message");
  assert.equal(sent[0].older, 100 - relayTail * 4, "phone knows how many are older");
  assert.equal(sent[0].messages.at(-1).text, "msg 99");
  // The full transcript is still available on demand ("Show earlier").
  const full = await (await fetch(`http://127.0.0.1:${hub.port}/api/sessions/b`, { headers: auth })).json();
  assert.equal(full.messages.length, 100);
});

test("tailSession keeps whole turns and leaves short sessions alone", async () => {
  const { tailSession } = await import("../plugins/remote/remote-hub.ts");
  const roles = ["user", "assistant", "assistant", "user", "assistant", "user", "assistant", "user"];
  const s = { messages: roles.map((role, i) => ({ id: i, role })) };
  assert.deepEqual(tailSession(s, 2).messages.map(m => m.id), [5, 6, 7]);
  assert.equal(tailSession(s, 2).older, 5);
  assert.equal(tailSession(s, 4), s, "exactly 4 turns: nothing hidden");
  assert.equal(tailSession(s, 9), s);
  assert.equal(tailSession(s, 0), s);
});

test("when the Mac's local event stream ends or stalls, the relay listens again and resends state (phone saw no reply for an hour)", async t => {
  const http = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { startRemoteRelayAgent, openRelayFrame } = await import("../plugins/remote/remote-relay-agent.ts");
  const secret = "s".repeat(43);
  let streams = 0;
  const hub = http.createServer((req, res) => {
    if (req.url.startsWith("/api/events")) {
      streams++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streams === 1) { res.end(`event: sessions\ndata: []\n\n`); return; } // hub handed over: stream ends
      if (streams === 2) { res.write(`event: sessions\ndata: []\n\n`); return; } // stalls: no pings, never ends
      res.write(`event: stream\ndata: {"id":"s1","streaming":"reply arrived"}\n\n`); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/sessions" ? "[]" : "[]");
  });
  await new Promise(r => hub.listen(0, "127.0.0.1", r));
  t.after(() => { hub.closeAllConnections(); hub.close(); });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  await new Promise(r => server.once("listening", r));
  const frames = [];
  server.on("connection", socket => socket.on("message", data => { const text = String(data); if (text === "ping") return socket.send("pong"); try { frames.push(openRelayFrame(secret, text)); } catch {} }));
  const states = [];
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret, localBase: `http://127.0.0.1:${hub.address().port}`, localToken: "x", streamQuietMs: 200, onState: s => states.push(s) });
  t.after(() => agent.stop());
  await agent.ready;
  for (let i = 0; i < 120 && !frames.some(f => f.event === "stream"); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(states.includes("events stalled"), "a silent stream is noticed");
  assert.ok(streams >= 3, `listened again (${streams})`);
  assert.equal(frames.find(f => f.event === "stream")?.data.streaming, "reply arrived");
});

test("relay requests wait longer for big uploads: a 1.2 MB photo send is not cut off after 15 s and retried", () => {
  assert.equal(evaluate(`relayTimeout("/api/sessions/x", 0)`), 15000);
  assert.equal(evaluate(`relayTimeout("/api/sessions/x/file/preview?path=a", 0)`), 120000);
  assert.ok(evaluate(`relayTimeout("/api/sessions/x/prompt", 1200000)`) >= 75000, "about 20 KB/s worst-case uplink");
  assert.ok(evaluate(`relayTimeout("/api/sessions/x/prompt", 50000000)`) <= 180000, "capped");
});
