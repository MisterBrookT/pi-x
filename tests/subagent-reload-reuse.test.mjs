// Regression tests for the pi-subagents 0.63.0 backport (patches/pi-subagents+0.63.0.patch):
// a same-session /reload must not kill workflow children, and relaunching the same
// workflow must reuse finished children and re-attach to running ones (upstream 0.74.0 #2546,
// with the 0.66.0 #1891 async-default child mode it depends on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { subagentRequest } from '../plugins/subagents/simple-subagent.ts';

// Pi provides its bundled packages to extensions at load time; mirror that for the executor import.
// Pi 1.3 hoists them to the top-level node_modules; older Pi nested them under pi-coding-agent.
const nested = resolve('node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works');
const piModules = existsSync(join(nested, 'pi-agent-core')) ? nested : resolve('node_modules/@earendil-works');
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-agent-core': join(piModules, 'pi-agent-core') } });
const upstream = resolve('node_modules/pi-subagents/src');
const reuse = await jiti.import(join(upstream, 'workflows/workflow-reuse.ts'));
const { prepareWorkflowLaunchParams } = await jiti.import(join(upstream, 'runs/foreground/subagent-executor.ts'));
const { updateTerminalRunIndex } = await jiti.import(join(upstream, 'runs/background/terminal-run-index.ts'));

const SESSION = 'session-a';
const SCRIPT = 'return await runs.all([{"key":"a","agent":"scout","task":"A"},{"key":"b","agent":"scout","task":"B"}]);';

function asyncRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pix-reload-reuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stoppedWorkflow(root, runId, { script = SCRIPT, stopCause, sessionId = SESSION, endedAt = Date.now() } = {}) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const status = { runId, sessionId, mode: 'workflow', state: 'stopped', startedAt: endedAt - 10, lastUpdate: endedAt, endedAt,
    workflow: { trace: [], emits: [], console: [], scriptDigest: reuse.workflowScriptDigest(script), ...(stopCause ? { stopCause } : {}) } };
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  updateTerminalRunIndex(dir, status);
  return dir;
}

const params = task => ({ agent: 'scout', task });

test('same-session reload tags the workflow abort so awaited children are not stopped', () => {
  const reload = reuse.workflowCleanupAbortReason(reuse.runtimeCleanupCauseForShutdown({ type: 'session_shutdown', reason: 'reload' }));
  assert.equal(reuse.workflowStopCause(reload), 'runtime-replaced');
  assert.equal(reuse.shouldStopWorkflowChildOnAbort(reload), false);
});

test('session switch, exit, and explicit stop still stop awaited children', () => {
  for (const reason of ['new', 'resume', 'fork', 'quit', undefined]) {
    const abort = reuse.workflowCleanupAbortReason(reuse.runtimeCleanupCauseForShutdown({ type: 'session_shutdown', reason }));
    assert.equal(reuse.shouldStopWorkflowChildOnAbort(abort), true, `reason ${reason}`);
  }
  assert.equal(reuse.shouldStopWorkflowChildOnAbort(new Error('Workflow stopped by user.')), true);
  assert.equal(reuse.shouldStopWorkflowChildOnAbort(undefined), true);
});

