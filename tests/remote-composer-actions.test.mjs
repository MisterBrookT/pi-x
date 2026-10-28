import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";
import { relayAllowed } from "../plugins/remote/remote-relay-agent.ts";
import { remoteAppHtml } from "../plugins/remote/remote-web.ts";
import registerRemote from "../plugins/remote/index.ts";
import { say } from "./helpers/goal-session.mjs";

const token = "composer-token-1234567890abcdef";

test("+ holds only Photo and File; the ✦ sheet holds model, thinking and session actions", () => {
  const plus = remoteAppHtml.match(/<div class="actions" id="actions"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...plus.matchAll(/data-action="(\w+)"/g)].map(m => m[1]), ["photo", "file"]);
  const sheet = remoteAppHtml.match(/id="modelSheet"[\s\S]*?<\/div><\/div>/)[0];
  for (const a of ["rewind", "reload", "new", "compact"]) assert.match(sheet, new RegExp(`data-action="${a}"`));
  assert.match(sheet, /id="modelList"/); assert.match(sheet, /id="levelList"/);
});

test("phone file upload saves under the uploads folder, never overwrites, and is relay-allowed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-upload-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const uploads = join(dir, "uploads");
  const hub = await startRemoteHub({ token, port: 0, home: dir, uploadsDir: uploads }); t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "S", cwd: dir, busy: false, messages: [] }) });
  const up = (name, text) => fetch(`${base}/api/sessions/s1/file/upload`, { method: "POST", headers, body: JSON.stringify({ name, data: Buffer.from(text).toString("base64") }) });
  const a = await (await up("notes.txt", "one")).json(), b = await (await up("notes.txt", "two")).json();
  assert.ok(a.path.startsWith(uploads + "/") && a.path.endsWith("notes.txt"));
  assert.notEqual(a.path, b.path, "a second upload with the same name gets its own file");
  assert.equal(await readFile(a.path, "utf8"), "one");
  assert.equal(await readFile(b.path, "utf8"), "two");
  assert.equal((await up("../escape.txt", "x")).status, 400, "names cannot leave the uploads folder");
  assert.equal(relayAllowed("/api/sessions/s1/file/upload", "POST"), true);
});

test("a real Pi session lists its / commands for the phone, and a typed /name from the phone renames it like on the Mac", async t => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-slash-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 }); const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
  const model = modelRuntime.getModels("anthropic")[0];
  const sessionManager = SessionManager.inMemory(dir);
  // Seed two finished turns directly in the session tree; no model call is needed to rewind.
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 });
  sessionManager.appendMessage(say("first answer"));
  const u2 = sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "second question" }], timestamp: 3 });
  sessionManager.appendMessage(say("second answer"));
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: dir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager });
  await runtime.session.bindExtensions({ mode: "rpc", commandContextActions: {
    waitForIdle: () => runtime.session.waitForIdle(), newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
    navigateTree: (id, o) => runtime.session.navigateTree(id, o), switchSession: async () => ({ cancelled: true }), reload: () => runtime.session.reload(),
  } });
  t.after(async () => { await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await runtime.dispose(); });
  await runtime.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`, id = runtime.session.sessionManager.getSessionId();
  const get = async () => { try { return await (await fetch(`${base}/api/sessions/${id}`, { headers })).json(); } catch { return {}; } };
  const until = async (p, what) => { for (let i = 0; i < 200; i++) { const s = await get(); if (p(s)) return s; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  const s = await until(x => x.commands?.length, "the phone gets the command list");
  const names = s.commands.map(c => c.name);
  for (const n of ["new", "compact", "reload", "name", "rc"]) assert.ok(names.includes(n), n);
  assert.ok(s.commands.find(c => c.name === "rc").description, "with Pi's description");
  await fetch(`${base}/api/sessions/${id}/prompt`, { method: "POST", headers, body: JSON.stringify({ cid: "c1", text: "/name news-infra", images: [] }) });
  await until(x => x.name === "news-infra", "the session is renamed, no model turn");
  assert.equal(runtime.session.sessionManager.getSessionName(), "news-infra");
});

test("the phone rewinds a real Pi session to an earlier message, only among offered ones", async t => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const dir = await mkdtemp(join(tmpdir(), "pix-remote-rewind-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 }); const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
  const model = modelRuntime.getModels("anthropic")[0];
  const sessionManager = SessionManager.inMemory(dir);
  // Seed two finished turns directly in the session tree; no model call is needed to rewind.
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 });
  sessionManager.appendMessage(say("first answer"));
  const u2 = sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "second question" }], timestamp: 3 });
  sessionManager.appendMessage(say("second answer"));
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: dir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "" })] } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager });
  await runtime.session.bindExtensions({ mode: "rpc", commandContextActions: {
    waitForIdle: () => runtime.session.waitForIdle(), newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
    navigateTree: (id, o) => runtime.session.navigateTree(id, o), switchSession: async () => ({ cancelled: true }), reload: () => runtime.session.reload(),
  } });
  t.after(async () => { await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await runtime.dispose(); });
  await runtime.session.prompt("/rc tailnet");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${port}`, id = runtime.session.sessionManager.getSessionId();
  const get = async () => { try { return await (await fetch(`${base}/api/sessions/${id}`, { headers })).json(); } catch { return {}; } };
  const until = async (p, what) => { for (let i = 0; i < 200; i++) { const s = await get(); if (p(s)) return s; await new Promise(r => setTimeout(r, 50)); } assert.fail(what); };
  const start = await until(s => s.rewinds?.length === 2, "the phone sees both earlier messages as rewind points");
  assert.deepEqual(start.rewinds.map(r => r.text), ["first question", "second question"]);
  const act = body => fetch(`${base}/api/sessions/${id}/action`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await act({ action: "rewind", value: "not-a-message" })).status, 400, "only offered messages");
  assert.equal((await act({ action: "rewind", value: u2 })).status, 202);
  await until(s => s.rewinds?.length === 1, "the phone sees the rewound branch");
  assert.equal(runtime.session.sessionManager.getLeafId(), sessionManager.getEntry(u2).parentId, "Pi moved to just before the chosen message");
  assert.ok(runtime.session.sessionManager.getEntry(u2), "later turns stay saved in the tree");
});
