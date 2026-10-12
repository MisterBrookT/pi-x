// Integration regression for the pi-subagents 0.63.0 reload backport (patches/pi-subagents+0.63.0.patch).
// Loads the installed pi-subagents extension through Pi's real extension loader and ExtensionRunner,
// launches a real workflow whose children run in the real detached background runner, and replaces
// the spawned `pi` CLI with a deterministic fake (tests/fixtures/fake-pi-child.mjs) so no model is used.
// It never triggers a real session /reload; it emits the same session events the host emits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Running inside a pi-subagents child leaks PI_* env (e.g. PI_SUBAGENT_CHILD=1 disables the extension).
for (const key of Object.keys(process.env)) if (key.startsWith('PI_')) delete process.env[key];
const root = mkdtempSync(join(tmpdir(), 'pix-reload-integration-'));
process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, 'subagents');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.PI_SUBAGENT_PI_BINARY = resolve('tests/fixtures/fake-pi-child.mjs');
process.env.FAKE_PI_LOG = join(root, 'fake-pi.jsonl');

const pi = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const { loadExtensions } = await import('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
const extensionPath = resolve('node_modules/pi-subagents/index.ts');
const spawnedPids = new Set();

test.after(() => {
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(root, { recursive: true, force: true });
});

const noop = () => {};
const models = { getAvailable: () => [], getAll: () => [], find: () => undefined, getError: () => undefined, refresh: async () => {} };

// One extension runtime bound to a session, as AgentSession builds it on startup and on /reload.
async function startRuntime(sessionManager, reason) {
  const loaded = await loadExtensions([extensionPath], root, pi.createEventBus());
  assert.deepEqual(loaded.errors, []);
  const runner = new pi.ExtensionRunner(loaded.extensions, loaded.runtime, root, sessionManager, models);
  runner.bindCore(
    { sendMessage: noop, sendUserMessage: noop, appendEntry: noop, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => false, getThinkingLevel: () => 'off', setThinkingLevel: noop },
    { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => '', executeTool: async () => { throw new Error('not available'); }, getCallableTools: () => [] },
    { registerProvider: noop, unregisterProvider: noop },
  );
  const errors = [];
  runner.onError(error => errors.push(error));
  await runner.emit({ type: 'session_start', reason });
  const tool = loaded.extensions[0].tools.get('subagent').definition;
  return {
    errors,
    run: params => tool.execute(`call-${Math.random()}`, params, new AbortController().signal, noop, runner.createContext()),
    shutdown: shutdownReason => runner.emit({ type: 'session_shutdown', reason: shutdownReason }),
  };
}

function fakeLog() {
  if (!existsSync(process.env.FAKE_PI_LOG)) return [];
  const entries = readFileSync(process.env.FAKE_PI_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const entry of entries) spawnedPids.add(entry.pid);
  return entries;
}
const logged = (event, name) => fakeLog().filter(entry => entry.event === event && entry.name === name);
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const journal = dir => existsSync(join(dir, 'workflow-children.jsonl'))
  ? readFileSync(join(dir, 'workflow-children.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(label, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; fake pi log: ${JSON.stringify(fakeLog())}`);
    await new Promise(done => setTimeout(done, 50));
  }
}

const script = tag => `return await runs.all([`
  + `{"key":"fast","agent":"scout","task":"fake-task:${tag}fast sleep:50"},`
  + `{"key":"slow","agent":"scout","task":"fake-task:${tag}slow sleep:4000"}]);`;

async function launchWorkflow(runtime, workflowScript) {
  const launched = await runtime.run({ workflowScript });
  const dir = launched.details?.asyncDir;
  assert.ok(dir, `workflow launched in the background: ${JSON.stringify(launched.content)}`);
  return dir;
}

test('same-session reload keeps the running child alive and the relaunch reuses and re-attaches without duplicates', async () => {
  const session = pi.SessionManager.inMemory(root);
  const before = await startRuntime(session, 'startup');
  const workflowScript = script('reload');
  const firstDir = await launchWorkflow(before, workflowScript);
  await until('fast child to settle and slow child to start', () => logged('finish', 'reloadfast').length === 1 && logged('start', 'reloadslow').length === 1
    && readJson(join(firstDir, 'status.json'))?.steps?.some(step => step.workflowKey === 'fast' && step.status === 'completed'));
  const [slowChild] = logged('start', 'reloadslow');

  await before.shutdown('reload');
  const stopped = await until('first workflow to stop', () => { const s = readJson(join(firstDir, 'status.json')); return s?.state === 'stopped' && s; });
  await new Promise(done => setTimeout(done, 300));
  assert.ok(alive(slowChild.pid), 'reload must not kill the background child');
  assert.equal(stopped.workflow.stopCause, 'runtime-replaced');

  const after = await startRuntime(session, 'reload');
  const secondDir = await launchWorkflow(after, workflowScript);
  const done = await until('relaunched workflow to complete', () => { const s = readJson(join(secondDir, 'status.json')); return s?.state === 'complete' && s; });
  const value = Object.fromEntries(done.workflow.value.map(child => [child.key, child]));
  assert.equal(value.fast.ok, true);
  assert.equal(value.fast.reused, true, 'finished child is reused from the journal');
  assert.equal(value.slow.ok, true);
  assert.match(value.slow.output, /done reloadslow/, 're-attached to the surviving child result');
  assert.equal(logged('start', 'reloadfast').length, 1, 'fast child is not launched again');
  assert.equal(logged('start', 'reloadslow').length, 1, 'slow child is not duplicated');
  assert.equal(logged('finish', 'reloadslow').length, 1);
  assert.deepEqual(journal(secondDir).filter(record => record.type === 'start').map(record => record.runId),
    journal(firstDir).filter(record => record.type === 'start' && record.key === 'slow').map(record => record.runId));
  assert.deepEqual([...before.errors, ...after.errors], []);
  await after.shutdown('quit');
});

for (const reason of ['new', 'quit']) {
  test(`session_shutdown reason ${reason} stops the workflow and its running child`, async () => {
    const runtime = await startRuntime(pi.SessionManager.inMemory(root), 'startup');
    const dir = await launchWorkflow(runtime, script(reason));
    await until('slow child to start', () => logged('start', `${reason}slow`).length === 1&& readJson(join(dir, 'status.json'))?.steps?.some(step => step.workflowKey === 'slow' && step.runId));
    const [slowChild] = logged('start', `${reason}slow`);
    await runtime.shutdown(reason);
    const stopped = await until('workflow to stop', () => { const s = readJson(join(dir, 'status.json')); return s?.state === 'stopped' && s; });
    assert.equal(stopped.workflow.stopCause, undefined, 'not a reuse source');
    await until('child process to be killed', () => !alive(slowChild.pid), 5000);
    assert.equal(logged('finish', `${reason}slow`).length, 0);
  });
}

test('explicit stop of the workflow stops its running child', async () => {
  const runtime = await startRuntime(pi.SessionManager.inMemory(root), 'startup');
  const dir = await launchWorkflow(runtime, script('stop'));
  await until('slow child to start', () => logged('start', 'stopslow').length === 1&& readJson(join(dir, 'status.json'))?.steps?.some(step => step.workflowKey === 'slow' && step.runId));
  const [slowChild] = logged('start', 'stopslow');
  await runtime.run({ action: 'stop', id: readJson(join(dir, 'status.json')).runId });
  const stopped = await until('workflow to stop', () => { const s = readJson(join(dir, 'status.json')); return s?.state === 'stopped' && s; });
  assert.equal(stopped.workflow.stopCause, undefined);
  await until('child process to be killed', () => !alive(slowChild.pid), 5000);
  assert.equal(logged('finish', 'stopslow').length, 0);
  await runtime.shutdown('quit');
});
