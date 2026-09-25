// Real Pi session + deployed relay acceptance. The model is scripted; no private transcript leaves this fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerRemote from "../extensions/remote.ts";
import { readRemoteToken, startRemoteHub } from "../src/remote-hub.ts";
import { readRelayOrigin, relayRoom, sealRelayFrame, openRelayFrame } from "../src/remote-relay-agent.ts";
import { goalSession, say } from "../tests/helpers/goal-session.mjs";

test("public relay delivers a phone prompt into the same Pi transcript", { timeout: 30_000 }, async t => {
  const relayOrigin = await readRelayOrigin();
  if (!relayOrigin) throw Error("Set PIX_REMOTE_RELAY_URL or ~/.pi/agent/pix-remote/relay.json before the hosted relay test");
  const dir = await mkdtemp(join(tmpdir(), "pix-relay-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "token"), relayKeyPath = join(dir, "key");
  const probe = await startRemoteHub({ token: await readRemoteToken(tokenPath), port: 0 });
  const port = probe.port; await probe.close();
  const h = await goalSession(t, ({ context }) => say(`echo: ${context.messages.at(-1).content.map(p => p.text).join("")}`), {
    tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayKeyPath, relayUrl: relayOrigin })],
  });
  await h.session.prompt("/rc");
  const secret = (await readFile(relayKeyPath, "utf8")).trim();
  const socket = new WebSocket(relayOrigin.replace(/^https:/, "wss:") + `/socket/${relayRoom(secret)}/phone`, { headers: { origin: relayOrigin } });
  t.after(() => socket.close());
  const frames = [], signals = [];
  const waitFor = async predicate => {
    for (let i = 0; i < 100; i++) {
      const result = frames.find(predicate); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail("Encrypted phone frame did not arrive");
  };
  socket.onmessage = e => { try { const signal = JSON.parse(e.data).signal; if (signal) signals.push(signal); else frames.push(openRelayFrame(secret, String(e.data))); } catch {} };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Phone connection timed out")), 10_000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = error => { clearTimeout(timer); reject(error); };
  });
  socket.send(sealRelayFrame(secret, { kind: "hello" }));
  await waitFor(m => m.kind === "event" && m.event === "sessions" && m.data.some(s => s.id === h.session.sessionManager.getSessionId()));
  await h.session.prompt("from terminal");
  await h.until(() => h.settledCount() >= 1);
  const id = h.session.sessionManager.getSessionId();
  await waitFor(m => m.kind === "event" && m.event === "session" && m.data.id === id && m.data.messages.some(x => x.text === "echo: from terminal"));
  const request = sealRelayFrame(secret, { kind: "request", id: "phone-1", path: `/api/sessions/${id}/prompt`, method: "POST", body: JSON.stringify({ text: "from phone" }) });
  socket.send(request);
  assert.equal((await waitFor(m => m.kind === "response" && m.id === "phone-1")).status, 202);
  await h.until(() => h.settledCount() >= 2);
  await waitFor(m => m.kind === "event" && m.event === "session" && m.data.id === id && m.data.messages.some(x => x.text === "echo: from phone"));
  assert.ok(h.session.messages.some(m => m.role === "user" && m.content.some?.(p => p.text === "from phone")));
  socket.send(request); // A relay replay must not deliver a second prompt.
  await waitFor(() => frames.filter(m => m.kind === "response" && m.id === "phone-1").length >= 2);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(h.session.messages.filter(m => m.role === "user" && m.content.some?.(p => p.text === "from phone")).length, 1);
  await h.session.prompt("/rc reset");
  const newSecret = (await readFile(relayKeyPath, "utf8")).trim();
  assert.notEqual(newSecret, secret, "reset rotates the pairing secret");
  for (let i = 0; i < 40 && !signals.includes("agent-offline"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(signals.includes("agent-offline"), "old phone room goes offline after reset");
  const fresh = new WebSocket(relayOrigin.replace(/^https:/, "wss:") + `/socket/${relayRoom(newSecret)}/phone`, { headers: { origin: relayOrigin } });
  t.after(() => fresh.close());
  const freshFrames = [];
  fresh.onmessage = e => { try { freshFrames.push(openRelayFrame(newSecret, String(e.data))); } catch {} };
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Re-pair timed out")), 10_000); fresh.onopen = () => { clearTimeout(timer); resolve(); }; fresh.onerror = error => { clearTimeout(timer); reject(error); }; });
  fresh.send(sealRelayFrame(newSecret, { kind: "hello" }));
  for (let i = 0; i < 100 && !freshFrames.some(m => m.event === "sessions" && m.data.some(s => s.id === id)); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(freshFrames.some(m => m.event === "sessions" && m.data.some(s => s.id === id)), "new QR reconnects the same Pi session");
  console.log("PASS public relay → same live Pi conversation, with an encrypted reply back to the phone client");
});
