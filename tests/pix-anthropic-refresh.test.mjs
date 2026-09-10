import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import registerPixAnthropic from "../extensions/pix-anthropic/index.ts";

const provider = "pix-anthropic";
const expired = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0, accountId: "account", orgId: "org" };
const other = { type: "api_key", key: "unrelated-key" };
const tokenResponse = () => new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 }));

// Real Pi runtime and file-backed credentials. Only the HTTP boundary is faked;
// in particular, no permissive mock can hide Pi's post-refresh cancellation check.
async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ [provider]: expired, unrelated: other }), { mode: 0o600 });
  const createRuntime = async () => {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
    registerPixAnthropic({ registerProvider: runtime.registerProvider.bind(runtime) });
    return runtime;
  };
  return {
    runtime: await createRuntime(), createRuntime,
    read: async () => JSON.parse(await readFile(authPath, "utf8")),
  };
}

function delayedRefresh(t) {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  let calls = 0;
  let requestSignal;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/oauth/token");
    assert.equal(JSON.parse(init.body).refresh_token, expired.refresh);
    calls++;
    requestSignal = init.signal;
    started.resolve();
    return response.promise;
  });
  return { started: started.promise, finish: response.resolve, calls: () => calls, signal: () => requestSignal };
}

for (const phase of ["before response", "while reading response body"]) {
  test(`cancel ${phase}: stop waiting immediately but save the rotated token for a fresh runtime`, async (t) => {
    const h = await harness(t);
    const remote = delayedRefresh(t);
    const controller = new AbortController();
    const cancelled = assert.rejects(h.runtime.getAuth(provider, { signal: controller.signal }), /cancelled prompt/);
    await remote.started;
    const body = Promise.withResolvers();
    const reading = Promise.withResolvers();
    if (phase === "while reading response body") {
      const response = tokenResponse();
      // Rotation is already committed server-side; delay receipt of the body.
      t.mock.method(response, "text", () => { reading.resolve(); return body.promise; });
      remote.finish(response);
      await reading.promise;
    }
    controller.abort(new Error("cancelled prompt"));
    await cancelled;
    assert.equal(remote.signal().aborted, false, "prompt cancellation must not cancel the owned exchange");
    assert.equal((await h.read())[provider].refresh, expired.refresh);

    if (phase === "before response") remote.finish(tokenResponse());
    else body.resolve(await tokenResponse().text());
    // A second runtime waits on Pi's real file lock and must reuse the result,
    // not consume the same one-time refresh token again.
    const peer = await h.createRuntime();
    const auth = await peer.getAuth(provider);
    assert.equal(auth.auth.apiKey, "new-access");
    assert.equal(remote.calls(), 1);
    const stored = await h.read();
    assert.equal(stored[provider].refresh, "new-refresh");
    assert.equal(stored[provider].accountId, expired.accountId);
    assert.equal(stored[provider].orgId, expired.orgId);
    assert.deepEqual(stored.unrelated, other);
  });
}

test("cancellation before auth starts performs no refresh or credential write", async (t) => {
  const h = await harness(t);
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected HTTP request"); });
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await assert.rejects(h.runtime.getAuth(provider, { signal: controller.signal }), /already cancelled/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(await h.read(), { [provider]: expired, unrelated: other });
});

test("concurrent model and provider auth requests refresh once even when one caller cancels", async (t) => {
  const h = await harness(t);
  const peer = await h.createRuntime();
  const remote = delayedRefresh(t);
  const controller = new AbortController();
  const cancelled = assert.rejects(h.runtime.getAuth(provider, { signal: controller.signal }), /cancelled/);
  await remote.started;
  const model = peer.getModel(provider, "claude-haiku-4-5");
  assert.ok(model);
  const survivor = peer.getAuth(model, { signal: new AbortController().signal });
  controller.abort(new Error("cancelled"));
  await cancelled;
  remote.finish(tokenResponse());
  assert.equal((await survivor).auth.apiKey, "new-access");
  assert.equal(remote.calls(), 1);
  assert.equal((await h.read())[provider].refresh, "new-refresh");
});

test("a late refresh rejection is handled and preserves stored credentials", async (t) => {
  const h = await harness(t);
  const remote = delayedRefresh(t);
  const controller = new AbortController();
  const cancelled = assert.rejects(h.runtime.getAuth(provider, { signal: controller.signal }), /cancelled/);
  await remote.started;
  controller.abort(new Error("cancelled"));
  await cancelled;
  remote.finish(new Response('{"error":"invalid_grant"}', { status: 400 }));
  // Queue behind the failed transaction and confirm normal errors still surface.
  await assert.rejects(h.runtime.getAuth(provider), /OAuth refresh failed/);
  assert.deepEqual(await h.read(), { [provider]: expired, unrelated: other });
});

test("reloading the extension installs the runtime shim only once", async (t) => {
  const h = await harness(t);
  const installed = ModelRuntime.prototype.getAuth;
  registerPixAnthropic({ registerProvider: h.runtime.registerProvider.bind(h.runtime) });
  assert.equal(ModelRuntime.prototype.getAuth, installed);
});

test("bundled CLI keeps credentials when a real model request is cancelled", { timeout: 20000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pix-refresh-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "auth.json"), JSON.stringify({ [provider]: { ...expired, expires: Date.now() + 3600000 } }), { mode: 0o600 });
  const running = promisify(execFile)(process.execPath, [
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session",
    "-e", resolve("extensions/pix-anthropic/index.ts"),
    "-e", resolve("tests/helpers/pix-refresh-probe.ts"),
    "--provider", provider, "--model", "claude-haiku-4-5", "-p", "unused",
  ], {
    cwd: dir, timeout: 15000,
    env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PIX_ANTHROPIC_API_KEY: "", TERM: "dumb" },
  });
  running.child.stdin.end();
  const { stdout, stderr } = await running;
  assert.match(stdout, /PIX_REFRESH_PERSISTED/, stderr);
});

test("other providers retain normal cancellation", async (t) => {
  const h = await harness(t);
  const started = Promise.withResolvers();
  const credentials = new (await import("@earendil-works/pi-ai")).InMemoryCredentialStore();
  await credentials.modify("untouched", async () => expired);
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null, refreshOnCreate: false,
  });
  let refreshSignal;
  const config = h.runtime.getRegisteredProviderConfig(provider);
  runtime.registerProvider("untouched", { ...config, oauth: {
    ...config.oauth,
    refreshToken: async (_credentials, signal) => {
      refreshSignal = signal;
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  } });
  const controller = new AbortController();
  const pending = assert.rejects(runtime.getAuth("untouched", { signal: controller.signal }));
  await started.promise;
  controller.abort(new Error("cancelled"));
  await pending;
  assert.equal(refreshSignal.aborted, true);
});
