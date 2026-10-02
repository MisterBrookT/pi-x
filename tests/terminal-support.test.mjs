import test from "node:test";
import assert from "node:assert/strict";
import { ottyCapabilities } from "../src/terminal-support.ts";
import { Image, getCapabilities, setCapabilityOverrides } from "@earendil-works/pi-tui";

test("local Otty enables inline Kitty images and links", () => {
  assert.deepEqual(ottyCapabilities({ TERM_PROGRAM: "otty", TERM: "xterm-256color" }), { images: "kitty", hyperlinks: true });
  assert.deepEqual(ottyCapabilities({ TERM_PROGRAM: "otty", PI_IMAGE_PROTOCOL: "kitty", PI_HYPERLINKS: "1" }), {});
});

test("Pi renders an inline Kitty image by default", () => {
  setCapabilityOverrides(ottyCapabilities({ TERM_PROGRAM: "otty" }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
  const lines = new Image(png, "image/png", { fallbackColor: s => s }, { filename: "/tmp/example.png" }).render(100);
  assert.equal(getCapabilities().images, "kitty");
  assert.ok(lines.length > 1);
  assert.match(lines[0], /\x1b_G/);
  setCapabilityOverrides({});
});

test("a capability change cannot repair an image already cached as Kitty rows", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
  setCapabilityOverrides({ images: "kitty" });
  const image = new Image(png, "image/png", { fallbackColor: s => s }, { filename: "/tmp/example.png" });
  assert.ok(image.render(100).length > 1);
  setCapabilityOverrides({ images: null });
  assert.ok(image.render(100).length > 1, "same-width image rows remain cached across /reload");
  image.invalidate();
  assert.equal(image.render(100).length, 1, "a fresh render uses the link fallback");
  setCapabilityOverrides({});
});

test("an explicit image protocol setting is respected", () => {
  assert.deepEqual(ottyCapabilities({ TERM_PROGRAM: "otty", PI_IMAGE_PROTOCOL: "none" }), { hyperlinks: true });
});

test("no change for other terminals, SSH, or tmux", () => {
  for (const env of [{ TERM_PROGRAM: "Apple_Terminal" }, { TERM_PROGRAM: "otty", SSH_CONNECTION: "x" }, { TERM_PROGRAM: "otty", TMUX: "/t" }, { TERM_PROGRAM: "otty", TERM: "screen-256color" }])
    assert.deepEqual(ottyCapabilities(env), {});
});
