import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopCredentialStore, runSecurity, desktopCredentialService, desktopCredentialAccount, validDesktopCredentials } from "../plugins/desktop/remote-desktop-credentials.ts";
import { createDesktopBroker } from "../plugins/desktop/remote-desktop.ts";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";

// Never reaches the real Screen Sharing port: an unconnected socket stays open until disposed.
function fakeBroker(t) { const broker = createDesktopBroker({ connect: () => new Socket() }); t.after(() => broker.dispose()); return broker; }

const secret = "synthetic-Secret-7f3a!";
const fixed = ["-a", desktopCredentialAccount, "-s", desktopCredentialService];

// A fake keychain that understands just the three fixed commands.
function fakeKeychain({ writeWorks = true, readCode } = {}) {
  const calls = [];
  let item;
  const run = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "-i") {
      const m = /^add-generic-password -a pix-desktop -s fun\.brooktang\.pix\.desktop -U -X ([0-9a-f]+)\n$/.exec(stdin ?? "");
      if (m && writeWorks) item = Buffer.from(m[1], "hex").toString("utf8");
      return { code: 0, stdout: "" }; // security -i exits 0 even when the inner command fails
    }
    if (args[0] === "find-generic-password") {
      if (readCode !== undefined) return { code: readCode, stdout: "" };
      return item === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: item + "\n" };
    }
    if (args[0] === "delete-generic-password") { const had = item !== undefined; item = undefined; return { code: had ? 0 : 44, stdout: "" }; }
    return { code: 1, stdout: "" };
  };
  return { run, calls, set: v => { item = v; } };
}

test("fixed keychain identity", () => {
  assert.equal(desktopCredentialService, "fun.brooktang.pix.desktop");
  assert.equal(desktopCredentialAccount, "pix-desktop");
});

test("save sends the secret only as hex on stdin and round-trips", async () => {
  const kc = fakeKeychain(), store = createDesktopCredentialStore(kc.run);
  assert.equal(await store.load(), undefined, "44 means nothing saved");
  await store.save({ username: "brook", password: secret });
  const hex = Buffer.from(JSON.stringify({ username: "brook", password: secret })).toString("hex");
  assert.deepEqual(kc.calls[1], { args: ["-i"], stdin: `add-generic-password ${fixed.join(" ")} -U -X ${hex}\n` });
  for (const c of kc.calls) assert.ok(!c.args.join(" ").includes(secret) && !c.args.join(" ").includes(hex), "argv never carries the secret");
  for (const c of kc.calls) assert.ok(!(c.stdin ?? "").includes(secret), "stdin carries hex, not plaintext");
  assert.deepEqual(kc.calls[2].args, ["find-generic-password", ...fixed, "-w"]);
  assert.deepEqual(await store.load(), { username: "brook", password: secret });
  await store.remove(); await store.remove();
  assert.equal(await store.load(), undefined);
  assert.deepEqual(kc.calls.at(-1).args, ["find-generic-password", ...fixed, "-w"]);
});

test("a write that silently failed is reported, without the secret", async () => {
  const store = createDesktopCredentialStore(fakeKeychain({ writeWorks: false }).run);
  await assert.rejects(store.save({ username: "brook", password: secret }), e => !String(e.message).includes(secret) && /save failed/.test(e.message));
});

test("invalid input is refused before touching the keychain", async () => {
  const kc = fakeKeychain(), store = createDesktopCredentialStore(kc.run);
  for (const bad of [null, "x", {}, { username: "a" }, { username: "a", password: "" }, { username: 1, password: "p" }, { username: "a", password: "p".repeat(1100) }])
    await assert.rejects(store.save(bad), /invalid credentials/);
  assert.equal(kc.calls.length, 0);
  assert.ok(validDesktopCredentials({ username: "a", password: "é".repeat(400) }));
  assert.equal(validDesktopCredentials({ username: "a", password: "é".repeat(600) }), undefined, "limit counts UTF-8 bytes");
});