test('extension session_shutdown and runtime replacement route through the cause helpers', () => {
  const source = readFileSync(join(upstream, 'extension/index.ts'), 'utf8');
  assert.match(source, /pi\.on\("session_shutdown", async \(event\) => \{\s*runtimeEntry\.cleanup\(runtimeCleanupCauseForShutdown\(event\)\);/);
  assert.match(source, /previousRuntime\.cleanup\("runtime-replaced"\)/);
  assert.match(source, /controller\.abort\(workflowCleanupAbortReason\(cause\)\)/);
  const executor = readFileSync(join(upstream, 'runs/foreground/subagent-executor.ts'), 'utf8');
  assert.equal(executor.match(/if \(shouldStopWorkflowChildOnAbort\(/g)?.length, 3, 'every awaited-child abort path checks the stop cause');
});

test('workflow children with omitted async run as awaited background runners', () => {
  const child = prepareWorkflowLaunchParams({}, params('A'), 'wf-1', 'a');
  assert.equal(child.async, undefined, 'async follows asyncByDefault');
  assert.equal(child.workflowAwaitAsync, true);
  const foreground = prepareWorkflowLaunchParams({}, { ...params('A'), async: false }, 'wf-1', 'a');
  assert.equal(foreground.async, false, 'explicit foreground opt-out is kept');
  assert.equal(foreground.workflowAwaitAsync, undefined);
});

test('pix multi-task start launches a workflow whose children default to durable runners', () => {
  const request = subagentRequest({ action: 'start', tasks: [{ agent: 'scout', task: 'A' }, { agent: 'scout', task: 'B' }] });
  const children = JSON.parse(request.workflowScript.match(/runs\.all\((.*)\);$/)[1]);
  // The executor strips the workflow's own async flag before children inherit the defaults.
  const { workflowScript: _script, async: _async, ...defaults } = request;
  for (const child of children) {
    const launch = prepareWorkflowLaunchParams(defaults, child, 'wf-1', child.key);
    assert.equal(launch.workflowAwaitAsync, true, child.key);
    assert.notEqual(launch.async, false, child.key);
  }
});

test('relaunch reuses a finished child and re-attaches to a running one without duplicates', t => {
  const root = asyncRoot(t);
  const dir = stoppedWorkflow(root, 'wf-old', { stopCause: 'runtime-replaced' });
  const fa = reuse.workflowChildFingerprint(params('A'));
  const fb = reuse.workflowChildFingerprint(params('B'));
  reuse.appendWorkflowChildJournal(dir, { type: 'start', key: 'a', fingerprint: fa, runId: 'child-a' });
  reuse.appendWorkflowChildJournal(dir, { type: 'start', key: 'b', fingerprint: fb, runId: 'child-b' });
  reuse.appendWorkflowChildJournal(dir, { type: 'settle', key: 'a', fingerprint: fa, result: { key: 'a', ok: true, runId: 'child-a', output: 'done A', artifactPaths: [] } });
  const source = reuse.findWorkflowReuseSource(root, SESSION, reuse.workflowScriptDigest(SCRIPT));
  assert.equal(source?.runId, 'wf-old');
  assert.deepEqual(reuse.matchWorkflowReuse(source, 'a', fa), { kind: 'settled', result: { key: 'a', ok: true, runId: 'child-a', output: 'done A', artifactPaths: [] } });
  assert.deepEqual(reuse.matchWorkflowReuse(source, 'b', fb), { kind: 'started', runId: 'child-b' });
});

test('changed child args or a failed child run again', t => {
  const root = asyncRoot(t);
  const dir = stoppedWorkflow(root, 'wf-old', { stopCause: 'runtime-replaced' });
  const fa = reuse.workflowChildFingerprint(params('A'));
  reuse.appendWorkflowChildJournal(dir, { type: 'settle', key: 'a', fingerprint: fa, result: { key: 'a', ok: true, output: 'A', artifactPaths: [] } });
  reuse.appendWorkflowChildJournal(dir, { type: 'start', key: 'b', fingerprint: reuse.workflowChildFingerprint(params('B')), runId: 'child-b' });
  reuse.appendWorkflowChildJournal(dir, { type: 'settle', key: 'c', fingerprint: fa, result: { key: 'c', ok: false, output: 'boom', error: 'boom', artifactPaths: [] } });
  const source = reuse.findWorkflowReuseSource(root, SESSION, reuse.workflowScriptDigest(SCRIPT));
  assert.equal(reuse.matchWorkflowReuse(source, 'a', reuse.workflowChildFingerprint(params('A changed'))), undefined);
  assert.equal(reuse.matchWorkflowReuse(source, 'b', reuse.workflowChildFingerprint(params('B changed'))), undefined);
  assert.equal(reuse.matchWorkflowReuse(source, 'c', fa), undefined);
});

test('no reuse after an explicit stop, a different session, or a different script', t => {
  const root = asyncRoot(t);
  const digest = reuse.workflowScriptDigest(SCRIPT);
  const dir = stoppedWorkflow(root, 'wf-user-stop');
  reuse.appendWorkflowChildJournal(dir, { type: 'start', key: 'a', fingerprint: 'x', runId: 'child-a' });
  assert.equal(reuse.findWorkflowReuseSource(root, SESSION, digest), undefined, 'explicit stop is not runtime-replaced');
  stoppedWorkflow(root, 'wf-reload', { stopCause: 'runtime-replaced', sessionId: 'session-b', endedAt: Date.now() + 5 });
  assert.equal(reuse.findWorkflowReuseSource(root, SESSION, digest), undefined, 'other session is ignored');
  assert.equal(reuse.findWorkflowReuseSource(root, 'session-b', reuse.workflowScriptDigest('return 1;')), undefined);
  assert.equal(reuse.findWorkflowReuseSource(root, 'session-b', digest)?.runId, 'wf-reload');
});

test('only the newest same-script run is a reuse source', t => {
  const root = asyncRoot(t);
  const digest = reuse.workflowScriptDigest(SCRIPT);
  stoppedWorkflow(root, 'wf-older-reload', { stopCause: 'runtime-replaced', endedAt: Date.now() - 1000 });
  stoppedWorkflow(root, 'wf-newer-user-stop', { endedAt: Date.now() });
  assert.equal(reuse.findWorkflowReuseSource(root, SESSION, digest), undefined);
});

test('the installed pi-subagents carries the pix patch', () => {
  const out = execFileSync(process.execPath, ['scripts/apply-pi-subagents-patch.mjs'], { encoding: 'utf8' });
  assert.match(out, /already-applied/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.postinstall, /apply-pi-subagents-patch\.mjs/);
  assert.ok(pkg.files.includes('patches'));
});
