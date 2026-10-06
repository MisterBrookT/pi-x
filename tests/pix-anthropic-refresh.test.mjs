import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import registerPixAnthropic from "../extensions/pix-anthropic/index.ts";
import { claudeKeychainService, readClaudeToken } from "../extensions/pix-anthropic/claude-auth.ts";

const provider = "pix-anthropic";
const legacy = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "pix-claude-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const configDir = join(dir, "claude");
  await mkdir(configDir);
  await writeFile(authPath, "{}", { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  await registerPixAnthropic({ registerProvider: runtime.registerNativeProvider.bind(runtime) });
  return { runtime, authPath, configDir };
}

async function credential(dir, token = "sk-ant-oat01-test", expiresAt = Date.now() + 3600000) {
  await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
}

test("real Pi runtime uses public native auth without stored OAuth and reads fresh Claude credentials each request", async (t) => {
  const h = await harness(t);
  const before = await readFile(h.authPath, "utf8");
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = h.configDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected refresh"); });
  if (process.platform === "darwin") {
    const bin = join(h.configDir, "security");
    await writeFile(bin, `#!/bin/sh
[ "$1" = find-generic-password ] && [ "$2" = -s ] && [ "$3" = "${claudeKeychainService(h.configDir)}" ] && [ "$4" = -w ] || exit 1
cat "${join(h.configDir, ".credentials.json")}"
`);
    await chmod(bin, 0o700);
    const path = process.env.PATH;
    process.env.PATH = `${h.configDir}:${path}`;
    t.after(() => { process.env.PATH = path; });
  }
  {
    await credential(h.configDir);
    assert.equal((await h.runtime.getAuth(provider)).auth.apiKey, "sk-ant-oat01-test");
    await credential(h.configDir, "sk-ant-oat01-new");
    assert.equal((await h.runtime.getAuth(h.runtime.getModel(provider, "claude-haiku-4-5"))).auth.apiKey, "sk-ant-oat01-new");
  }
  assert.equal((await h.runtime.getAuth(provider)).auth.apiKey, "sk-ant-oat01-new");
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await readFile(h.authPath, "utf8"), before);
  await registerPixAnthropic({ registerProvider: h.runtime.registerNativeProvider.bind(h.runtime) });
  assert.equal((await h.runtime.getAuth(provider)).auth.apiKey, "sk-ant-oat01-new");
});

test("obsolete stored OAuth must be removed once before native auth takes precedence", async (t) => {
  const h = await harness(t);
  await writeFile(h.authPath, JSON.stringify({ [provider]: legacy }));
  const old = process.env.PIX_ANTHROPIC_API_KEY;
  process.env.PIX_ANTHROPIC_API_KEY = "configured-test-key";
  t.after(() => { if (old === undefined) delete process.env.PIX_ANTHROPIC_API_KEY; else process.env.PIX_ANTHROPIC_API_KEY = old; });
  const runtime = await ModelRuntime.create({ authPath: h.authPath, modelsPath: null, refreshOnCreate: false });
  await registerPixAnthropic({ registerProvider: runtime.registerNativeProvider.bind(runtime) });
  assert.notEqual((await runtime.getAuth(provider))?.auth?.apiKey, "configured-test-key");
  assert.deepEqual(JSON.parse(await readFile(h.authPath, "utf8")), { [provider]: legacy });
});

test("models are available through real Pi enumeration without stored pix OAuth", async (t) => {
  const h = await harness(t);
  await writeFile(h.authPath, "{}");
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = h.configDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });
  if (process.platform === "darwin") {
    const bin = join(h.configDir, "security");
    await writeFile(bin, `#!/bin/sh\ncat "${join(h.configDir, ".credentials.json")}"\n`);
    await chmod(bin, 0o700);
    const path = process.env.PATH;
    process.env.PATH = `${h.configDir}:${path}`;
    t.after(() => { process.env.PATH = path; });
  }
  await credential(h.configDir);
  const available = await h.runtime.getAvailable(provider);
  assert.equal(available.length, 13);
  assert.ok(available.some(model => model.id === "claude-haiku-4-5"));
  const request = await h.runtime.prepareRequest(available.find(model => model.id === "claude-haiku-4-5"));
  assert.equal(request.options.apiKey, "sk-ant-oat01-test");
  assert.equal(await readFile(h.authPath, "utf8"), "{}");
});

test("security subprocess times out rather than hanging on a stalled Keychain", { skip: process.platform !== "darwin" }, async (t) => {
  const h = await harness(t);
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = h.configDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });
  const bin = join(h.configDir, "security");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o700);
  const path = process.env.PATH;
  process.env.PATH = `${h.configDir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const start = Date.now();
  await assert.rejects(readClaudeToken(), /credentials unavailable/);
  assert.ok(Date.now() - start < 10000, "security must terminate within ten seconds");
});

test("missing, malformed and expired Claude credentials yield safe actionable errors", async (t) => {
  const h = await harness(t);
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = h.configDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });
  if (process.platform === "darwin") {
    const bin = join(h.configDir, "security");
    await writeFile(bin, `#!/bin/sh
