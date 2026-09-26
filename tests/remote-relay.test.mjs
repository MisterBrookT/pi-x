import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { webcrypto, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayRoom, sealRelayFrame, openRelayFrame, rotateRelayKey, readRelayOrigin } from "../src/remote-relay-agent.ts";
import { remoteRelayWebScript } from "../src/remote-relay-web.ts";
import { remoteAppHtml } from "../src/remote-web.ts";

const browser = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, EventTarget, MessageEvent, setTimeout, clearTimeout, console });
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
  const { relayRequestLimit, relayFrameLimit } = await import("../src/remote-relay-agent.ts");
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
  const { startRemoteRelayAgent } = await import("../src/remote-relay-agent.ts");
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret: "s".repeat(43), localBase: "http://127.0.0.1:9", localToken: "x", heartbeatMs: 50, onState: s => states.push(s) });
  t.after(() => agent.stop());
  await agent.ready;
  for (let i = 0; i < 160 && connections < 2; i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(states.includes("stale"), "dead link is detected");
  assert.equal(connections, 2, "and replaced");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(connections, 2, "a link that answers pings is kept");
});
