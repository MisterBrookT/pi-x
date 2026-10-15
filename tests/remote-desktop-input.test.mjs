import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopInput, createDesktopInputController, desktopInputScript, runOsascript, validDesktopInput } from "../src/remote-desktop-input.ts";
import { createDesktopBroker } from "../src/remote-desktop.ts";
import { startRemoteHub } from "../src/remote-hub.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";

const secret = "pa\"ss'w\\ord`$(x)\u2028\u2029é😀";

function fakeController({ fail = false, gate } = {}) {
  const scripts = [];
  return { scripts, enabled: true, run: async (script, signal) => { scripts.push(script); if (gate) await gate(signal); if (fail) throw new Error(`boom ${script}`); } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("validation: exact shapes, codepoint and byte bounds, no control characters", () => {
  assert.deepEqual(validDesktopInput({ seq: 0, text: "x" }), { seq: 0, text: "x" });
  assert.deepEqual(validDesktopInput({ seq: 3, key: "enter" }), { seq: 3, key: "enter" });
  for (const bad of [null, [], {}, { seq: -1, text: "x" }, { seq: 1.5, text: "x" }, { seq: 0, text: "" }, { seq: 0, text: "a\nb" }, { seq: 0, text: "\u007f" },
    { seq: 0, text: "\ud800" }, { seq: 0, key: "tab" }, { seq: 0, key: "toString" }, { seq: 0, text: "x", key: "enter" }, { seq: 0, text: "x", extra: 1 }, { seq: 0, text: "a".repeat(257) }])
    assert.equal(validDesktopInput(bad), undefined, JSON.stringify(bad));
  assert.ok(validDesktopInput({ seq: 0, text: "😀".repeat(256) }), "256 codepoints even though 512 UTF-16 units");
  assert.equal(validDesktopInput({ seq: 0, text: "😀".repeat(257) }), undefined);
});

test("script quotes any text as a JSON literal and uses fixed key codes", () => {
  const script = desktopInputScript({ seq: 0, text: secret });
  assert.ok(!script.includes("\u2028") && !script.includes("\u2029"));
  const literal = /keystroke\((.*)\);\n$/.exec(script)[1];
  assert.equal(JSON.parse(literal), secret);
  assert.equal(desktopInputScript({ seq: 0, key: "enter" }), 'Application("System Events").keyCode(36);\n');
  assert.equal(desktopInputScript({ seq: 0, key: "backspace" }), 'Application("System Events").keyCode(51);\n');
  assert.equal(desktopInputScript({ seq: 0, key: "escape" }), 'Application("System Events").keyCode(53);\n');
});

test("a VNC socket ending cancels running and queued native input exactly once", async t => {
  const started = deferred(); let calls = 0, closes = 0;
  const input = createDesktopInput({ enabled: true, run: async (_script, signal) => { calls++; started.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } });
  const socket = new Socket();
  const broker = createDesktopBroker({ connect: () => socket, onClose: id => { closes++; input.close(id); } });
  t.after(() => { broker.dispose(); input.dispose(); });
  const { id } = broker.open().body;
  const first = input.input(id, { seq: 0, text: "x" }, () => broker.has(id));
  await started.promise;
  const second = input.input(id, { seq: 1, key: "enter" }, () => broker.has(id));
  socket.emit("end"); socket.emit("close");
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [410, 410]);
  assert.equal(calls, 1, "queued Return must not run after the desktop disconnects");
  assert.equal(closes, 1);
});

test("an injected VNC broker cannot enable real host keystrokes implicitly", async t => {
  const home = await mkdtemp(join(tmpdir(), "pix-input-safe-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const broker = createDesktopBroker({ connect: () => new Socket() });
  const hub = await startRemoteHub({ token: "fixture-only", port: 0, home, desktopBroker: broker });
  t.after(() => hub.close());
  const response = await fetch(`http://127.0.0.1:${hub.port}/api/desktop/open`, { method: "POST", headers: { authorization: "Bearer fixture-only", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.notEqual((await response.json()).nativeInput, true, "synthetic VNC sessions must explicitly inject a test input controller");
});

test("controller is enabled only on darwin", () => {
  assert.equal(createDesktopInputController("linux").enabled, false);
  assert.equal(createDesktopInputController("darwin").enabled, true);
});

test("runOsascript sends the script on stdin only, with fixed argv and no secret in env", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-input-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "osascript"), out = join(dir, "out.json");
  await writeFile(fake, `#!${process.execPath}\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv.slice(2),env:process.env,stdin:s}));process.exit(s.includes("fail")?1:0)});\n`);
  await chmod(fake, 0o755);
  const run = runOsascript(fake);
  const script = desktopInputScript({ seq: 0, text: secret });
  await run(script, new AbortController().signal);
  const seen = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual(seen.argv, ["-l", "JavaScript"]);
  assert.equal(seen.stdin, script);
  assert.ok(!JSON.stringify(seen.env).includes("pa\\\"ss"));
  await assert.rejects(run(desktopInputScript({ seq: 0, text: "fail" }), new AbortController().signal), e => e.message === "desktop input failed" && !e.message.includes("fail\""));
  const slow = join(dir, "slow"); await writeFile(slow, "#!/bin/sh\nsleep 5\n"); await chmod(slow, 0o755);
  const started = Date.now();
  await assert.rejects(runOsascript(slow, 200)("x", new AbortController().signal));
  assert.ok(Date.now() - started < 3000, "timeout kills the process");
});

test("seq: replay returns the same result without re-running, gaps 409, failure 422 not retried", async () => {
  const c = fakeController(), input = createDesktopInput(c), live = () => true;
  assert.deepEqual(await input.input("s", { seq: 0, text: "a" }, live), { status: 200, body: { ack: 1 } });
  assert.deepEqual(await input.input("s", { seq: 0, text: "a" }, live), { status: 200, body: { ack: 1 } });
  assert.equal(c.scripts.length, 1);
  assert.equal((await input.input("s", { seq: 5, text: "a" }, live)).status, 409);
  assert.equal((await input.input("s", { seq: 1, text: "" }, live)).status, 400);
  const f = fakeController({ fail: true }), failing = createDesktopInput(f);
  const r = await failing.input("s", { seq: 0, text: secret }, live);
  assert.deepEqual(r, { status: 422, body: { error: "desktop input failed" } });
  assert.deepEqual(await failing.input("s", { seq: 0, text: secret }, live), r);
  assert.equal(f.scripts.length, 1, "ambiguous failure is never re-executed");
});

test("concurrent duplicate shares one in-flight run; close cancels queued and running", async () => {
  const gate = deferred(), signals = [];
  const c = fakeController({ gate: async signal => { signals.push(signal); await Promise.race([gate.promise, new Promise(r => signal.addEventListener("abort", r))]); } });
  const input = createDesktopInput(c, { queueLimit: 2 }), live = () => true;
  const first = input.input("s", { seq: 0, text: "a" }, live), dup = input.input("s", { seq: 0, text: "a" }, live);
  const second = input.input("s", { seq: 1, key: "enter" }, live);
  assert.equal((await input.input("s", { seq: 2, key: "enter" }, live)).status, 429, "bounded queue");
  await new Promise(r => setImmediate(r));
  assert.equal(c.scripts.length, 1, "one at a time");
  input.close("s");
  assert.equal((await first).status, 410); assert.equal(await dup, await first);
  assert.equal((await second).status, 410);
  assert.equal(c.scripts.length, 1, "queued command never ran");
  assert.ok(signals[0].aborted);
});

test("liveness checked before execution", async () => {
  const c = fakeController(), input = createDesktopInput(c);
  assert.equal((await input.input("s", { seq: 0, text: "a" }, () => false)).status, 404);
  let calls = 0;
  assert.equal((await input.input("t", { seq: 0, text: "a" }, () => ++calls < 2)).status, 410);
  assert.equal(c.scripts.length, 0);
  const off = createDesktopInput({ enabled: false, run: async () => assert.fail() });
  assert.equal(off.input("s", { seq: 0, text: "a" }, () => true).status, 404);
});

test("hub input route: bearer, live id, nativeInput flag, ack, close; relay allows only POST", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-input-hub-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const broker = createDesktopBroker({ connect: () => new Socket() }); t.after(() => broker.dispose());
  const c = fakeController(), token = "hub-token-1234567890abcdef", auth = { authorization: `Bearer ${token}` };
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub"), proactiveDir: dir, desktopBroker: broker, desktopInput: c });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, ghost = "a".repeat(24);
  const post = (path, value, headers = auth) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await post(`/api/desktop/${ghost}/input`, { seq: 0, text: "x" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(`/api/desktop/${ghost}/input`, { seq: 0, text: "x" })).status, 404);
  const opened = await (await post("/api/desktop/open", {})).json();
  assert.equal(opened.nativeInput, true);
  const url = `/api/desktop/${opened.id}/input`;
  assert.deepEqual(await (await post(url, { seq: 0, text: secret })).json(), { ack: 1 });
  assert.deepEqual(await (await post(url, { seq: 0, text: secret })).json(), { ack: 1 });
  assert.deepEqual(await (await post(url, { seq: 1, key: "backspace" })).json(), { ack: 2 });
  assert.equal((await post(url, { seq: 9, key: "enter" })).status, 409);
  assert.equal((await fetch(base + url, { method: "POST", headers: auth, body: "{bad" })).status, 400);
  assert.equal(c.scripts.length, 2);
  await post(`/api/desktop/${opened.id}/close`, {});
  assert.equal((await post(url, { seq: 2, key: "enter" })).status, 404);
  assert.equal(c.scripts.length, 2);
  assert.ok(relayAllowed(`/api/desktop/${ghost}/input`, "POST"));
  assert.ok(!relayAllowed(`/api/desktop/${ghost}/input`, "GET") && !relayAllowed("/api/desktop/short/input", "POST"));
});

test("hub open omits nativeInput when the controller is disabled", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-input-off-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const broker = createDesktopBroker({ connect: () => new Socket() }); t.after(() => broker.dispose());
  const token = "hub-token-1234567890abcdef";
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub"), proactiveDir: dir, desktopBroker: broker, desktopInput: { enabled: false, run: async () => assert.fail() } });
  t.after(() => hub.close());
  const opened = await (await fetch(`http://127.0.0.1:${hub.port}/api/desktop/open`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).json();
  assert.equal(opened.nativeInput, undefined);
});
