import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markPhoneActive, resetPhoneActive, phoneActiveMs } from "../plugins/remote/privacy-cover.ts";

test("privacy cover: a phone request marks the phone active for 60 s, throttled to one write per 5 s", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cover-")), "phone-active");
  resetPhoneActive();
  assert.equal(markPhoneActive(1000, path), true);
  assert.equal(Number(readFileSync(path, "utf8")), 1000 + phoneActiveMs);
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
