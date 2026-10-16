import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect as netConnect } from 'node:net';
import { createDecipheriv, createHash, getDiffieHellman } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../plugins/remote/remote-hub.ts';
import { createDesktopBroker } from '../plugins/desktop/remote-desktop.ts';
import { createDesktopCredentialStore } from '../plugins/desktop/remote-desktop-credentials.ts';

// Real noVNC (iPhone browser) -> real hub HTTP polling -> real broker -> loopback TCP fake Apple
// Screen Sharing server (ephemeral port, never 5900) speaking RFB 003.889 with ARD auth (type 30).
// The server decrypts the client's ARD credential block with Node crypto, as macOS would.
const dummy = { username: 'fixture-user', password: 'fixture-pass-not-real' };

function ardServer({ group = 'modp2', fragment = false }) {
  const result = { chosen: null, plaintext: null, error: null, clientInit: false, steps: [] };
  const sockets = new Set();
  const server = createServer(sock => {
    sockets.add(sock);
    const dh = getDiffieHellman(group); dh.generateKeys();
    const prime = dh.getPrime(), keyLength = prime.length;
    let buf = Buffer.alloc(0), stage = 'version';
    // Fragmented mode: dribble every server message out in tiny delayed pieces.
    const send = async bytes => {
      if (!fragment) return void sock.write(bytes);
      for (let i = 0; i < bytes.length; i += 3) { sock.write(bytes.subarray(i, i + 3)); await new Promise(r => setTimeout(r, 2)); }
    };
    const step = async () => {
      for (;;) {
        if (stage === 'version' && buf.length >= 12) {
          result.steps.push('version:' + buf.subarray(0, 12).toString().trim()); buf = buf.subarray(12); stage = 'security';
          await send(Buffer.from([1, 30]));
        } else if (stage === 'security' && buf.length >= 1) {
          result.chosen = buf[0]; buf = buf.subarray(1); stage = 'ard';
          const head = Buffer.alloc(4); head.writeUInt16BE(dh.getGenerator().readUIntBE(0, dh.getGenerator().length), 0); head.writeUInt16BE(keyLength, 2);
          const pub = Buffer.alloc(keyLength); dh.getPublicKey().copy(pub, keyLength - dh.getPublicKey().length);
          await send(Buffer.concat([head, prime, pub]));
        } else if (stage === 'ard' && buf.length >= 128 + keyLength) {
          const cipherText = buf.subarray(0, 128), clientPub = buf.subarray(128, 128 + keyLength); buf = buf.subarray(128 + keyLength);
          try {
            const shared = dh.computeSecret(clientPub);
            const sharedPadded = Buffer.alloc(keyLength); shared.copy(sharedPadded, keyLength - shared.length);
            const key = createHash('md5').update(sharedPadded).digest();
            const d = createDecipheriv('aes-128-ecb', key, null); d.setAutoPadding(false);
            result.plaintext = Buffer.concat([d.update(cipherText), d.final()]);
          } catch (e) { result.error = e.message; }
          const field = off => { const f = result.plaintext?.subarray(off, off + 64); const z = f ? f.indexOf(0) : -1; return z < 0 ? null : f.subarray(0, z).toString('utf8'); };
          const ok = field(0) === dummy.username && field(64) === dummy.password;
          result.verdict = ok;
          if (!ok) { const why = Buffer.from('authentication failed'), len = Buffer.alloc(4); len.writeUInt32BE(why.length); await send(Buffer.concat([Buffer.from([0, 0, 0, 1]), len, why])); stage = 'done'; setTimeout(() => sock.end(), 200); return; }
          stage = 'init'; await send(Buffer.from([0, 0, 0, 0]));
        } else if (stage === 'init' && buf.length >= 1) {
          buf = buf.subarray(1); stage = 'normal'; result.clientInit = true;
          const name = Buffer.from('Fixture Mac'), init = Buffer.alloc(24);
          init.writeUInt16BE(64, 0); init.writeUInt16BE(48, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          init.writeUInt32BE(name.length, 20);
          await send(Buffer.concat([init, name]));
        } else return;
      }
    };
    let chain = Promise.resolve();
    sock.write('RFB 003.889\n');
    sock.on('data', d => { buf = Buffer.concat([buf, d]); chain = chain.then(step).catch(e => { result.error = e.message; }); });
    sock.on('error', () => {});
  });
  return { server, result, sockets };
}

async function setup(t, opts) {
  const fake = ardServer(opts);
  await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  const port = fake.server.address().port;
  assert.notEqual(port, 5900);
  const home = await mkdtemp(join(tmpdir(), 'pix-ard-'));
  const token = 'fixture-token-not-real';
  // Fake `security` runner: never touches the real Keychain.
  const run = async args => {
    if (opts.keychainDelayMs) await new Promise(r => setTimeout(r, opts.keychainDelayMs));
    return args[0] === 'find-generic-password' ? { code: 0, stdout: JSON.stringify(dummy) + '\n' } : { code: 0, stdout: '' };
  };
  const hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, 'sessions'), memoryRoot: join(home, 'memory'),
    desktopBroker: createDesktopBroker({ connect: () => netConnect(port, '127.0.0.1') }), desktopCredentials: createDesktopCredentialStore(run) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  t.after(async () => { await browser.close(); await hub.close(); for (const s of fake.sockets) s.destroy(); await new Promise(r => fake.server.close(r)); await rm(home, { recursive: true, force: true }); });
  const page = await browser.newPage({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${hub.port}`);
  await page.getByPlaceholder('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.locator('#menu').click();
  await page.locator('#desktopOpen').click();
  return { page, result: fake.result, errors };
}

for (const [label, opts] of [
  ['1024-bit group, whole messages', { group: 'modp2' }],
  ['1024-bit group, fragmented TCP', { group: 'modp2', fragment: true }],
  ['2048-bit group, fragmented TCP', { group: 'modp14', fragment: true }],
]) {
  test(`ARD type 30 through the hub sends credentials an Apple server can decrypt (${label})`, async t => {
    const { page, result, errors } = await setup(t, opts);
    await page.locator('#desktopConnect').click();
    await Promise.race([
      page.locator('#desktopKeys').waitFor({ state: 'visible', timeout: 20_000 }),
      page.getByText(/Sign-in failed|Saved login failed/).waitFor({ timeout: 20_000 }),
    ]);
    assert.equal(result.steps[0], 'version:RFB 003.008', 'noVNC answers 003.889 with 3.8');
    assert.equal(result.chosen, 30, 'noVNC picked ARD');
    assert.equal(result.error, null);
    assert.ok(result.plaintext, 'server received the 128-byte credential block');
    const u = result.plaintext.subarray(0, 64), p = result.plaintext.subarray(64, 128);
    assert.equal(u.subarray(0, u.indexOf(0)).toString(), dummy.username);
    assert.equal(p.subarray(0, p.indexOf(0)).toString(), dummy.password);
    assert.equal(result.verdict, true);
    await page.locator('#desktopKeys').waitFor({ state: 'visible' });
    assert.equal(result.clientInit, true);
    assert.match(await page.locator('#desktopStatus').textContent(), /Connected/);
    assert.deepEqual(errors, []);
  });
}

test('fragmented ARD challenge with a slow saved-login lookup never flashes the manual sign-in form', async t => {
  const { page, result, errors } = await setup(t, { group: 'modp2', fragment: true, keychainDelayMs: 1500 });
  await page.evaluate(() => {
    const form = document.getElementById('desktopCredentials');
    window.__formShown = !form.hidden;
    new MutationObserver(() => { if (!form.hidden) window.__formShown = true; }).observe(form, { attributes: true, attributeFilter: ['hidden'] });
  });
  await page.locator('#desktopConnect').click();
  await page.getByText('Checking saved login…').waitFor({ timeout: 10_000 });
  await page.locator('#desktopKeys').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await page.evaluate(() => window.__formShown), false, 'manual form stayed hidden');
  assert.equal(result.verdict, true);
  assert.match(await page.locator('#desktopStatus').textContent(), /Connected/);
  assert.deepEqual(errors, []);
});
