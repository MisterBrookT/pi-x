import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../src/remote-hub.ts';

// A tiny RFB 3.8 server speaking real bytes to the real noVNC bundle, behind the hub's desktop HTTP contract.
function rfbFixture({ securityTypes }) {
  const s = { out: [Buffer.from('RFB 003.008\n')], received: Buffer.alloc(0), stage: 'version', readSeq: 0, writeSeq: 0, delivered: null, closed: false, closeCalls: 0, writes: [] };
  s.feed = bytes => {
    s.received = Buffer.concat([s.received, bytes]);
    if (s.stage === 'version' && s.received.length >= 12) { s.received = s.received.subarray(12); s.stage = 'security'; s.out.push(Buffer.from([securityTypes.length, ...securityTypes])); }
    if (s.stage === 'security' && s.received.length >= 1) {
      const type = s.received[0]; s.received = s.received.subarray(1); s.chosen = type;
      if (type === 1) { s.stage = 'init'; s.out.push(Buffer.from([0, 0, 0, 0])); } else s.stage = 'auth';
    }
    if (s.stage === 'init' && s.received.length >= 1) {
      s.received = s.received.subarray(1); s.stage = 'normal';
      const name = Buffer.from('Fixture Mac'), init = Buffer.alloc(24);
      init.writeUInt16BE(64, 0); init.writeUInt16BE(48, 2);
      Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
      init.writeUInt32BE(name.length, 20);
      s.out.push(init, name);
    }
  };
  s.keys = () => { const out = [], b = s.received; for (let i = 0; i + 8 <= b.length; i++) if (b[i] === 4 && b[i + 1] === 1 && b[i + 2] === 0 && b[i + 3] === 0) out.push(b.readUInt32BE(i + 4)); return out; };
  return s;
}

