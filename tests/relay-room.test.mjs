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

test("a fourth phone gets in (the least recently heard one is dropped) instead of 'Room full' locking brook out", async () => {
  const { Room } = await import("../relay/src/index.ts");
  const { state } = fakeRoom();
  const room = new Room(state);
  const req = role => ({ url: `https://rc/socket/${"a".repeat(64)}/${role}` });
  for (let i = 0; i < 3; i++) { room.fetch(req("phone")); await new Promise(r => setTimeout(r, 5)); }
  const [oldest, mid, newest] = state.getWebSockets("phone");
  room.webSocketMessage(oldest, "ping"); // oldest spoke recently: the silent middle one goes
  await new Promise(r => setTimeout(r, 5));
  room.webSocketMessage(newest, "ping");
  const res = room.fetch(req("phone"));
  assert.equal(res.status, 101, "new phone accepted");
  assert.equal(state.getWebSockets("phone").length, 3);
  assert.ok(mid.closed, "the stalest phone socket is closed");
  assert.ok(!oldest.closed && !newest.closed);
});