cat "${join(h.configDir, ".credentials.json")}"
`);
    await chmod(bin, 0o700);
    const path = process.env.PATH;
    process.env.PATH = `${h.configDir}:${path}`;
    t.after(() => { process.env.PATH = path; });
  }
  await assert.rejects(readClaudeToken(), /Sign in with Claude Code/);
  await writeFile(join(h.configDir, ".credentials.json"), "secret-invalid-json");
  await assert.rejects(readClaudeToken(), e => /malformed/.test(e.message) && !e.message.includes("secret-invalid-json"));
  await credential(h.configDir, "sk-ant-oat01-secret", 0);
  const cli = join(h.configDir, "claude");
  await writeFile(cli, '#!/bin/sh\nexit 1\n');
  await chmod(cli, 0o700);
  const path = process.env.PATH;
  process.env.PATH = `${h.configDir}:${path}`;
  t.after(() => { process.env.PATH = path; });
  await assert.rejects(h.runtime.getAuth(provider), e => /renewal failed/.test(e.message) && !e.message.includes("secret"));
  await writeFile(cli, '#!/bin/sh\nexit 0\n');
  await assert.rejects(readClaudeToken(), e => /remains expired/.test(e.message) && !e.message.includes("secret"));
});

test("expired Claude credentials renew once through Claude CLI for concurrent callers", async (t) => {
  const h = await harness(t);
  const old = process.env.CLAUDE_CONFIG_DIR;
  const path = process.env.PATH;
  process.env.CLAUDE_CONFIG_DIR = h.configDir;
  process.env.PATH = `${h.configDir}:${path}`;
  t.after(() => { process.env.CLAUDE_CONFIG_DIR = old; process.env.PATH = path; });
  await credential(h.configDir, "sk-ant-oat01-old", 0);
  const cli = join(h.configDir, "claude");
  await writeFile(cli, `#!/bin/sh
[ "$1" = -p ] && [ "$2" = 'Reply only AUTH_OK' ] && [ "$3" = --model ] && [ "$4" = haiku ] && [ "$5" = --max-turns ] && [ "$6" = 1 ] && [ "$7" = --tools ] && [ "$8" = '' ] || exit 2
[ -z "$CLAUDECODE" ] && [ -z "$ANTHROPIC_API_KEY" ] || exit 3
echo call >> "${join(h.configDir, "calls")}" 
sleep 0.1
printf '%s' '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-renewed","expiresAt":9999999999999}}' > "${join(h.configDir, ".credentials.json")}" 
`);
  await chmod(cli, 0o700);
  if (process.platform === "darwin") {
    const bin = join(h.configDir, "security");
    await writeFile(bin, `#!/bin/sh\ncat "${join(h.configDir, ".credentials.json")}"\n`);
    await chmod(bin, 0o700);
  }
  assert.deepEqual(await Promise.all([readClaudeToken(), readClaudeToken()]), ["sk-ant-oat01-renewed", "sk-ant-oat01-renewed"]);
  assert.equal((await readFile(join(h.configDir, "calls"), "utf8")).trim(), "call");
});

test("Claude config directory gives a distinct stable Keychain service", () => {
  assert.equal(claudeKeychainService(), process.env.CLAUDE_CONFIG_DIR ? claudeKeychainService(process.env.CLAUDE_CONFIG_DIR) : "Claude Code-credentials");
  assert.notEqual(claudeKeychainService("/tmp/one"), claudeKeychainService("/tmp/two"));
});

test("other providers retain Pi auth resolution and cancelled calls do not read Claude credentials", async (t) => {
  const h = await harness(t);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(h.runtime.getAuth(provider, { signal: abort.signal }), /cancelled/);
  assert.equal(await h.runtime.getAuth("unregistered-provider"), undefined);
});

test("globally bundled Pi lists Pix models with isolated Claude credentials", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { resolve } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pix-global-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, "claude");
  await mkdir(configDir);
  await credential(configDir);
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), CLAUDE_CONFIG_DIR: configDir };
  if (process.platform === "darwin") {
    const bin = join(dir, "security");
    await writeFile(bin, `#!/bin/sh\n[ "$1" = find-generic-password ] && [ "$2" = -s ] && [ "$3" = "${claudeKeychainService(configDir)}" ] && [ "$4" = -w ] || exit 1\ncat "${join(configDir, ".credentials.json")}"\n`);
    await chmod(bin, 0o700);
    env.PATH = `${dir}:${env.PATH}`;
  }
  const { stdout, stderr } = await promisify(execFile)("pi", ["--no-extensions", "--extension", resolve("extensions/pix-anthropic/index.ts"), "--list-models", "pix-anthropic"], { env, timeout: 30000 });
  assert.equal((stdout.match(/pix-anthropic/g) ?? []).length, 13);
  assert.doesNotMatch(stderr, /warn|error|refresh/i);
});
