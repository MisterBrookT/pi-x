import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { remoteRelayWebScript } from "../plugins/remote/remote-relay-web.ts";

// A fake browser: sockets record what they send; the test controls pongs, visibility and time.
function phone() {
  const sockets = [], docListeners = new Map(), winListeners = new Map();
  class WebSocket {
    static OPEN = 1; static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(x) { this.sent.push(x); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const document = { hidden: false, addEventListener: (n, f) => docListeners.set(n, f) };
  const ctx = runInNewContext(`${remoteRelayWebScript};({relayConnect, setKey:k=>{relayKey=k}})`, {
    WebSocket, document, location: { origin: "https://relay.test" }, crypto: globalThis.crypto, TextEncoder, TextDecoder,
    btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval, EventTarget, MessageEvent, Response, Blob, DecompressionStream,
    addEventListener: (n, f) => winListeners.set(n, f), console, active: "s1",
  });
  return { ctx, sockets, document, docListeners, winListeners };
}
const tick = ms => new Promise(r => setTimeout(r, ms));
const hellos = s => s.sent.filter(x => x !== "ping").length;

test("returning to the page asks the Mac for fresh state at once and replaces a dead socket within ~1 s", async () => {
  const p = phone();
  const events = p.ctx.relayConnect("k".repeat(43));
  for (let i = 0; i < 50 && !p.sockets.length; i++) await tick(10);
  const s = p.sockets[0]; s.readyState = 1; s.onopen();
  await tick(30);
  events.online = true;
  const before = hellos(s);
  // Live socket: one return to the page sends a hello right away, not after a 3 s ping timeout.
  s.onmessage({ data: "pong" });
  p.docListeners.get("visibilitychange")();
  await tick(30);
  assert.equal(hellos(s), before + 1, "a hello goes out immediately so the shown session is re-sent");
  // pageshow/focus also wake (iOS can restore a frozen page without visibilitychange); repeated wakes are coalesced.
  assert.ok(p.winListeners.has("pageshow") && p.winListeners.has("focus"));
  p.winListeners.get("focus")();
  await tick(30);
  assert.equal(hellos(s), before + 1, "a second wake right after the first does not send again");
  // Dead socket (no pong): a new one opens in about a second.
  await tick(1600);
  p.winListeners.get("pageshow")();
  await tick(1400);
  assert.equal(p.sockets.length, 2, "a frozen socket is replaced quickly");
  events.close();
});

test("a socket that pongs but carries nothing from the Mac is probed and rebuilt (phone looked connected, replies never came)", async () => {
  const p = phone();
  const events = p.ctx.relayConnect("k".repeat(43));
  for (let i = 0; i < 50 && !p.sockets.length; i++) await tick(10);
  const s = p.sockets[0]; s.readyState = 1; s.onopen();
  await tick(30);
  events.online = true;
  events.heard = Date.now() - 30000; // Mac silent for 30 s, relay still answers pings
  let offline = 0; events.onerror = () => offline++;
  const sent = s.sent.length;
  const check = events.check();
  await tick(30);
  assert.ok(s.sent.length > sent, "asks the Mac a small question");
  await check; // no answer within 8 s
  assert.ok(offline >= 1, "says it is reconnecting");
  assert.equal(p.sockets.length, 2, "and rebuilds the link");
  events.close();
});
