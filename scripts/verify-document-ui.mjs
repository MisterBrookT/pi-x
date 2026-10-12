// Synthetic phone-browser document journey. Run locally or with PIX_DOCUMENT_RELAY=1 against the deployed relay.
// Screenshots and offline report remain private and append-only; never use a real session or pairing key.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, copyFile, realpath, rm, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../src/remote-hub.ts';
import { readRelayOrigin, startRemoteRelayAgent } from '../src/remote-relay-agent.ts';

const output = new URL(`../.private/var/runs/test-ui/document-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(output, { recursive: true });
const home = await realpath(await mkdtemp(join(tmpdir(), 'pix-document-ui-')));
const demo = join(home, 'demo');
await mkdir(demo);
const fixtures = [['document-multipage.pdf', 'Page', 3, 'pdf'], ['document-slides.pptx', 'Slide', 2, 'pptx'], ['document-legacy.ppt', 'Slide', 2, 'ppt']];
let legacyAvailable = true;
try { await access(new URL('fixtures/document-legacy.ppt', import.meta.url)); } catch { legacyAvailable = false; }
if (!legacyAvailable) { console.warn('LibreOffice-converted legacy .ppt fixture unavailable; legacy preview is NOT validated.'); fixtures.pop(); }
for (const [name] of fixtures) await copyFile(new URL(`fixtures/${name}`, import.meta.url), join(demo, name));
const token = randomBytes(24).toString('base64url');
const secret = randomBytes(32).toString('base64url');
const hub = await startRemoteHub({ token, port: 0, home, sessionsDir: join(home, 'sessions'), launch: async () => {} });
const base = `http://127.0.0.1:${hub.port}`;
const viaRelay = process.env.PIX_DOCUMENT_RELAY === '1';
let browser, relay, heartbeat;
const errors = [], results = [];
try {
  const publish = async () => {
    const response = await fetch(`${base}/agent/fixture`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fixture', name: 'Synthetic documents', cwd: demo, busy: false, messages: [{ id: 'a1', role: 'assistant', text: 'Synthetic document fixture', timestamp: 1 }] }) });
    assert.equal(response.status, 200);
  };
  await publish();
  heartbeat = setInterval(() => { void publish().catch(error => errors.push(`fixture heartbeat: ${error}`)); }, 10000);
  const origin = viaRelay ? await readRelayOrigin() : base;
  if (!origin) throw Error('Set PIX_REMOTE_RELAY_URL or configure relay.json for PIX_DOCUMENT_RELAY=1');
  if (viaRelay) { relay = startRemoteRelayAgent({ origin, secret, localBase: base, localToken: token }); await relay.ready; }
  browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
  const page = await browser.newPage({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(`pageerror: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()} (${message.location().url})`); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  page.on('requestfailed', request => { if (!(request.url().startsWith('blob:') && request.failure()?.errorText === 'net::ERR_ABORTED')) errors.push(`${request.url()}: ${request.failure()?.errorText}`); });
  await page.goto(viaRelay ? origin + '/#key=' + secret : base);
  if (!viaRelay) { await page.getByPlaceholder('Access token').fill(token); await page.getByRole('button', { name: 'Connect' }).click(); }
  else { await page.locator('#messages').getByText('Synthetic document fixture').waitFor({ timeout: 30000 }); }
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('#fileList .file-row').first().waitFor({ timeout: 15000 });
  for (const [name, label, count, ext] of fixtures) {
    await page.locator('.file-row').filter({ hasText: name }).click();
    await page.locator('#fileTitle').getByText(name).waitFor();
    await page.locator('#fileProgress').waitFor({ state: 'detached', timeout: 45000 });
    const images = page.locator('#fileBody .document-page img');
    await images.nth(count - 1).waitFor({ timeout: 45000 });
    assert.equal(await images.count(), count, `${name}: every page rendered`);
    for (let index = 0; index < count; index++) {
      const image = images.nth(index);
      assert.equal(await image.getAttribute('alt'), `${label} ${index + 1} of ${count}`);
      assert.equal(await image.evaluate(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0), true, `${name}: page ${index + 1} decoded`);
      assert.match(await image.getAttribute('src'), /^data:image\/jpeg;base64,/);
    }
    assert.equal(await page.locator('#fileBody iframe, #fileBody a[download]').count(), 0, `${name}: app-owned preview`);
    await images.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: new URL(`${ext}-last.png`, output).pathname, fullPage: true });
    await images.last().click();
    await page.locator('#imageViewer:not([hidden]) #fullImage').waitFor();
    assert.equal(await page.locator('#fullImage').getAttribute('src'), await images.last().getAttribute('src'), `${name}: tap enlarges the final page`);
    results.push(`${name}: ${count} decoded pages, final page captured, final-page enlargement opens`);
    await page.getByRole('button', { name: 'Close image' }).click();
    await page.locator('#imageViewer').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Close file' }).click();
  }
  assert.deepEqual(errors, [], 'unexpected browser runtime errors');
  console.log(results.join('\n'));
} catch (error) { errors.push(String(error)); if (browser) { try { const page = browser.contexts()[0]?.pages()[0]; if (page) { errors.push(`visible UI: ${await page.locator('body').innerText().then(text => text.slice(0, 1600))}`); await page.screenshot({ path: new URL('failure.png', output).pathname, fullPage: true }); } } catch (diagnosticError) { errors.push(`diagnostics: ${diagnosticError}`); } } throw error; }
finally {
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  if (!legacyAvailable) errors.push('Legacy PPT fixture unavailable: legacy fixture missing; legacy preview unverified.');
  const screenshots = await Promise.all(fixtures.map(async ([, , , ext]) => { try { return `<h2>${ext.toUpperCase()} last page</h2><img alt="${ext} last page" src="data:image/png;base64,${(await readFile(new URL(`${ext}-last.png`, output))).toString('base64')}">`; } catch { return ''; } }));
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic document acceptance</title><style>body{font:16px system-ui;max-width:720px;margin:24px auto;padding:0 16px}img{max-width:390px;width:100%;border:1px solid #bbb}</style><h1>Document UI: ${errors.length ? 'FAIL' : 'PASS'}</h1><p>${viaRelay ? 'Deployed relay' : 'Local hub'}, Chromium iPhone 13 emulation 390×844; actual iOS Safari is not covered. Synthetic fixtures only.</p><pre>${escape([...results, ...errors].join('\n'))}</pre>${screenshots.join('')}`;
  await writeFile(new URL('report.html', output), html);
  console.log(`Evidence: ${output.pathname}report.html`);
  clearInterval(heartbeat);
  await browser?.close();
  relay?.stop();
  await hub.close();
  await rm(home, { recursive: true, force: true });
}