async function setup(t, securityTypes, { failReads = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pix-desktop-'));
  const token = 'fixture-token-not-real';
  const hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, 'sessions'), memoryRoot: join(home, 'memory') });
  const base = `http://127.0.0.1:${hub.port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(async () => { await browser.close(); await hub.close(); await rm(home, { recursive: true, force: true }); });
  const page = await browser.newPage({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => logs.push(m.text()));
  const id = 'abcdefghijklmnopqrstuvwx';
  const rfb = rfbFixture({ securityTypes });
  let opens = 0, readFailures = failReads;
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/desktop/**', async route => {
    const req = route.request(), url = new URL(req.url());
    assert.equal(req.headers().authorization, `Bearer ${token}`);
    if (url.pathname === '/api/desktop/open') { opens++; return json(route, 200, { id }); }
    if (url.pathname === `/api/desktop/${id}/read`) {
      const seq = Number(url.searchParams.get('seq'));
      if (readFailures > 0) { readFailures--; return json(route, 502, { error: 'relay hiccup' }); }
      if (rfb.delivered && rfb.delivered.seq === seq) return json(route, 200, { seq, data: rfb.delivered.data, closed: false });
      assert.equal(seq, rfb.readSeq, 'reads are sequential');
      if (!rfb.out.length) { await new Promise(r => setTimeout(r, 40)); return json(route, 200, { seq, data: '', closed: rfb.closed }); }
      const data = Buffer.concat(rfb.out.splice(0)).toString('base64');
      rfb.delivered = { seq, data }; rfb.readSeq = seq + 1;
      return json(route, 200, { seq, data, closed: false });
    }
    if (url.pathname === `/api/desktop/${id}/write`) {
      const body = JSON.parse(req.postData());
      assert.equal(body.seq, rfb.writeSeq, 'writes are sequential');
      const bytes = Buffer.from(body.data, 'base64');
      assert.ok(bytes.length <= 64 * 1024);
      rfb.writes.push(body); rfb.writeSeq++; rfb.feed(bytes);
      return json(route, 200, { ack: rfb.writeSeq });
    }
    if (url.pathname === `/api/desktop/${id}/close`) { rfb.closeCalls++; rfb.closed = true; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: 'no' });
  });
  await page.goto(base);
  await page.getByPlaceholder('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  return { page, rfb, errors, logs, opens: () => opens };
}

test('Mac screen asks for explicit Connect, reaches noVNC sign-in, and clears it on Close', async t => {
  const { page, rfb, errors, opens } = await setup(t, [30]);
  await page.getByText('full control of your Mac', { exact: false }).waitFor();
  assert.equal(opens(), 0, 'nothing opens before Connect');
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.equal(rfb.chosen, 30, 'real noVNC picked Apple ARD auth');
  assert.equal(await page.locator('#desktopStatus').textContent(), 'Mac sign-in required');
  await page.locator('#desktopUsername').fill('brook');
  await page.locator('#desktopPassword').fill('secret-pass');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.doesNotMatch(storage, /secret-pass/);
  await page.locator('#desktopClose').click();
  assert.equal(await page.locator('#desktopView').isHidden(), true);
  assert.equal(await page.locator('#desktopPassword').inputValue(), '');
  assert.equal(await page.locator('#desktopUsername').inputValue(), '');
  await page.waitForFunction(() => !document.querySelector('#desktopScreen canvas'));
  await t.test('close reaches the hub', async () => { for (let i = 0; i < 20 && !rfb.closeCalls; i++) await page.waitForTimeout(50); assert.equal(rfb.closeCalls, 1); });
  assert.deepEqual(errors, []);
});

test('Mac screen connects, sends typed text and control keys, and survives a transient read error', async t => {
  const { page, rfb, errors } = await setup(t, [1], { failReads: 1 });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#desktopStatus').textContent(), 'Connected · full control');
  await page.locator('#desktopText').fill('a€');
  await page.locator('#desktopKeys').getByRole('button', { name: 'Send' }).click();
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  for (const name of ['Enter', 'Backspace', 'Escape']) await page.locator('#desktopKeys').getByRole('button', { name, exact: true }).click();
  for (let i = 0; i < 40 && rfb.keys().length < 5; i++) await page.waitForTimeout(50);
  assert.deepEqual(rfb.keys(), [0x61, 0x010020ac, 0xff0d, 0xff08, 0xff1b]);
  await page.locator('#desktopFit').click();
  assert.equal(await page.locator('#desktopFit').getAttribute('aria-pressed'), 'false');
  // The Mac side ending the link returns the view to its Connect state.
  rfb.closed = true;
  await page.locator('#desktopIntro').waitFor({ state: 'visible' });
  assert.match(await page.locator('#desktopStatus').textContent(), /Disconnected|Connection lost/);
  // The channel already closed itself, but the hub link must still be released.
  for (let i = 0; i < 20 && !rfb.closeCalls; i++) await page.waitForTimeout(50);
  assert.equal(rfb.closeCalls, 1);
  // A fresh connection starts fitted again.
  Object.assign(rfb, { out: [Buffer.from('RFB 003.008\n')], received: Buffer.alloc(0), stage: 'version', readSeq: 0, writeSeq: 0, delivered: null, closed: false });
  await page.locator('#desktopConnect').click();
  await page.waitForFunction(() => document.querySelector('#desktopIntro').hidden);
  assert.equal(await page.locator('#desktopFit').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('Mac screen reports a failed open and stays closed', async t => {
  const { page, errors } = await setup(t, [1]);
  await page.route('**/api/desktop/open', route => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"too many desktop sessions"}' }));
  await page.locator('#desktopConnect').click();
  await page.getByText('Could not connect: too many desktop sessions').waitFor();
  assert.equal(await page.locator('#desktopConnect').isEnabled(), true);
  assert.deepEqual(errors, []);
});

test('Mac screen drops a pending open when the view is closed and reopened', async t => {
  const { page, rfb, errors } = await setup(t, [1]);
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/desktop/open', async route => { await gate; await route.fallback(); });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopClose').click();
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  release();
  for (let i = 0; i < 20 && !rfb.closeCalls; i++) await page.waitForTimeout(50);
  assert.equal(rfb.closeCalls, 1, 'stale opened id is closed');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#desktopIntro').isVisible(), true);
  assert.equal(await page.locator('#desktopScreen canvas').count(), 0);
  assert.equal(await page.locator('#desktopConnect').isEnabled(), true);
  assert.equal(rfb.writes.length, 0, 'no stale channel talks to the hub');
  assert.deepEqual(errors, []);
});

test('Mac screen keeps hardware shortcuts away from the Pix app', async t => {
  const { page, errors } = await setup(t, [1]);
  for (const key of ['Meta+K', 'Control+Shift+P']) {
    await page.keyboard.press(key);
    assert.equal(await page.locator('#switcher').isHidden(), true, `${key} stays with the Mac`);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#desktopView').isVisible(), true);
  assert.deepEqual(errors, []);
});
