import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { discoverAgents } = await jiti.import("../node_modules/pi-subagents/src/agents/agents.ts");

// defaultExtensions is an explicit child extension allowlist, not an addition
// to all the extensions loaded by the parent. Provider-only loading must work.
test("a child with an explicit extension list can discover Pix role models", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-child-provider-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const provider = resolve("extensions/pix-anthropic/index.ts");
  await writeFile(join(dir, "settings.json"), JSON.stringify({ subagents: {
    defaultExtensions: [provider],
    agentOverrides: { scout: { model: "pix-anthropic/claude-sonnet-5" } },
  } }));
  const scout = discoverAgents(dir, "user").agents.find(agent => agent.name === "scout");
  assert.ok(scout);
  assert.deepEqual(scout.extensions, [provider]);
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const list = async extensions => promisify(execFile)(process.execPath, [cli,
    "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
    ...extensions.flatMap(path => ["-e", path]), "--list-models", "pix-anthropic",
  ], { cwd: dir, timeout: 15000, env: { ...process.env, PI_OFFLINE: "1", PIX_ANTHROPIC_API_KEY: "test-not-a-secret", TERM: "dumb" } });
  const absent = await list([]);
  assert.doesNotMatch(absent.stdout, /claude-sonnet-5/);
  const present = await list(scout.extensions);
  assert.match(present.stdout, /pix-anthropic\s+claude-sonnet-5/);
  assert.match(present.stdout, /pix-anthropic\s+claude-opus-5/);
});
