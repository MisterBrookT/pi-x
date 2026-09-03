import test from "node:test";
import assert from "node:assert/strict";
import { cacheHitRate, defaultFooterOptions, formatTokens, tokenSpeed } from "../src/footer.ts";

test("footer defaults favor useful operational metrics over cost", () => {
  assert.equal(defaultFooterOptions.tokenSpeed, true);
  assert.equal(defaultFooterOptions.cacheHit, true);
  assert.equal(defaultFooterOptions.cost, false);
});

test("footer formats usage and computes latest-request rates", () => {
  assert.equal(formatTokens(2100), "2.1k");
  assert.equal(formatTokens(156000), "156k");
  assert.equal(cacheHitRate(100, 800, 100), 80);
  assert.equal(tokenSpeed(120, 1000, 4000), 40);
});
