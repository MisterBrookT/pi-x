import test from "node:test";
import assert from "node:assert/strict";
import { ottyCapabilities } from "../src/terminal-support.ts";

test("local Otty gets inline images and links even without the shell setting", () => {
  assert.deepEqual(ottyCapabilities({ TERM_PROGRAM: "otty", TERM: "xterm-256color" }), { images: "kitty", hyperlinks: true });
});

test("explicit PI_* settings win", () => {
  assert.deepEqual(ottyCapabilities({ TERM_PROGRAM: "otty", PI_IMAGE_PROTOCOL: "none", PI_HYPERLINKS: "1" }), {});
});

test("no change for other terminals, SSH, or tmux", () => {
  for (const env of [{ TERM_PROGRAM: "Apple_Terminal" }, { TERM_PROGRAM: "otty", SSH_CONNECTION: "x" }, { TERM_PROGRAM: "otty", TMUX: "/t" }, { TERM_PROGRAM: "otty", TERM: "screen-256color" }])
    assert.deepEqual(ottyCapabilities(env), {});
});
