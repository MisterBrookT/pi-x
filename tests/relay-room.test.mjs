import test from "node:test";
import assert from "node:assert/strict";

// Fake Durable Object state with the hibernation WebSocket API shape the Room uses.
function fakeRoom() {
  globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
  globalThis.WebSocketPair = class { constructor() { const mk = () => ({ sent: [], closed: null, att: undefined, readyState: 1, send(d) { this.sent.push(d); }, close(c, r) { this.closed = [c, r]; sockets.delete(this); }, serializeAttachment(v) { this.att = v; }, deserializeAttachment() { return this.att; } }); this[0] = mk(); this[1] = mk(); } };
  globalThis.Response = class { constructor(body, init) { this.status = init?.status ?? 200; this.webSocket = init?.webSocket; } };
  const sockets = new Map();
  const state = {
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws, tags) { sockets.set(ws, tags); },
    getWebSockets(tag) { return [...sockets].filter(([, t]) => t.includes(tag)).map(([w]) => w); },
    getTags(ws) { return sockets.get(ws) ?? []; },
  };
  return { state, sockets };
}

test("a dead phone socket (silent 45 s) makes room; live phones are never kicked off by a newcomer", async () => {
  const { Room } = await import("../relay/src/index.ts");
  const { state } = fakeRoom();
  const room = new Room(state);
  const req = role => ({ url: `https://rc/socket/${"a".repeat(64)}/${role}` });
  for (let i = 0; i < 3; i++) room.fetch(req("phone"));
  const [dead, a, b] = state.getWebSockets("phone");
  dead.att = { heard: Date.now() - 60_000 };
  assert.equal(room.fetch(req("phone")).status, 101, "4th phone accepted (no more 'Room full' at 3)");
  assert.ok(dead.closed, "the silent socket is closed");
  assert.ok(!a.closed && !b.closed, "live phones stay");
  for (let i = 0; i < 5; i++) room.fetch(req("phone"));
  assert.ok(state.getWebSockets("phone").every(w => !w.closed), "no live phone is ever kicked");
  assert.equal(room.fetch(req("phone")).status, 429, "only 8 live phones is full");
});
