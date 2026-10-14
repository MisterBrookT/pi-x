import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopBroker, desktopHost, desktopPort, desktopReadChunkLimit } from "../src/remote-desktop.ts";
import { startRemoteHub } from "../src/remote-hub.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";

// A stand-in VNC server; the broker reaches it only through the unit-test connect factory.
async function fakeVnc(t) {
  const sockets = [], received = [];
  const server = createServer(s => { sockets.push(s); s.on("data", d => received.push(d)); s.on("error", () => {}); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  const port = server.address().port;
  const ready = async () => { while (!sockets.length) await new Promise(r => setTimeout(r, 5)); return sockets.at(-1); };
  return { connect: () => connect(port, "127.0.0.1"), sockets, received, ready };
}
const b64 = s => Buffer.from(s).toString("base64");
const wait = ms => new Promise(r => setTimeout(r, ms));

test("desktop destination is fixed to local Screen Sharing", () => {
  assert.equal(desktopHost, "127.0.0.1"); assert.equal(desktopPort, 5900);
});

test("desktop routes need the hub token and the relay allows only them", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-desk-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token: "hub-token-1234567890abcdef", port: 0, home: dir, memoryRoot: join(dir, "hub"), proactiveDir: dir }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, id = "a".repeat(24);
  for (const [path, method] of [["/api/desktop/open", "POST"], [`/api/desktop/${id}/read?seq=0`, "GET"], [`/api/desktop/${id}/write`, "POST"], [`/api/desktop/${id}/close`, "POST"]]) {
    const res = await fetch(base + path, { method, headers: { authorization: "Bearer wrong" }, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, path);
  }
  const auth = { authorization: "Bearer hub-token-1234567890abcdef" };
  assert.equal((await fetch(`${base}/api/desktop/${id}/read?seq=0`, { headers: auth })).status, 404, "unknown session id");
  assert.ok(relayAllowed("/api/desktop/open", "POST"));
  assert.ok(relayAllowed(`/api/desktop/${id}/read?seq=3`, "GET"));
  assert.ok(relayAllowed(`/api/desktop/${id}/write`, "POST") && relayAllowed(`/api/desktop/${id}/close`, "POST"));
  assert.ok(!relayAllowed("/api/desktop/open", "GET"));
  assert.ok(!relayAllowed(`/api/desktop/${id}/read`, "POST"));
  assert.ok(!relayAllowed("/api/desktop/short/read", "GET"));
  assert.ok(!relayAllowed(`/api/desktop/${id}/connect`, "POST"));
});

test("reads are ordered, replay on retry, and long-poll until data", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, pollMs: 2000 }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  assert.match(id, /^[A-Za-z0-9_-]{24}$/);
  const server = await vnc.ready();
  const pending = broker.read(id, "0");
  await wait(30);
  server.write("RFB 003.008\n");
  const first = await pending;
  assert.deepEqual(first.body, { seq: 0, data: b64("RFB 003.008\n"), closed: false });
  assert.deepEqual((await broker.read(id, 0)).body, first.body, "a retried read replays the same bytes");
  assert.equal((await broker.read(id, 5)).status, 409, "reads cannot skip ahead");
  server.write("next");
  await wait(30);
  assert.equal((await broker.read(id, 1)).body.data, b64("next"));
  assert.equal((await broker.read(id, 0)).status, 409, "old reads are gone once the next is taken");
});

test("only one pending read: a newer poll releases the older one empty", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, pollMs: 2000 }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  const server = await vnc.ready();
  const older = broker.read(id, 0);
  await wait(20);
  const newer = broker.read(id, 0);
  assert.deepEqual((await older).body, { seq: 0, data: "", closed: false });
  server.write("x");
  assert.equal((await newer).body.data, b64("x"));
});

test("long-poll times out empty without consuming a sequence", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, pollMs: 50 }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  const server = await vnc.ready();
  assert.equal((await broker.read(id, 0)).body.data, "");
  server.write("y"); await wait(30);
  assert.equal((await broker.read(id, 0)).body.data, b64("y"));
});

test("writes are ordered, duplicates are harmless, gaps and bad input are refused", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  await vnc.ready();
  assert.deepEqual(broker.write(id, { seq: 0, data: b64("ab") }).body, { ack: 1 });
  assert.equal(broker.write(id, { seq: 0, data: b64("ab") }).body.duplicate, true);
  assert.equal(broker.write(id, { seq: 2, data: b64("zz") }).status, 409);
  assert.deepEqual(broker.write(id, { seq: 1, data: b64("cd") }).body, { ack: 2 });
  for (const bad of [{ seq: 2, data: "not base64!" }, { seq: 2, data: "abc" }, { seq: -1, data: "" }, { seq: 2.5, data: "" }, { seq: "2", data: "" }, { seq: 2, data: b64("x".repeat(64 * 1024 + 1)) }])
    assert.equal(broker.write(id, bad).status, 400, JSON.stringify(bad).slice(0, 60));
  await wait(50);
  assert.equal(Buffer.concat(vnc.received).toString(), "abcd");
});

