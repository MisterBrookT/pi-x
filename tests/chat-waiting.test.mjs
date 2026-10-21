import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const W = await jiti.import("../plugins/chat/waiting.ts");
const chat = await jiti.import("../plugins/chat/chat.ts");
const registerChat = await jiti.import("../plugins/chat/index.ts", { default: true });

const empty = { waits: [], notices: [] };
const H = 3600_000;

test("waiting: ask/handoff start a wait, a reply ends it; notes and replies expect nothing", () => {
  let w = W.sentNote(empty, { thread: "t1", to: "pix", kind: "ask", at: 0 }, true);
  w = W.sentNote(w, { thread: "t2", to: "bench", kind: "handoff", at: 0 }, true);
  assert.equal(W.sentNote(empty, { thread: "t3", to: "pix", kind: "note" }, true), empty);
  assert.equal(W.sentNote(empty, { thread: "t3", to: "pix", kind: "reply" }, true), empty);
  assert.equal(W.waitingText(w), "Waiting for pix, bench");
  w = W.receivedNote(w, { thread: "t1" });
  assert.equal(W.waitingText(w), "Waiting for bench");
  assert.equal(W.waitingText(W.receivedNote(w, { thread: "t2" })), undefined);
});

test("waiting: a running peer that exits shows 'X left' briefly, then clears", () => {
  let w = W.sentNote(empty, { thread: "t", to: "pix", kind: "ask", at: 0 }, true);
  w = W.tick(w, new Set(["pix"]), 60_000);
  assert.equal(W.waitingText(w), "Waiting for pix");
  w = W.tick(w, new Set(), 120_000);
  assert.equal(W.waitingText(w), "pix left");
  assert.equal(W.waitingText(W.tick(w, new Set(), 120_000 + W.NOTICE_MS)), undefined);
});

test("waiting: after ~2h without a reply it says 'No reply from X' instead of vanishing", () => {
  // Peer not running when sent: its mail waits, so it is not "left".
  let w = W.sentNote(empty, { thread: "t", to: "pix", kind: "ask", at: 0 }, false);
  w = W.tick(w, new Set(), H);
  assert.equal(W.waitingText(w), "Waiting for pix");
  w = W.tick(w, new Set(), 2 * H);
  assert.equal(W.waitingText(w), "No reply from pix");
  assert.equal(W.waitingText(W.tick(w, new Set(), 2 * H + W.NOTICE_MS)), undefined);
  // A late reply also clears the notice.
  assert.equal(W.waitingText(W.receivedNote(w, { thread: "t" })), undefined);
});

test("chat plugin: sending an ask shows 'Waiting for pix', survives reload, clears on the reply", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "chat-wait-"));
  process.env.PIX_CHAT_DIR = root;
  t.after(() => { delete process.env.PIX_CHAT_DIR; });
  const peer = chat.join_({ name: "pix", cwd: "/x", pid: process.pid, at: 0, status: "idle", doing: "", claims: [] }, () => {}, root);
  t.after(() => peer.close());
  const start = () => {
    const handlers = {}, tools = {}, status = new Map();
    const pi = { on: (e, f) => { (handlers[e] ??= []).push(f); }, registerTool: (x) => { tools[x.name] = x; }, registerMessageRenderer() {}, sendMessage() {}, getSessionName: () => "for-you" };
    registerChat(pi);
    const ctx = { cwd: "/y", hasUI: true, ui: { setStatus: (k, v) => v === undefined ? status.delete(k) : status.set(k, v) } };
    for (const f of handlers.session_start) f({}, ctx);
    return { tools, status, ctx, stop: () => { for (const f of handlers.session_shutdown) f({}, ctx); } };
  };
  let s = start();
  await s.tools.chat.execute("1", { action: "send", to: "pix", kind: "ask", message: "status?" }, undefined, undefined, s.ctx);
  assert.match(s.status.get("pix-chat-waits"), /^⏳ pix: status\? · now$/);
  assert.equal(s.status.get("pix-chat"), undefined, "not squeezed beside remote/memory");
  const file = W.waitingPath(root, "for-you");
  assert.ok(existsSync(file));
  // /reload: a fresh plugin instance reads the file back.
  s.stop(); s = start(); t.after(() => s.stop());
  assert.match(s.status.get("pix-chat-waits"), /^⏳ pix: status\?/);
  const thread = W.loadWaiting(file).waits[0].thread;
  chat.send("pix", "for-you", "reply", "all good", { thread, hop: 1 }, root);
  for (let i = 0; i < 100 && s.status.has("pix-chat-waits"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.status.get("pix-chat-waits"), undefined);
});

