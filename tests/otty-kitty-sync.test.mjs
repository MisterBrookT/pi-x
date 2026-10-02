import test from "node:test";
import assert from "node:assert/strict";
import { OttyKittySyncFilter, installOttyKittySync, isLocalOtty } from "../src/otty-kitty-sync.ts";
import { Container, Image, TuiMainScreen, Text, setCapabilityOverrides } from "@earendil-works/pi-tui";

const B = "\x1b[?2026h", E = "\x1b[?2026l";
const run = (chunks) => { const f = new OttyKittySyncFilter(); return chunks.map((c) => f.push(c)).join("") + f.flush(); };

test("an image inside a synchronized frame is written outside it", () => {
  const img = "\x1b_Ga=T,f=100,C=1,r=3;AAAA\x1b\\";
  assert.equal(run([`${B}\x1b[7;1Hx${img}y${E}`]), `${B}\x1b[7;1Hx${E}${img}${B}y${E}`);
});

test("every chunk of a multi-part transmission stays outside the frame", () => {
  const input = `${B}a\x1b_Ga=T,f=100,m=1;AAAA\x1b\\\x1b_Gm=1;BBBB\x1b\\\x1b_Gm=0;CC\x1b\\b${E}`;
  assert.equal(run([input]), `${B}a${E}\x1b_Ga=T,f=100,m=1;AAAA\x1b\\\x1b_Gm=1;BBBB\x1b\\\x1b_Gm=0;CC\x1b\\${B}b${E}`);
});

test("sequences split across writes at every offset give the same output", () => {
  const input = `${B}a\x1b_Ga=T,i=9,m=1;AAAA\x1b\\\x1b_Gm=0;CC\x1b\\b${E}`;
  const whole = run([input]);
  for (let i = 1; i < input.length; i++) assert.equal(run([input.slice(0, i), input.slice(i)]), whole, `split at ${i}`);
  assert.equal(run([...input]), whole, "one character per write");
});

test("images outside a synchronized frame, deletes, and non-Kitty APC are unchanged", () => {
  const plain = "x\x1b_Ga=T,f=100;AAAA\x1b\\y";
  assert.equal(run([plain]), plain);
  const del = `${B}\x1b_Ga=d,d=I,i=5,q=2\x1b\\text${E}`;
  assert.equal(run([del]), del);
  const other = `${B}\x1b_Xsomething\x1b\\\x1b[2Ktext\x1b${E}`;
  assert.equal(run([other]), other);
});

test("image payload is streamed, not buffered", () => {
  const f = new OttyKittySyncFilter();
  const head = f.push(`${B}\x1b_Ga=T,f=100;`);
  assert.equal(head, `${B}${E}\x1b_Ga=T,f=100;`);
  assert.equal(f.push("A".repeat(100_000)), "A".repeat(100_000));
});

test("local Otty only", () => {
  assert.equal(isLocalOtty({ TERM_PROGRAM: "otty" }), true);
  for (const env of [{ TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "otty", SSH_CONNECTION: "x" }, { TERM_PROGRAM: "otty", TMUX: "/t" }, { TERM_PROGRAM: "otty", TERM: "screen" }])
    assert.equal(isLocalOtty(env), false);
});

test("install is idempotent and removal restores the original writer", () => {
  const writes = [];
  const terminal = { write(d) { writes.push(d); } };
  const original = terminal.write;
  const remove = installOttyKittySync(terminal);
  assert.equal(installOttyKittySync(terminal), remove);
  const wrapped = terminal.write;
  terminal.write(`${B}\x1b_Ga=T;AA\x1b\\${E}`);
  assert.deepEqual(writes, [`${B}${E}\x1b_Ga=T;AA\x1b\\${B}${E}`]);
  terminal.write("\x1b[?20");
  remove();
  assert.equal(terminal.write, original);
  assert.notEqual(terminal.write, wrapped);
  assert.equal(writes.at(-1), "\x1b[?20", "held bytes are flushed on removal");
  const again = installOttyKittySync(terminal);
  assert.notEqual(again, remove);
  again();
});

test("Pi TuiMainScreen output keeps the image outside synchronized output", () => {
  setCapabilityOverrides({ images: "kitty" });
  try {
    const writes = [];
    const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, drainInput: async () => {}, write: (d) => writes.push(d),
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
    const remove = installOttyKittySync(terminal);
    const tui = new TuiMainScreen(terminal, false);
    tui.addChild(new Text(Array.from({ length: 40 }, (_, i) => `history ${i}`).join("\n"), 0, 0));
    const chat = new Container(); tui.addChild(chat);
    tui.start(); tui.renderNow();
    writes.length = 0;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
    chat.addChild(new Image(png, "image/png", { fallbackColor: (s) => s }, { filename: "x.png", maxWidthCells: 4 }));
    chat.addChild(new Text("after", 0, 0));
    tui.renderNow();
    const out = writes.join("");
    const img = out.indexOf("\x1b_Ga=T");
    assert.ok(img > 0);
    let depth = 0;
    for (const m of out.slice(0, img).matchAll(/\x1b\[\?2026([hl])/g)) depth = m[1] === "h" ? 1 : 0;
    assert.equal(depth, 0, "sync is closed when the image is sent");
    assert.ok(out.slice(img).includes(B), "sync resumes after the image");
    assert.ok(out.endsWith(E));
    tui.stop();
    remove();
  } finally {
    setCapabilityOverrides({});
  }
});
