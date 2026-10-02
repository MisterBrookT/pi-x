/**
 * Real Pi lifecycle test for the Otty Kitty sync filter installed by extensions/terminal-support.ts.
 * Drives a real InteractiveMode over a recording Terminal, starts a session whose transcript has an
 * image tool result, then resumes it the way /resume does. Every Kitty image must reach the terminal
 * outside a synchronized-output block (see src/otty-kitty-sync.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveMode, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import terminalSupport from "../extensions/terminal-support.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason) => ({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason, timestamp: Date.now() });
// Pi awaits each extension's session_start in load order; real pix extensions do async work there,
// so Pi renders the repainted transcript before terminal-support's handler runs.
const asyncSessionStart = (pi) => pi.on("session_start", () => new Promise((r) => setTimeout(r, 50)));
const settle = () => new Promise((r) => setTimeout(r, 150));

function imagesInsideSync(output) {
  let inSync = false, images = 0, inside = 0;
  for (const m of output.matchAll(/\x1b\[\?2026([hl])|\x1b_Ga=[Tp]/g)) {
    if (m[1]) inSync = m[1] === "h";
    else { images++; if (inSync) inside++; }
  }
  return { images, inside };
}

test("Otty images stay outside synchronized output at session start and after resume", async (t) => {
  const saved = { TERM_PROGRAM: process.env.TERM_PROGRAM, TMUX: process.env.TMUX, SSH_CONNECTION: process.env.SSH_CONNECTION, PI_OFFLINE: process.env.PI_OFFLINE };
  Object.assign(process.env, { TERM_PROGRAM: "otty", PI_OFFLINE: "1" });
  delete process.env.TMUX; delete process.env.SSH_CONNECTION;
  const dir = await mkdtemp(join(tmpdir(), "pix-otty-session-"));
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    setCapabilityOverrides({});
    await rm(dir, { recursive: true, force: true });
  });

  const writes = [];
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, drainInput: async () => {}, write: (d) => writes.push(d),
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, quietStartup: true });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: dir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [asyncSessionStart, terminalSupport] } });
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [] })), services, diagnostics: services.diagnostics };
  };

  const sessionManager = SessionManager.create(dir, dir);
  sessionManager.appendMessage({ role: "user", content: "look", timestamp: Date.now() });
  sessionManager.appendMessage(assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x.png" } }], "toolUse"));
  sessionManager.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "image" }, { type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: Date.now() });
  sessionManager.appendMessage(assistant([{ type: "text", text: "later text" }], "stop"));
  const sessionFile = sessionManager.getSessionFile();

  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager });
  const mode = new InteractiveMode(runtime, { terminal });
  t.after(async () => { mode.stop(); await runtime.dispose(); });
  await mode.init();
  await settle();
  const startup = imagesInsideSync(writes.join(""));
  assert.ok(startup.images > 0, "the startup transcript draws the image");
  assert.equal(startup.inside, 0, "startup image is outside synchronized output");

  writes.length = 0;
  await runtime.switchSession(sessionFile);
  await settle();
  const resumed = imagesInsideSync(writes.join(""));
  assert.ok(resumed.images > 0, "the resumed transcript redraws the image");
  assert.equal(resumed.inside, 0, "resumed image is outside synchronized output");
});