test("phone: a session waiting on another shows the same quiet 'Waiting for pix' in the list and the chat", async (t) => {
  const { chromium, devices } = await import("playwright");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const token = "chat-wait-token-1234567890";
  const home = mkdtempSync(join(tmpdir(), "chat-wait-hub-"));
  const hub = await startRemoteHub({ token, port: 0, home });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "For you", named: true, cwd: "/y", busy: false, peerWait: "Waiting for pix", messages: [{ role: "user", text: "hi" }] }) });
  const list = await (await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(list.find((s) => s.id === "s1").peerWait, "Waiting for pix");
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s1"; });
  await page.goto(`${base}/#token=${token}`);
  await page.locator(".peer-wait-line").waitFor();
  assert.equal(await page.locator(".peer-wait-line").textContent(), "Waiting for pix");
  if (process.env.PIX_SHOT) await page.screenshot({ path: process.env.PIX_SHOT });
  assert.equal(await page.locator(".bubble.typing").count(), 0, "not shown as running");
  await page.locator("#menu").click();
  assert.match(await page.locator(".peer-wait").first().textContent(), /Waiting for pix/);
});

test("real Pi session: an ask sent with the chat tool reaches the phone as peerWait; the reply clears it", async (t) => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const { readFile } = await import("node:fs/promises");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const registerRemote = (await import("../plugins/remote/index.ts")).default;
  const dir = mkdtempSync(join(tmpdir(), "chat-wait-rt-")), root = join(dir, "chat");
  process.env.PIX_CHAT_DIR = root; t.after(() => { delete process.env.PIX_CHAT_DIR; });
  const peer = chat.join_({ name: "pix", cwd: "/x", pid: process.pid, at: 0, status: "idle", doing: "", claims: [] }, () => {}, root);
  t.after(() => peer.close());
  const probe = await startRemoteHub({ token: "x".repeat(24), port: 0 }); const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
  const model = modelRuntime.getModels("anthropic")[0];
  const sessionManager = SessionManager.inMemory(dir);
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: dir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" }), pi => registerChat(pi)] } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager });
  await runtime.session.bindExtensions({ mode: "rpc", commandContextActions: { waitForIdle: () => runtime.session.waitForIdle(), newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }), navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }), reload: async () => {} } });
  t.after(async () => { await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await runtime.dispose(); });
  await runtime.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}` };
  const id = runtime.session.sessionManager.getSessionId();
  const get = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`, { headers })).json(); } catch { return {}; } };
  const until = async (p, what) => { for (let i = 0; i < 200; i++) { const s = await get(); if (p(s)) return s; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  const tool = runtime.session.extensionRunner.getAllRegisteredTools().find(x => x.definition.name === "chat").definition;
  const me = chat.board(root).find(x => x.name !== "pix").name;
  await tool.execute("1", { action: "send", to: "pix", kind: "ask", message: "status?" }, undefined, undefined, { cwd: dir });
  await until(s => s.peerWait === "Waiting for pix", "the phone sees the wait");
  const thread = W.loadWaiting(W.waitingPath(root, me)).waits[0].thread;
  chat.send("pix", me, "reply", "done", { thread, hop: 1 }, root);
  await until(s => !s.peerWait, "the reply clears it on the phone");
});

test("footer: each pending ask/handoff on its own line with what was asked and how long; gone when the reply arrives", () => {
  let w = { waits: [], notices: [] };
  w = W.sentNote(w, { thread: "t1", to: "minara-3", kind: "handoff", at: 0, message: "[For you] Please restyle leaderboard (DMind blue)\nmore detail" }, true);
  w = W.sentNote(w, { thread: "t2", to: "minara-2", kind: "ask", at: 60 * 60_000 }, true);
  assert.equal(W.waitingLines(w, 72 * 60_000), "⏳ minara-3: restyle leaderboard (DMind blue) · 1h12m   ⏳ minara-2 · 12m");
  assert.equal(W.noticeText(w), undefined, "waits are not squeezed beside remote/memory");
  assert.equal(W.waitingLines(W.receivedNote(W.receivedNote(w, { thread: "t1" }), { thread: "t2" })), undefined, "line hidden when nothing is pending");
  assert.equal(W.gist("x".repeat(80)).length, 40);
  assert.equal(W.gist("[chat handoff from session \"for-you\", thread c26d4060]\n\nbrook feedback on the footer waits line (0f8646e), screenshot /x.png:\n1. Move the waits line"), "Move the waits line");
  assert.equal(W.gist("Feedback from brook on the artifacts (thread 246b7aad). He clicked the footer item and it opened the hub."), "He clicked the footer item and it opene…");
  assert.equal(W.gist("brook's request (low-risk Pix UI, already approved): in the footer, move waits to their own line."), "in the footer, move waits to their own…");
  assert.equal(W.gist("anything long here", "restyle leaderboard"), "restyle leaderboard", "an explicit label wins");
});

