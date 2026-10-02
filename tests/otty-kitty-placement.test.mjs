import test from "node:test";
import assert from "node:assert/strict";
import { OttyKittySyncFilter } from "../src/otty-kitty-sync.ts";

// Model the observed Otty 1.5.4 failure: inside synchronized output,
// Kitty placement uses the cursor captured when the frame began.
function placement(output) {
  let cursor = [1, 1], frameCursor;
  const positions = [];
  for (const m of output.matchAll(/\x1b\[(\d+);(\d+)H|\x1b\[\?2026([hl])|\x1b_G[^;]*;[^\x1b]*\x1b\\/g)) {
    if (m[1]) cursor = [Number(m[1]), Number(m[2])];
    else if (m[3]) frameCursor = m[3] === "h" ? [...cursor] : undefined;
    else positions.push([...(frameCursor ?? cursor)]);
  }
  return positions;
}

test("an image follows its requested position, not the old input cursor", () => {
  const raw = "\x1b[22;23H\x1b[?2026h\x1b[7;1H\x1b_Ga=T,C=1;AAAA\x1b\\\x1b[?2026l";
  assert.deepEqual(placement(raw), [[22, 23]], "unfiltered output reproduces the observed stale placement");
  for (let split = 0; split <= raw.length; split++) {
    const filter = new OttyKittySyncFilter();
    const output = filter.push(raw.slice(0, split)) + filter.push(raw.slice(split)) + filter.flush();
    assert.deepEqual(placement(output), [[7, 1]], `correct placement with write boundary ${split}`);
  }
});
