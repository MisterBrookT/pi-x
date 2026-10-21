import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markPhoneActive, resetPhoneActive, phoneActiveMs } from "../plugins/remote/privacy-cover.ts";

test("privacy cover: a phone request marks the phone in use for 60 min (reading sends nothing), throttled to one write per 5 s", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cover-")), "phone-active");
  resetPhoneActive();
  assert.equal(markPhoneActive(1000, path), true);
  assert.equal(Number(readFileSync(path, "utf8")), 1000 + phoneActiveMs);
  assert.equal(phoneActiveMs, 60 * 60_000, "default hold is one hour");
  assert.equal(markPhoneActive(3000, path), false, "throttled");
  assert.equal(markPhoneActive(7000, path), true);
});

test("privacy cover helper is only a picture: clicks pass through, capture skips it, only real input lifts it", () => {
  const src = readFileSync(new URL("../plugins/remote/privacy-cover.swift", import.meta.url), "utf8");
  assert.match(src, /ignoresMouseEvents = true/, "computer-use clicks reach the apps under it");
  assert.match(src, /sharingType = \.none/, "screenshots and Screen Sharing see the real screen");
  assert.match(src, /setActivationPolicy\(\.prohibited\)/, "never takes keyboard focus");
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