test("check schedule: a handoff checks exponentially from 15 min; a due check wakes the sender once and moves on; the footer shows the next check", () => {
  const M = 60_000;
  assert.equal(W.checkFor("note"), undefined, "notes never check");
  assert.equal(W.checkFor("ask"), undefined, "asks are off by default");
  const c = W.checkFor("handoff", undefined, undefined, 0);
  assert.deepEqual(c, { mode: "exponential", every: 15 * M, n: 0, next: 15 * M });
  assert.deepEqual([0, 1, 2, 3].map(n => W.checkDelay({ mode: "exponential", every: 10 * M }, n) / M), [10, 20, 40, 60], "10, 20, 40, then capped at 60");
  assert.deepEqual([0, 3].map(n => W.checkDelay({ mode: "fixed", every: 10 * M }, n) / M), [10, 10]);
  let w = W.sentNote(empty, { thread: "t", to: "minara-2", kind: "handoff", at: 0, label: "vLLM batching", check: c }, true);
  const peers = new Map([["minara-2", "busy"]]);
  let r = W.tick(w, peers, 14 * M); assert.deepEqual(r.wakes, []);
  r = W.tick(r, peers, 15 * M);
  assert.equal(r.wakes.length, 1);
  assert.match(r.wakes[0], /^Check on vLLM batching \(thread t, to minara-2\): no reply for 15 min\. It is busy/);
  assert.equal(r.waits[0].check.next, 45 * M, "next check 30 min later");
  assert.deepEqual(W.tick(r, peers, 16 * M).wakes, [], "one wake per due check");
  assert.match(W.waitingLines(r, 15 * M), /^⏳ minara-2: vLLM batching · check \d\d:\d\d$/);
  assert.equal(W.waitingLines(W.receivedNote(r, { thread: "t" })), undefined, "a reply ends the checks");
});

test("check schedule: the receiver exiting, or going idle after working without replying, wakes the sender right away", () => {
  const M = 60_000, c = W.checkFor("handoff", "fixed", 30, 0);
  const w = W.sentNote(empty, { thread: "t", to: "pix", kind: "handoff", at: 0, check: c }, true);
  const gone = W.tick(w, new Map(), 2 * M);
  assert.match(gone.wakes[0], /pix left without replying/); assert.equal(gone.waits.length, 0);
  let r = W.tick(w, new Map([["pix", "busy"]]), M);
  r = W.tick(r, new Map([["pix", "idle"]]), 2 * M); assert.deepEqual(r.wakes, [], "a short idle is grace");
  r = W.tick(r, new Map([["pix", "idle"]]), 3 * M); assert.match(r.wakes[0], /pix stopped working without replying/);
  assert.deepEqual(W.tick(r, new Map([["pix", "idle"]]), 4 * M).wakes, [], "said once");
  // Without a schedule nothing wakes (only the quiet footer notice).
  assert.deepEqual(W.tick(W.sentNote(empty, { thread: "u", to: "pix", kind: "ask", at: 0 }, true), new Map(), M).wakes, []);
});

test("chat plugin: a handoff carries a check schedule; when the receiver leaves without replying, the sender is woken with 'Check on …'", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "chat-check-"));
  process.env.PIX_CHAT_DIR = root; t.after(() => { delete process.env.PIX_CHAT_DIR; });
  const peer = chat.join_({ name: "minara-2", cwd: "/x", pid: process.pid, at: 0, status: "busy", doing: "", claims: [] }, () => {}, root);
  const handlers = {}, tools = {}, status = new Map(), sent = [];
  const pi = { on: (e, f) => { (handlers[e] ??= []).push(f); }, registerTool: (x) => { tools[x.name] = x; }, registerMessageRenderer() {}, sendMessage: (m, o) => sent.push({ m, o }), getSessionName: () => "for-you" };
  registerChat(pi);
  const ctx = { cwd: "/y", hasUI: true, ui: { setStatus: (k, v) => v === undefined ? status.delete(k) : status.set(k, v) } };
  for (const f of handlers.session_start) f({}, ctx);
  t.after(() => { for (const f of handlers.session_shutdown) f({}, ctx); });
  const r = await tools.chat.execute("1", { action: "send", to: "minara-2", kind: "handoff", message: "batch it", label: "vLLM batching", checkMinutes: 10 }, undefined, undefined, ctx);
  assert.match(r.content[0].text, /First check in 10 min \(exponential\)/);
  assert.match(status.get("pix-chat-waits"), /^⏳ minara-2: vLLM batching · check \d\d:\d\d$/);
  assert.equal(W.loadWaiting(W.waitingPath(root, "for-you")).waits[0].check.every, 600_000);
  peer.close();
  // The plugin's own tick (every 30 s) notices; trigger it the way a reload would.
  for (const f of handlers.session_start) f({}, ctx);
  const wake = sent.find(x => x.m.customType === "pix-chat-check");
  assert.ok(wake, "the sender is woken");
  assert.match(wake.m.content, /^Check on vLLM batching \(thread \w+, to minara-2\): minara-2 left without replying/);
  assert.equal(wake.o.triggerTurn, true);
});
