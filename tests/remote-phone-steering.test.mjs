import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../plugins/remote/remote-hub.ts';
import { renderRemoteMarkdown } from '../plugins/remote/remote-markdown.ts';

 test('iPhone steering survives delayed acknowledgement, stream patches and failure', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pix-steering-'));
  const output = resolve('.private/var/runs/test-ui', `steering-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(output, { recursive: true });
  const token = 'fixture-token-not-real';
  const hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, 'sessions'), memoryRoot: join(home, 'memory') });
  const base = `http://127.0.0.1:${hub.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let browser;
  t.after(async () => { await browser?.close(); await hub.close(); await rm(home, { recursive: true, force: true }); });
  const messages = [
    { id: 'user-start', role: 'user', text: 'Inspect the failing build and explain the fix.', timestamp: 1 },
    { id: 'assistant-work', role: 'assistant', text: 'I found the failing build. Checking the relevant source and tests now.', timestamp: 2,
      tools: [{ id: 'tool-read', name: 'read', input: '{"path":"src/index.ts"}', output: 'export function build() { return "ready"; }' },
        { id: 'tool-test', name: 'bash', input: '{"command":"npm test"}', output: 'Running checks…' }] },
  ];
  let stream = 'The build check is still running. I am tracing the failing assertion…';
  async function publish() {
    const response = await fetch(`${base}/agent/fixture`, { method: 'PUT', headers, body: JSON.stringify({
      id: 'fixture', name: 'Build investigation', named: true, cwd: home, busy: true,
      streaming: stream, streamingHtml: renderRemoteMarkdown(stream),
      messages: messages.map(message => ({ ...message, html: renderRemoteMarkdown(message.text) })),
    }) });
    assert.equal(response.status, 200);
  }
  await publish();
  browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  const page = await browser.newPage({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByPlaceholder('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByText('The build check is still running.', { exact: false }).waitFor();
  const steering = 'Please prioritize the regression test before changing the implementation.';
  const bubble = page.locator('#messages .msg.user .bubble').filter({ hasText: steering });
  let releaseAck;
  const ack = new Promise(resolveAck => { releaseAck = resolveAck; });
  let received;
  const requestReceived = new Promise(resolveReceived => { received = resolveReceived; });
  await page.route('**/api/sessions/fixture/prompt', async route => {
    const response = await route.fetch();
    received(JSON.parse(route.request().postData()));
    await ack;
    await route.fulfill({ response });
  });
  await page.getByPlaceholder('Steer Pi…').fill(steering);
  await page.getByRole('button', { name: 'Send' }).click();
  assert.deepEqual(await requestReceived, { text: steering, images: [] });
  await bubble.waitFor();
  assert.equal(await bubble.count(), 1, 'steering appears before server acknowledges the request');
  await page.screenshot({ path: join(output, '01-steering-before-ack.png'), fullPage: true });
  stream = 'The build check is still running. Regression test identified; checking the tool output…';
  await publish();
  await page.getByText('Regression test identified', { exact: false }).waitFor();
  assert.equal(await bubble.count(), 1, 'stream event retains optimistic steering');
  const queued = await (await fetch(`${base}/agent/fixture/next`, { headers })).json();
  assert.deepEqual(queued, { prompts: [steering] });
  messages.push({ id: 'user-steer', role: 'user', text: steering, timestamp: 3 });
  await publish();
  await page.waitForFunction(text => document.querySelectorAll('#messages .msg.user .bubble').length === 2 && document.querySelector('#messages').textContent.includes(text), steering);
  assert.equal(await bubble.count(), 1, 'session snapshot reconciles optimistic and canonical message');
  releaseAck();
  await page.waitForFunction(() => document.querySelector('#input').value === '');
  assert.equal(await bubble.count(), 1, 'delayed acknowledgement does not duplicate message');
  await page.screenshot({ path: join(output, '02-steering-reconciled.png'), fullPage: true });
  await page.reload();
  await bubble.waitFor();
  assert.equal(await bubble.count(), 1, 'canonical steering remains after browser reload');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/sessions/fixture/prompt', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture delivery unavailable' }) }));
  const failed = 'Please check the unavailable deployment too.';
  await page.getByPlaceholder('Steer Pi…').fill(failed);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Could not send. Try again.').waitFor();
  assert.match(await page.locator('#messages').textContent(), /Please check the unavailable deployment too/);
  await page.screenshot({ path: join(output, '03-steering-failure.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.html'), `<!doctype html><meta charset="utf-8"><title>iPhone steering fixture</title><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui;max-width:900px;margin:auto;padding:24px;background:#f7f6f2;color:#222}img{max-width:390px;width:100%;border:1px solid #aaa}section{margin:2em 0}</style><h1>iPhone steering journey</h1><p>Local deterministic Pi hub fixture; synthetic messages only. Automated assertions passed.</p><section><h2>Before prompt acknowledgement</h2><img src="01-steering-before-ack.png"></section><section><h2>After stream and session reconciliation</h2><img src="02-steering-reconciled.png"></section><section><h2>Failed delivery remains visible</h2><img src="03-steering-failure.png"></section>`);
  console.log(`Steering evidence: ${output}/report.html`);
});