test("malformed items and read errors are generic, never plaintext fallback", async () => {
  const kc = fakeKeychain(), store = createDesktopCredentialStore(kc.run);
  for (const item of [secret, JSON.stringify({ username: "a" }), JSON.stringify({ username: "a", password: 5 })]) {
    kc.set(item);
    await assert.rejects(store.load(), e => e.message === "Keychain item is malformed");
  }
  await assert.rejects(createDesktopCredentialStore(fakeKeychain({ readCode: 51 }).run).load(), e => e.message === "Keychain read failed");
});

test("runSecurity passes stdin, kills on timeout, and captures stdout only", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-sec-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const echo = join(dir, "echo.sh"), hang = join(dir, "hang.sh");
  await writeFile(echo, "#!/bin/sh\necho stderr-noise >&2\ncat\nexit 3\n"); await chmod(echo, 0o755);
  await writeFile(hang, "#!/bin/sh\nsleep 10\n"); await chmod(hang, 0o755);
  assert.deepEqual(await runSecurity(echo)(["-i"], "hello\n"), { code: 3, stdout: "hello\n" });
  const started = Date.now();
  assert.deepEqual(await runSecurity(hang, 100)(["x"]), { code: null, stdout: "" });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await runSecurity(join(dir, "missing"))(["x"]), { code: null, stdout: "" });
});

test("hub credential routes need the token and a live desktop session; relay allows exactly them", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-cred-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const kc = fakeKeychain();
  const hub = await startRemoteHub({ token: "hub-token-1234567890abcdef", port: 0, home: dir, memoryRoot: join(dir, "hub"), desktopBroker: fakeBroker(t), desktopCredentials: createDesktopCredentialStore(kc.run) });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: "Bearer hub-token-1234567890abcdef" }, ghost = "a".repeat(24);
  for (const [path, method] of [[`/api/desktop/${ghost}/credentials`, "GET"], [`/api/desktop/${ghost}/credentials`, "POST"], ["/api/desktop/credentials", "DELETE"]])
    assert.equal((await fetch(base + path, { method, headers: { authorization: "Bearer wrong" }, body: method === "POST" ? "{}" : undefined })).status, 401);
  assert.equal((await fetch(`${base}/api/desktop/${ghost}/credentials`, { headers: auth })).status, 404, "no session, no login");
  assert.equal((await fetch(`${base}/api/desktop/${ghost}/credentials`, { method: "POST", headers: auth, body: JSON.stringify({ username: "b", password: secret }) })).status, 404);
  assert.equal(kc.calls.length, 0);

  const opened = await (await fetch(`${base}/api/desktop/open`, { method: "POST", headers: auth, body: "{}" })).json();
  const url = `${base}/api/desktop/${opened.id}/credentials`;
  let res = await fetch(url, { headers: auth });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { saved: false });
  res = await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ username: "brook", password: "" }) });
  assert.equal(res.status, 400); assert.ok(!(await res.text()).includes(secret));
  assert.deepEqual(await (await fetch(url, { method: "POST", headers: auth, body: JSON.stringify({ username: "brook", password: secret }) })).json(), { ok: true });
  assert.deepEqual(await (await fetch(url, { headers: auth })).json(), { saved: true, username: "brook", password: secret });
  kc.set("not json " + secret);
  res = await fetch(url, { headers: auth });
  assert.equal(res.status, 500); assert.ok(!(await res.text()).includes(secret));

  await fetch(`${base}/api/desktop/${opened.id}/close`, { method: "POST", headers: auth, body: "{}" });
  assert.equal((await fetch(url, { headers: auth })).status, 404, "closed session cannot read the login");
  assert.deepEqual(await (await fetch(`${base}/api/desktop/credentials`, { method: "DELETE", headers: auth })).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${base}/api/desktop/credentials`, { method: "DELETE", headers: auth })).json(), { ok: true }, "idempotent");

  assert.ok(relayAllowed(`/api/desktop/${ghost}/credentials`, "GET") && relayAllowed(`/api/desktop/${ghost}/credentials`, "POST"));
  assert.ok(relayAllowed("/api/desktop/credentials", "DELETE"));
  assert.ok(!relayAllowed(`/api/desktop/${ghost}/credentials`, "DELETE") && !relayAllowed("/api/desktop/credentials", "GET") && !relayAllowed("/api/desktop/credentials", "POST"));
  assert.ok(!relayAllowed("/api/desktop/short/credentials", "GET"));
});

test("broker reports live sessions", () => {
  const broker = createDesktopBroker({ connect: () => new Socket() });
  try { const { body: { id } } = broker.open(); assert.ok(broker.has(id)); broker.close(id); assert.ok(!broker.has(id)); } finally { broker.dispose(); }
});

test("relay agent never serves credential replies from its request cache", async t => {
  const { WebSocketServer } = await import("ws");
  const { startRemoteRelayAgent, sealRelayFrame, openRelayFrame } = await import("../plugins/remote/remote-relay-agent.ts");
  const dir = await mkdtemp(join(tmpdir(), "pix-cred-relay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const kc = fakeKeychain(), token = "r".repeat(32), relaySecret = "s".repeat(43), auth = { authorization: `Bearer ${token}` };
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub"), desktopBroker: fakeBroker(t), desktopCredentials: createDesktopCredentialStore(kc.run) });
  t.after(() => hub.close());
  const { id } = await (await fetch(`http://127.0.0.1:${hub.port}/api/desktop/open`, { method: "POST", headers: auth, body: "{}" })).json();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); t.after(() => server.close());
  await new Promise(r => server.once("listening", r));
  const frames = []; let link;
  server.on("connection", socket => { link = socket; socket.on("message", data => { const text = String(data); if (text === "ping") return socket.send("pong"); try { frames.push(openRelayFrame(relaySecret, text)); } catch {} }); });
  const agent = startRemoteRelayAgent({ origin: `http://127.0.0.1:${server.address().port}/`, secret: relaySecret, localBase: `http://127.0.0.1:${hub.port}`, localToken: token });
  t.after(() => agent.stop());
  await agent.ready;
  const ask = async () => {
    const before = frames.length;
    link.send(sealRelayFrame(relaySecret, { kind: "request", id: "same-id", path: `/api/desktop/${id}/credentials`, method: "GET", body: "" }));
    for (let i = 0; i < 80; i++) { const f = frames.slice(before).find(f => f.kind === "response" && f.id === "same-id"); if (f) return f; await new Promise(r => setTimeout(r, 25)); }
  };
  assert.deepEqual((await ask()).body, { saved: false });
  kc.set(JSON.stringify({ username: "brook", password: secret }));
  assert.deepEqual((await ask()).body, { saved: true, username: "brook", password: secret }, "a repeated id reaches the Mac again");
});

