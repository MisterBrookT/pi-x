import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autoReloadEnabled, createAutoReload, pixCodeVersion } from "../src/remote-autoreload.ts";
import { BACKGROUND_STATE_QUERY, backgroundState } from "../src/background-state.ts";

test("pixCodeVersion changes when extensions/ or src/ files change, not other files", async t => {
  const root = await mkdtemp(join(tmpdir(), "pix-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "extensions"), { recursive: true });
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "extensions", "a.ts"), "a");
  await writeFile(join(root, "src", "nested", "b.ts"), "b");
  const first = pixCodeVersion(root);
  await writeFile(join(root, "README.md"), "docs");
  assert.equal(pixCodeVersion(root), first, "files outside extensions/ and src/ are ignored");
  await writeFile(join(root, "src", "nested", "b.ts"), "bigger");
  assert.notEqual(pixCodeVersion(root), first);
  const second = pixCodeVersion(root);
  await writeFile(join(root, "extensions", "c.ts"), "c");
  assert.notEqual(pixCodeVersion(root), second, "a new file changes the version");
});

const harness = (overrides = {}) => {
  const state = { version: "v1", ready: true, reloads: 0, logs: [], reads: 0 };
  const auto = createAutoReload({
    version: () => { state.reads++; return state.version; }, ready: () => state.ready,
    reload: () => state.reloads++, log: line => state.logs.push(line), checkMs: 30_000, stableMs: 10_000, ...overrides,
  });
  return { state, auto };
};

test("auto-reload waits until a code change is stable, then reloads once and logs it", () => {
  const { state, auto } = harness();
  auto.tick(0);
  assert.equal(state.reloads, 0, "unchanged code never reloads");
  state.version = "v2";
  auto.tick(10_000);
  assert.equal(state.reads, 2, "checks at most every 30s");
  auto.tick(30_000); // sees v2
  state.version = "v3"; auto.tick(38_000); // still changing: restart debounce
  auto.tick(46_000);
  assert.equal(state.reloads, 0, "not stable for 10s yet");
  auto.tick(48_000);
  assert.equal(state.reloads, 1);
  assert.match(state.logs[0], /autoreload/);
  auto.tick(200_000);
  assert.equal(state.reloads, 1, "reloads only once");
});

test("auto-reload never fires while busy and retries when ready", () => {
  const { state, auto } = harness();
  state.version = "v2"; state.ready = false;
  auto.tick(30_000); auto.tick(50_000); auto.tick(60_000);
  assert.equal(state.reloads, 0);
  state.ready = true; auto.tick(61_000); // e.g. agent_settled
  assert.equal(state.reloads, 1);
});

test("auto-reload is not fired when a change reverts", () => {
  const { state, auto } = harness();
  state.version = "v2"; auto.tick(30_000);
  state.version = "v1"; auto.tick(40_000); auto.tick(80_000);
  assert.equal(state.reloads, 0);
});

test("PIX_REMOTE_AUTORELOAD=0 opts out", () => {
  assert.equal(autoReloadEnabled({ PIX_REMOTE_AUTORELOAD: "0" }), false);
  assert.equal(autoReloadEnabled({}), true);
});

test("background jobs are visible to the idle gate through Pi's event bus", () => {
  const handlers = new Map();
  const events = { on: (name, fn) => handlers.set(name, fn), emit: (name, data) => handlers.get(name)?.(data) };
  events.on(BACKGROUND_STATE_QUERY, state => { state.running = 2; });
  assert.equal(backgroundState({ events }).running, 2);
});
