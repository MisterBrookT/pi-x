import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markPhoneActive, markPhoneGone, phoneUse, resetPhoneActive, phoneActiveMs } from "../plugins/remote/privacy-cover.ts";

test("privacy cover: a phone request marks the phone in use for 10 min after a real action, throttled to one write per 5 s", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cover-")), "phone-active");
  resetPhoneActive();
  assert.equal(markPhoneActive(1000, path), true);
  assert.equal(Number(readFileSync(path, "utf8")), 1000 + phoneActiveMs);
  assert.equal(phoneActiveMs, 600_000);
  assert.equal(markPhoneActive(3000, path), false, "throttled");
  assert.equal(markPhoneActive(7000, path), true);
});

test("privacy cover helper is only a picture: clicks pass through, capture skips it, only real input lifts it", () => {
  const src = readFileSync(new URL("../plugins/remote/privacy-cover.swift", import.meta.url), "utf8");
  assert.match(src, /ignoresMouseEvents = true/, "computer-use clicks reach the apps under it");
  assert.match(src, /sharingType = \.none/, "screenshots and Screen Sharing see the real screen");
  assert.match(src, /setActivationPolicy\(\.prohibited\)/, "never takes keyboard focus");
  assert.match(src, /\?\? 120/, "only after 2 min without Mac mouse/keyboard");
  assert.match(src, /eventSourceUnixProcessID\) == 0/, "synthetic input (computer use) does not lift it");
  assert.doesNotMatch(src, /lockScreen|SACLockScreen|displaysleep/i, "never locks: WeChat/DingTalk reads keep working");
});

test("privacy cover: one Pi stopping its helper does not drop the cover another Pi shows; only one helper runs per Mac", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cover-")), path = join(dir, "phone-active");
  process.env.PIX_PHONE_ACTIVE = path; process.env.PIX_PRIVACY_COVER = "1";
  try {
    const { startPrivacyCover } = await import("../plugins/remote/privacy-cover.ts");
    resetPhoneActive(); markPhoneActive(Date.now(), path);
    const before = readFileSync(path, "utf8");
    startPrivacyCover()();
    assert.equal(readFileSync(path, "utf8"), before, "the shared mark is untouched");
  } finally { delete process.env.PIX_PHONE_ACTIVE; delete process.env.PIX_PRIVACY_COVER; }
  const src = readFileSync(new URL("../plugins/remote/privacy-cover.swift", import.meta.url), "utf8");
  assert.match(src, /flock\(lockFd, LOCK_EX \| LOCK_NB\)/, "a second helper waits instead of drawing its own cover");
});

test("privacy cover: locking the phone or leaving Pix drops the cover at once; anything else from the phone keeps it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cover-")), "phone-active");
  resetPhoneActive(); markPhoneActive(Date.now(), path);
  assert.equal(phoneUse("/api/push", "POST", '{"presence":"hidden","endpoint":"e"}'), "gone");
  assert.equal(phoneUse("/api/push", "POST", '{"presence":"visible","endpoint":"e"}'), "idle", "a presence ping is not an action");
  assert.equal(phoneUse("/api/sessions", "GET", ""), "idle", "Pix just open on the phone does not cover the Mac");
  assert.equal(phoneUse("/api/sessions/s1/prompt", "POST", "{}"), "here", "sending from the phone does");
  assert.equal(phoneUse("/api/desktop/frame", "GET", ""), "here", "watching the Mac screen does");
  assert.equal(phoneUse("/api/here?v=0", "GET", ""), "gone", "the page's own beacon, even without notifications");
  assert.equal(phoneUse("/api/here?v=1", "GET", ""), "idle");
  markPhoneGone(path);
  assert.equal(readFileSync(path, "utf8"), "0");
  assert.equal(markPhoneActive(Date.now(), path), true, "the next visible ping covers again without waiting for the throttle");
});

test("phone page beacons presence through the relay while visible and says goodbye when hidden, even with notifications off", async (t) => {
  const { relayAllowed } = await import("../plugins/remote/remote-relay-agent.ts");
  assert.ok(relayAllowed("/api/here?v=1", "GET"));
  const src = readFileSync(new URL("../plugins/remote/remote-web.ts", import.meta.url), "utf8");
  assert.match(src, /if\(paired\)\{const here=/, "beacon runs in the relay page only, independent of push");
  assert.match(src, /visibilitychange',here/);
});