test("a forget sent while a save is pending runs after it and wins", async () => {
  const kc = fakeKeychain();
  let release; const gate = new Promise(r => { release = r; });
  const run = async (args, stdin) => { if (args[0] === "-i") await gate; return kc.run(args, stdin); };
  const store = createDesktopCredentialStore(run);
  const saving = store.save({ username: "brook", password: secret });
  const forgetting = store.remove();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!kc.calls.some(c => c.args[0] === "delete-generic-password"), "forget waits for the save");
  release();
  await saving; await forgetting;
  assert.equal(await store.load(), undefined);
});

test("a desktop session whose Screen Sharing link closed no longer counts as live", async () => {
  const { createServer, connect } = await import("node:net");
  const server = createServer(socket => socket.destroy());
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const broker = createDesktopBroker({ connect: () => connect(server.address().port, "127.0.0.1") });
  try {
    const { body: { id } } = broker.open(); assert.ok(broker.has(id));
    for (let i = 0; i < 100 && broker.has(id); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(!broker.has(id), "closed by the Mac side");
  } finally { broker.dispose(); server.close(); }
});

test("password-only VNC logins keep an empty username", async () => {
  const store = createDesktopCredentialStore(fakeKeychain().run);
  await store.save({ username: "", password: secret });
  assert.deepEqual(await store.load(), { username: "", password: secret });
});
