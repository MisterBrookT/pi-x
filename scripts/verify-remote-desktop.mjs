// Hosted iPhone acceptance: real Apple Screen Sharing handshake through a fresh encrypted relay room.
// Stops before authentication: no Mac password, real framebuffer, or screenshots are collected.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { startRemoteHub } from '../src/remote-hub.ts';
import { startRemoteRelayAgent, readRelayOrigin } from '../src/remote-relay-agent.ts';
const origin = await readRelayOrigin();
if (!origin) throw Error('Configure relay origin first');
const token = randomBytes(32).toString('base64url'), secret = randomBytes(32).toString('base64url');
// Never load a remembered real login during acceptance: stop at the sign-in form.
const hub = await startRemoteHub({ token, port: 0, desktopCredentials: {
 load: async () => undefined,
 save: async () => { throw Error('Acceptance must not save credentials'); },
 remove: async () => { throw Error('Acceptance must not delete credentials'); },
} });
const relay = startRemoteRelayAgent({ origin, secret, localBase: `http://127.0.0.1:${hub.port}`, localToken: token });
let browser;
try {
 await relay.ready;
 browser = await chromium.launch({ headless: true, ...(process.env.PIX_TEST_BROWSER_PATH ? { executablePath: process.env.PIX_TEST_BROWSER_PATH } : {}) });
 const page = await browser.newPage({ ...devices['iPhone 13'] });
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/#key='+secret);
 await page.locator('#menu').click();
 await page.locator('#desktopOpen').click();
 await page.locator('#desktopConnect').click();
 await page.locator('#desktopPassword').waitFor({state:'visible',timeout:30000});
 assert.equal(await page.locator('#desktopPassword').inputValue(),'');
 assert.ok(await page.locator('#desktopUsername').isVisible());
 assert.ok(await page.locator('#desktopRemember').isVisible());
 assert.equal(await page.locator('#desktopRemember').isChecked(), false);
 assert.ok(await page.locator('#desktopForget').isVisible());
 await page.locator('#desktopClose').click();
 assert.ok(await page.locator('#desktopPassword').isHidden());
 assert.deepEqual(errors,[]);
 console.log('PASS: hosted phone page -> encrypted relay -> Mac Screen Sharing -> Apple credentials request; close verified. Login itself requires brook.');
} finally { await browser?.close(); relay.stop(); await hub.close(); }