test("sessions are capped, chunks bounded, overload pauses the socket, close cleans up", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, queueLimit: 100_000 }); t.after(() => broker.dispose());
  const a = broker.open().body.id; broker.open();
  assert.equal(broker.open().status, 429);
  while (vnc.sockets.length < 2) await wait(5);
  for (const s of vnc.sockets) s.write(Buffer.alloc(300_000, 7));
  await wait(100);
  const r = await broker.read(a, 0);
  assert.ok(Buffer.from(r.body.data, "base64").length > 0);
  assert.ok(Buffer.from(r.body.data, "base64").length <= desktopReadChunkLimit);
  assert.equal(broker.close(a).status, 200);
  assert.equal((await broker.read(a, 1)).status, 404);
  assert.equal(broker.open().status, 200, "a closed slot is free again");
});

test("idle sessions expire", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, idleMs: 50 }); t.after(() => broker.dispose());
  broker.open();
  await wait(200);
  assert.equal(broker.size, 0);
});

test("closed VNC connection is reported after queued data drains", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  const server = await vnc.ready();
  server.end("bye"); await wait(50);
  assert.deepEqual((await broker.read(id, 0)).body, { seq: 0, data: b64("bye"), closed: true });
  assert.equal(broker.write(id, { seq: 0, data: "" }).status, 410);
});

test("authenticated wrong-method desktop routes are not served", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-desk-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await startRemoteHub({ token: "hub-token-1234567890abcdef", port: 0, home: dir, memoryRoot: join(dir, "hub"), proactiveDir: dir }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, id = "a".repeat(24), auth = { authorization: "Bearer hub-token-1234567890abcdef" };
  for (const [path, method] of [["/api/desktop/open", "GET"], [`/api/desktop/${id}/read?seq=0`, "POST"], [`/api/desktop/${id}/write`, "GET"], [`/api/desktop/${id}/close`, "GET"]]) {
    const res = await fetch(base + path, { method, headers: auth, body: method === "POST" ? "{}" : undefined });
    await res.text();
    assert.notEqual(res.status, 200, `${method} ${path}`);
  }
});

test("write backpressure returns 503 without advancing seq, then the same seq is accepted", async t => {
  const vnc = await fakeVnc(t);
  let client;
  const broker = createDesktopBroker({ connect: () => (client = vnc.connect()), queueLimit: 1000 }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  await vnc.ready();
  let backlog = 999;
  Object.defineProperty(client, "writableLength", { configurable: true, get: () => backlog });
  assert.equal(broker.write(id, { seq: 0, data: b64("ab") }).status, 503, "999 + 2 exceeds the limit");
  assert.equal(broker.write(id, { seq: 1, data: b64("ab") }).status, 409, "seq did not advance");
  backlog = 998;
  assert.deepEqual(broker.write(id, { seq: 0, data: b64("ab") }).body, { ack: 1 }, "exactly at the limit is accepted");
  await wait(50);
  assert.equal(Buffer.concat(vnc.received).toString(), "ab");
});

test("malformed write bodies are refused with 400", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  await vnc.ready();
  for (const bad of [{}, null, undefined, { seq: 0 }, { data: b64("x") }, { seq: 0, data: null }])
    assert.equal(broker.write(id, bad).status, 400, String(JSON.stringify(bad)));
  assert.deepEqual(broker.write(id, { seq: 0, data: b64("ok") }).body, { ack: 1 }, "seq still at 0");
});

test("close and dispose destroy the VNC sockets and release every session", async t => {
  const vnc = await fakeVnc(t);
  const clients = [];
  const broker = createDesktopBroker({ connect: () => { const c = vnc.connect(); clients.push(c); return c; }, pollMs: 2000 });
  const a = broker.open().body.id; const b = broker.open().body.id;
  while (vnc.sockets.length < 2) await wait(5);
  const serverClosed = vnc.sockets.map(s => new Promise(r => s.on("close", r)));
  const pending = broker.read(b, 0);
  assert.equal(broker.close(a).status, 200);
  assert.equal(clients[0].destroyed, true);
  assert.equal(broker.size, 1);
  broker.dispose();
  assert.equal(clients[1].destroyed, true);
  assert.equal(broker.size, 0);
  assert.equal((await pending).status, 404, "a pending read is released on dispose");
  await Promise.all(serverClosed);
});

test("activity keeps a session alive past idleMs; it expires once quiet", async t => {
  const vnc = await fakeVnc(t);
  const broker = createDesktopBroker({ connect: vnc.connect, idleMs: 150, pollMs: 10 }); t.after(() => broker.dispose());
  const { body: { id } } = broker.open();
  for (let i = 0; i < 12; i++) { await wait(40); await broker.read(id, 0); }
  assert.equal(broker.size, 1, "~480ms of activity outlived a 150ms idle limit");
  await wait(500);
  assert.equal(broker.size, 0);
});
