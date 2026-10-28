import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../plugins/remote/remote-hub.ts';

// A tiny RFB 3.8 server speaking real bytes to the real noVNC bundle, behind the hub's desktop HTTP contract.
function rfbFixture({ securityTypes }) {
  const s = { out: [Buffer.from('RFB 003.008\n')], received: Buffer.alloc(0), stage: 'version', readSeq: 0, writeSeq: 0, delivered: null, closed: false, closeCalls: 0, writes: [] };
  s.feed = bytes => {
    s.received = Buffer.concat([s.received, bytes]);
    if (s.stage === 'version' && s.received.length >= 12) { s.received = s.received.subarray(12); s.stage = 'security'; s.out.push(Buffer.from([securityTypes.length, ...securityTypes])); }
    if (s.stage === 'security' && s.received.length >= 1) {
      const type = s.received[0]; s.received = s.received.subarray(1); s.chosen = type;
      if (type === 1) { s.stage = 'init'; s.out.push(Buffer.from([0, 0, 0, 0])); } else if (type === 2) { s.stage = 'vncauth'; s.out.push(Buffer.alloc(16, 7)); } else s.stage = 'auth';
    }
    // VNC password auth: the test decides the verdict via s.acceptAuth; a rejection ends the link like a real server.
    if (s.stage === 'vncauth' && !s.holdAuth && s.received.length >= 16) {
      s.received = s.received.subarray(16); s.authAttempts = (s.authAttempts || 0) + 1;
      if (s.acceptAuth) { s.stage = 'init'; s.out.push(Buffer.from([0, 0, 0, 0])); }
      else { const why = Buffer.from('bad password'), len = Buffer.alloc(4); len.writeUInt32BE(why.length); s.out.push(Buffer.from([0, 0, 0, 1]), len, why); s.stage = 'failed'; setTimeout(() => { s.closed = true; }, 300); }
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

async function setup(t, securityTypes, { failReads = 0, keychain, native, auto = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pix-desktop-'));
  const token = 'fixture-token-not-real';
  const hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, 'sessions'), memoryRoot: join(home, 'memory') });
  const base = `http://127.0.0.1:${hub.port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(async () => { await browser.close(); await hub.close(); await rm(home, { recursive: true, force: true }); });
  const page = await browser.newPage({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  // Most tests drive Connect by hand: start with auto-connect off (as after a Disconnect).
  if (!auto) await page.addInitScript(() => { window.pixDesktopNoAuto = true; });
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
    if (url.pathname === '/api/desktop/open') { opens++; return json(route, 200, native ? { id, nativeInput: true } : { id }); }
    if (native && url.pathname === `/api/desktop/${id}/input`) return native.handle(route, JSON.parse(req.postData()), json);
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
    if (keychain && url.pathname === `/api/desktop/${id}/credentials` && req.method() === 'GET') { keychain.gets++; if (keychain.gate) await keychain.gate; if (keychain.getError) return json(route, 500, { error: 'keychain locked' }); return json(route, 200, keychain.saved ? { saved: true, ...keychain.saved } : { saved: false }); }
    if (keychain && url.pathname === `/api/desktop/${id}/credentials` && req.method() === 'POST') { keychain.saved = JSON.parse(req.postData()); keychain.posts++; return json(route, 200, { ok: true }); }
    if (keychain && url.pathname === '/api/desktop/credentials' && req.method() === 'DELETE') { keychain.saved = null; keychain.deletes++; return json(route, 200, { ok: true }); }
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

test('Mac screen with auto-connect off waits for Connect, reaches noVNC sign-in, and clears it on Close', async t => {
  const { page, rfb, errors, opens } = await setup(t, [30]);
  await page.locator('#desktopConnect').waitFor();
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

test('Mac screen types live from the iPhone keyboard, with no Send step', async t => {
  const { page, rfb, errors, logs } = await setup(t, [1], { failReads: 1 });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#desktopStatus').textContent(), 'Connected · full control');
  assert.equal(await page.locator('#desktopView').getByRole('button', { name: 'Send' }).count(), 0, 'no staged Send button');
  await page.locator('#desktopKeyboard').click();
  assert.equal(await page.locator('#desktopKeyboard').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'desktopText', 'keyboard focuses the live input');
  assert.ok(await page.getByText('Tap a Mac field, then type.').isVisible());
  const keys = async n => { for (let i = 0; i < 60 && rfb.keys().length < n; i++) await page.waitForTimeout(50); return rfb.keys(); };
  // Each character goes out at once, and the input never holds it.
  await page.keyboard.type('a');
  assert.deepEqual(await keys(1), [0x61]);
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  await page.keyboard.insertText('€');
  // Backspace and Return still reach the Mac with an empty input.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  // IME: composition updates are not sent; the committed text is sent once.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '你' });
  // Panel keys.
  await page.locator('#desktopKeys').getByRole('button', { name: 'Esc' }).click();
  await page.locator('#desktopKeys').getByRole('button', { name: 'Return' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(await keys(7), [0x61, 0x010020ac, 0xff08, 0xff0d, 0x01004f60, 0xff1b, 0xff0d], 'each key once, IME commit only');
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'desktopText', 'toolbar taps keep the keyboard up');
  assert.doesNotMatch(logs.join('\n') + await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /€|你/);
  await page.locator('#desktopKeyboard').click();
  assert.equal(await page.locator('#desktopKeyPanel').isHidden(), true);
  // Zoom uses noVNC's public viewport props; Fit restores them.
  const props = () => page.evaluate(() => { const r = desktopRfb; return [r.scaleViewport, r.clipViewport, r.dragViewport]; });
  assert.deepEqual(await props(), [true, false, false]);
  await page.locator('#desktopFit').click();
  assert.equal(await page.locator('#desktopFit').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await props(), [false, true, true]);
  // A tap on the zoomed screen still clicks: real pointer-event packets (type 5, button 1 then 0).
  const before = rfb.received.length;
  const box = await page.locator('#desktopScreen canvas').boundingBox();
  await page.touchscreen.tap(box.x + 10, box.y + 10);
  let ptr = [];
  for (let i = 0; i < 40; i++) { const b = rfb.received.subarray(before); ptr = []; for (let j = 0; j + 6 <= b.length; j++) if (b[j] === 5 && b[j + 1] <= 1) ptr.push(b[j + 1]); if (ptr.includes(1) && ptr.at(-1) === 0) break; await page.waitForTimeout(50); }
  assert.ok(ptr.includes(1) && ptr.at(-1) === 0, 'tap sends button down then up');
  await page.locator('#desktopFit').click();
  assert.deepEqual(await props(), [true, false, false]);
  // Pinch: two fingers zoom in around the fingers (no click reaches the Mac); pinching back out returns to Fit.
  const pinchCdp = await page.context().newCDPSession(page);
  const sb = await page.locator('#desktopScreen').boundingBox();
  const cx = sb.x + sb.width / 2, cy = sb.y + sb.height / 2;
  const pts = d => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
  const pinch = async (from, to) => {
    await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
    for (let i = 1; i <= 5; i++) await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + (to - from) * i / 5) });
    await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const sent = rfb.received.length;
  const fit = await page.evaluate(() => desktopRfb._display.scale);
  await pinch(20, 120);
  const zoomed = await page.evaluate(() => desktopRfb._display.scale);
  assert.ok(zoomed > fit * 3, `pinch out zooms in (${fit} -> ${zoomed})`);
  assert.equal(await page.locator('#desktopFit').getAttribute('aria-pressed'), 'true');
  const pk = rfb.received.subarray(sent); let clicks = 0; for (let j = 0; j + 6 <= pk.length; j++) if (pk[j] === 5 && pk[j + 1] === 1) clicks++;
  assert.equal(clicks, 0, 'a pinch never clicks the Mac');
  // While zoomed, a one-finger drag moves the view (no click sent).
  await pinch(20, 120);
  const vp = () => page.evaluate(() => ({ ...desktopRfb._display._viewportLoc }));
  const v0 = await vp(), sentDrag = rfb.received.length;
  await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 3 }] });
  await page.waitForTimeout(300); // noVNC waits briefly for a possible second finger
  // The test screen is tiny and zoomed far in, so each step must cover a few Mac pixels.
  for (let i = 1; i <= 4; i++) { await page.waitForTimeout(30); await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - i * 40, y: cy - i * 20, id: 3 }] }); }
  await pinchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const v1 = await vp();
  assert.ok(v1.x !== v0.x || v1.y !== v0.y, `one-finger drag pans (${JSON.stringify(v0)} -> ${JSON.stringify(v1)})`);
  const dk = rfb.received.subarray(sentDrag); let dclicks = 0; for (let j = 0; j + 6 <= dk.length; j++) if (dk[j] === 5 && dk[j + 1] === 1) dclicks++;
  assert.equal(dclicks, 0, 'a drag never clicks the Mac');
  await pinch(120, 10);
  assert.deepEqual(await props(), [true, false, false], 'pinching back in returns to Fit');
  // The Mac side ending the link returns the view to its Connect state.
  rfb.closed = true;
  await page.locator('#desktopIntro').waitFor({ state: 'visible' });
  assert.match(await page.locator('#desktopStatus').textContent(), /Disconnected|Connection lost/);
  for (let i = 0; i < 20 && !rfb.closeCalls; i++) await page.waitForTimeout(50);
  assert.equal(rfb.closeCalls, 1);
  assert.equal(await page.locator('#desktopKeys').isHidden(), true);
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

const newKeychain = saved => ({ saved, gets: 0, posts: 0, deletes: 0, getError: false, gate: null });
const resetRfb = rfb => Object.assign(rfb, { out: [Buffer.from('RFB 003.008\n')], received: Buffer.alloc(0), stage: 'version', readSeq: 0, writeSeq: 0, delivered: null, closed: false });
const noSecretStorage = page => page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));

test('Mac screen signs in with the Keychain-saved login without showing the form', async t => {
  const keychain = newKeychain({ username: '', password: 'saved-pass' });
  const { page, rfb, errors, logs } = await setup(t, [2], { keychain });
  rfb.acceptAuth = true;
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(keychain.gets, 1);
  assert.equal(rfb.authAttempts, 1);
  assert.equal(await page.locator('#desktopCredentials').isHidden(), true);
  assert.equal(keychain.posts, 0, 'an already saved login is not re-saved');
  assert.doesNotMatch(await noSecretStorage(page) + logs.join('\n'), /saved-pass/);
  assert.deepEqual(errors, []);
});

test('Mac screen saves a typed login only with consent and only after sign-in succeeds', async t => {
  const keychain = newKeychain(null);
  const { page, rfb, errors, logs } = await setup(t, [2], { keychain });
  // Rejected attempt with Remember ticked: nothing is saved.
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.match(await page.locator('#desktopCredentials').textContent(), /Mac Keychain/);
  assert.equal(await page.locator('#desktopRemember').isChecked(), false, 'remember is opt-in');
  await page.locator('#desktopPassword').fill('wrong-pass');
  await page.locator('#desktopRemember').check();
  await page.locator('#desktopCredentials').getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Sign-in failed', { exact: false }).waitFor();
  await page.locator('#desktopIntro').waitFor({ state: 'visible' });
  assert.match(await page.locator('#desktopStatus').textContent(), /Sign-in failed/);
  assert.equal(keychain.posts, 0);
  // Accepted attempt with Remember ticked: saved after connect.
  resetRfb(rfb); rfb.acceptAuth = true;
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#desktopRemember').isChecked(), false, 'consent does not carry over');
  await page.locator('#desktopPassword').fill('right-pass');
  await page.locator('#desktopRemember').check();
  await page.locator('#desktopCredentials').getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('login saved on Mac', { exact: false }).waitFor();
  assert.equal(keychain.posts, 1);
  assert.deepEqual(keychain.saved, { username: '', password: 'right-pass' });
  assert.doesNotMatch(await noSecretStorage(page) + logs.join('\n'), /right-pass|wrong-pass/);
  assert.deepEqual(errors, []);
});

test('Mac screen falls back to the form after a stale saved login fails or the Keychain errors, and can forget it', async t => {
  const keychain = newKeychain({ username: '', password: 'stale-pass' });
  const { page, rfb, errors } = await setup(t, [2], { keychain });
  await page.locator('#desktopConnect').click();
  await page.getByText('Saved login failed', { exact: false }).waitFor();
  await page.locator('#desktopIntro').waitFor({ state: 'visible' });
  assert.equal(rfb.authAttempts, 1);
  // Next attempt asks by hand instead of retrying the stale login.
  resetRfb(rfb);
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.equal(keychain.gets, 1, 'stale login not fetched again');
  assert.equal(rfb.authAttempts, 1);
  // Forget is available while disconnected.
  await page.locator('#desktopClose').click();
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  await page.locator("#desktopMore").click();
  await page.locator('#desktopForget').click();
  await page.getByText('Saved Mac login forgotten').waitFor();
  assert.equal(keychain.deletes, 1);
  assert.equal(keychain.saved, null);
  // A Keychain error never blocks manual sign-in.
  resetRfb(rfb); keychain.getError = true;
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#desktopStatus').textContent(), 'Mac sign-in required');
  assert.deepEqual(errors, []);
});

test('Mac screen ignores a saved login that arrives after Close', async t => {
  let release;
  const keychain = newKeychain({ username: '', password: 'late-pass' });
  keychain.gate = new Promise(r => { release = r; });
  const { page, rfb, errors } = await setup(t, [2], { keychain });
  rfb.acceptAuth = true;
  await page.locator('#desktopConnect').click();
  for (let i = 0; i < 40 && !keychain.gets; i++) await page.waitForTimeout(50);
  assert.equal(keychain.gets, 1);
  await page.locator('#desktopClose').click();
  release();
  await page.waitForTimeout(300);
  assert.equal(rfb.authAttempts ?? 0, 0, 'late saved login is not sent');
  assert.equal(await page.locator('#desktopKeys').isHidden(), true);
  assert.deepEqual(errors, []);
});

test('Mac screen Forget during a saved-login load neither uses nor re-saves it', async t => {
  let release;
  const keychain = newKeychain({ username: '', password: 'forgot-pass' });
  keychain.gate = new Promise(r => { release = r; });
  const { page, rfb, errors } = await setup(t, [2], { keychain });
  rfb.acceptAuth = true;
  await page.locator('#desktopConnect').click();
  for (let i = 0; i < 40 && !keychain.gets; i++) await page.waitForTimeout(50);
  await page.locator("#desktopMore").click();
  await page.locator('#desktopForget').click();
  await page.getByText('Saved Mac login forgotten').waitFor();
  release();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  assert.equal(rfb.authAttempts ?? 0, 0, 'in-flight saved login is ignored after Forget');
  assert.equal(keychain.posts, 0);
  assert.deepEqual(errors, []);
});

test('Mac screen Forget while a remembered sign-in is pending cancels the save', async t => {
  const keychain = newKeychain(null);
  const { page, rfb, errors } = await setup(t, [2], { keychain });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopCredentials').waitFor({ state: 'visible' });
  await page.locator('#desktopPassword').fill('pending-pass');
  await page.locator('#desktopRemember').check();
  // Hold the auth verdict until Forget has been pressed.
  rfb.holdAuth = true;
  await page.locator('#desktopCredentials').getByRole('button', { name: 'Sign in' }).click();
  await page.locator("#desktopMore").click();
  await page.locator('#desktopForget').click();
  await page.getByText('Saved Mac login forgotten').waitFor();
  rfb.holdAuth = false; rfb.acceptAuth = true; rfb.feed(Buffer.alloc(0));
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  assert.equal(keychain.posts, 0, 'no save after Forget');
  assert.deepEqual(errors, []);
});

for (const [label, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) test(`Mac screen keeps a compact header and toolbar on screen (${label})`, async t => {
  const { page, errors } = await setup(t, [1]);
  await page.setViewportSize(viewport);
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.locator('#desktopKeyboard').click();
  assert.equal(await page.locator('#desktopForget').isHidden(), true, 'Forget lives behind the menu');
  await page.locator('#desktopMore').click();
  await page.locator('#desktopForget').waitFor({ state: 'visible' });
  const ids = ['desktopClose', 'desktopTitle', 'desktopMore', 'desktopForget', 'desktopKeyboard', 'desktopFit', 'desktopKeyPanel'];
  const boxes = await page.evaluate(ids => ids.map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; }), ids);
  for (const b of boxes) assert.ok(b.left >= 0 && b.right <= viewport.width && b.bottom <= viewport.height && b.w > 0, `${b.id} inside the screen`);
  for (const id of ['desktopClose', 'desktopMore', 'desktopKeyboard', 'desktopFit']) assert.ok(boxes.find(b => b.id === id).h >= 44, `${id} is a 44pt target`);
  assert.ok(await page.evaluate(() => document.querySelector('#desktopView header').getBoundingClientRect().height) <= 64, 'single-line header');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= viewport.width, 'no horizontal overflow');
  const screen = await page.locator('#desktopScreen').boundingBox();
  assert.ok(screen.height >= viewport.height - 64 - 110 - 60, 'screen takes most of the height');
  if (label === 'portrait') await page.screenshot({ path: '/tmp/pix-desktop-mobile.png' });
  assert.deepEqual(errors, []);
});

// Hub-side native input: seq-idempotent, records each executed event once; a test can hold or drop replies.
function nativeFixture() {
  const n = { executed: [], posts: [], seq: 0, gate: null, dropNext: 0, failNext: 0 };
  n.handle = async (route, body, json) => {
    n.posts.push(body);
    if (n.gate) await n.gate;
    if (body.seq < n.seq) return json(route, 200, { ack: body.seq + 1 });
    assert.equal(body.seq, n.seq, 'input seq has no gap');
    if (n.failNext) { n.failNext--; return json(route, 422, { error: 'could not type' }); }
    n.executed.push(body.key ? { key: body.key } : { text: body.text }); n.seq++;
    if (n.dropNext) { n.dropNext--; return route.abort('connectionreset'); }
    return json(route, 200, { ack: n.seq });
  };
  return n;
}

test('Mac screen sends native typing exactly once, coalesced and in order, and retries a lost reply with the same seq', async t => {
  const native = nativeFixture();
  const { page, rfb, errors, logs } = await setup(t, [1], { native });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.locator('#desktopKeyboard').click();
  const until = async f => { for (let i = 0; i < 80 && !f(); i++) await page.waitForTimeout(50); };
  // Hold the first request so later typing queues and coalesces behind it.
  let release; native.gate = new Promise(r => { release = r; });
  await page.keyboard.type('a');
  await until(() => native.posts.length === 1);
  await page.keyboard.type('bc');
  await page.keyboard.insertText('€');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('d');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '你' });
  await page.keyboard.press('Enter');
  await page.locator('#desktopKeys').getByRole('button', { name: 'Esc' }).click();
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  native.dropNext = 1; // the reply to the held first event is lost
  native.gate = null; release();
  await until(() => native.executed.length === 6);
  await page.waitForTimeout(300);
  assert.deepEqual(native.executed, [{ text: 'a' }, { text: 'bc€' }, { key: 'backspace' }, { text: 'd你' }, { key: 'enter' }, { key: 'escape' }]);
  const retried = native.posts.filter(p => p.seq === 0);
  assert.equal(retried.length, 2, 'lost reply is retried');
  assert.deepEqual(retried[0], retried[1], 'retry repeats the same seq and payload');
  assert.deepEqual(rfb.keys(), [], 'no VNC key events when native input is available');
  assert.doesNotMatch(logs.join('\n') + await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /€|你|bc/);
  assert.deepEqual(errors, []);
});

test('Mac screen native typing: Close cancels queued keys and an execution failure stops without retyping', async t => {
  const native = nativeFixture();
  const { page, rfb, errors } = await setup(t, [1], { native });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.locator('#desktopKeyboard').click();
  let release; native.gate = new Promise(r => { release = r; });
  await page.keyboard.type('x');
  for (let i = 0; i < 40 && !native.posts.length; i++) await page.waitForTimeout(50);
  await page.keyboard.type('yz');
  await page.keyboard.press('Enter');
  await page.locator('#desktopMore').click();
  await page.locator('#desktopDisconnect').click();
  await page.locator('#desktopClose').click();
  native.gate = null; release();
  await page.waitForTimeout(500);
  assert.deepEqual(native.executed, [{ text: 'x' }], 'queued keys after Disconnect are dropped');
  assert.equal(native.posts.length, 1);
  // Reconnect starts a fresh seq; a 422 ends the session instead of retyping.
  Object.assign(native, { seq: 0, posts: [], executed: [], failNext: 1 });
  resetRfb(rfb);
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.locator('#desktopKeyboard').click();
  await page.keyboard.type('q');
  await page.getByText('Typing failed on the Mac').waitFor();
  await page.keyboard.type('r');
  await page.waitForTimeout(300);
  assert.deepEqual(native.posts, [{ seq: 0, text: 'q' }], 'fresh seq, no retry after 422');
  assert.deepEqual(native.executed, []);
  assert.equal(await page.locator('#desktopIntro').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Mac screen native typing sends pasted and uncancelable input once, maps newlines to Return, and keeps the input empty', async t => {
  const native = nativeFixture();
  const { page, errors } = await setup(t, [1], { native });
  await page.locator('#desktopConnect').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  await page.locator('#desktopKeyboard').click();
  const until = async f => { for (let i = 0; i < 80 && !f(); i++) await page.waitForTimeout(50); };
  // The browser inserts text itself (beforeinput not cancelled), then fires input.
  const insert = (inputType, data, cancelable) => page.evaluate(([inputType, data, cancelable]) => {
    const el = document.getElementById('desktopText');
    const init = { inputType, cancelable, bubbles: true };
    if (inputType === 'insertFromPaste') { init.dataTransfer = new DataTransfer(); init.dataTransfer.setData('text/plain', data); } else init.data = data;
    if (el.dispatchEvent(new InputEvent('beforeinput', init))) { el.value += data; el.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true })); }
  }, [inputType, data, cancelable]);
  const typed = () => native.executed.map(e => e.key ? `<${e.key}>` : e.text).join('');
  await insert('insertFromPaste', 'p1\r\nq', true);
  await until(() => typed() === 'p1<enter>q');
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  await insert('insertText', 'dict', false); // uncancelable: falls back to the committed input value
  await until(() => typed().endsWith('dict'));
  await insert('insertReplacementText', 'r', false);
  await insert('insertText', 'k', true); // cancelable insertText is sent by beforeinput only
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ha', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '好' });
  await until(() => typed().endsWith('好'));
  await page.waitForTimeout(300);
  assert.equal(typed(), 'p1<enter>qdictrk好');
  assert.equal(await page.locator('#desktopText').inputValue(), '');
  assert.deepEqual(errors, []);
});

test('Mac screen native typing fails closed when the hub ack is not the next seq', async t => {
  for (const ack of [undefined, 5, 1.5, '1']) {
    const native = nativeFixture();
    native.handle = async (route, body, json) => { native.posts.push(body); return json(route, 200, ack === undefined ? {} : { ack }); };
    const { page, errors } = await setup(t, [1], { native });
    await page.locator('#desktopConnect').click();
    await page.locator('#desktopKeys').waitFor({ state: 'visible' });
    await page.locator('#desktopKeyboard').click();
    await page.keyboard.type('a');
    await page.getByText('Typing failed: unexpected reply from the Mac').waitFor();
    await page.keyboard.type('b');
    await page.waitForTimeout(200);
    assert.deepEqual(native.posts, [{ seq: 0, text: 'a' }], `ack ${JSON.stringify(ack)}: no further sends`);
    assert.deepEqual(errors, []);
  }
});

test('Mac screen connects on open, stays connected after Close, and reconnects by itself until Disconnect', async t => {
  const { page, rfb, errors, opens } = await setup(t, [1], { auto: true });
  // First open connects with no tap.
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(opens(), 1);
  // Close only hides: no hub close, same connection on reopen, no Connect tap.
  await page.locator('#desktopClose').click();
  await page.waitForTimeout(200);
  assert.equal(rfb.closeCalls ?? 0, 0, 'Close keeps the link');
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  assert.equal(await page.locator('#desktopKeys').isVisible(), true);
  assert.equal(opens(), 1, 'no new connection');
  // After a real drop (app backgrounded), opening reconnects without the Connect tap.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  resetRfb(rfb);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(opens(), 2, 'came back by itself');
  // Disconnect (in ⋯) really ends it and stops the background reconnect while the view stays open.
  await page.locator('#desktopMore').click();
  await page.locator('#desktopDisconnect').click({ force: true });
  await page.locator('#desktopIntro').waitFor({ state: 'visible' });
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  assert.equal(opens(), 2, 'no background reconnect after Disconnect');
  // Opening the Mac screen again is a request to connect: it connects at once, no explainer, no extra tap.
  await page.locator('#desktopClose').click();
  await page.locator('#menu').click();
  resetRfb(rfb);
  await page.locator('#desktopOpen').click();
  await page.locator('#desktopKeys').waitFor({ state: 'visible' });
  assert.equal(opens(), 3, 'reopening connects directly');
  assert.equal(await page.getByText('full control of your Mac', { exact: false }).count(), 0, 'no explainer paragraph');
  assert.deepEqual(errors, []);
});
