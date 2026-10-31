import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.PIX_HOME = mkdtempSync(join(tmpdir(), "imggen-pix-"));
const { generateImages, buildPrompt, imageSize } = await import("../plugins/image-gen/generate.ts");
const { default: register } = await import("../plugins/image-gen/index.ts");

const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
function fakeCodex({ files = [[1024, 1024]], code = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "imggen-codex-")), calls = [];
  const run = async (args, env) => {
    calls.push({ args, env });
    const dir = join(home, "generated_images", "t-1");
    mkdirSync(dir, { recursive: true });
    files.forEach(([w, h], i) => writeFileSync(join(dir, `exec-${i}.png`), png(w, h)));
    return { code, stdout: '{"type":"thread.started","thread_id":"t-1"}\n' };
  };
  return { home, calls, run };
}

test("runs the official codex CLI read-only with the subscription home, copies images out and reports size", async () => {
  const c = fakeCodex({ files: [[1536, 1024]] }), out = mkdtempSync(join(tmpdir(), "imggen-out-"));
  const r = await generateImages({ prompt: "a cube", aspect: "landscape" }, out, c.run, c.home);
  assert.equal(r.length, 1);
  assert.ok(existsSync(r[0].path) && r[0].path.startsWith(out));
  assert.deepEqual([r[0].width, r[0].height], [1536, 1024]);
  const { args, env } = c.calls[0];
  assert.deepEqual(args.slice(0, 7), ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--ignore-rules"]);
  assert.match(args.at(-1), /1536x1024/);
  assert.equal(env.CODEX_HOME, c.home);
  assert.equal(env.OPENAI_API_KEY, process.env.OPENAI_API_KEY, "no key is injected");
});

test("edit inputs pass as -i, missing inputs and empty prompts are refused before running", async () => {
  const c = fakeCodex(), out = mkdtempSync(join(tmpdir(), "imggen-out-")), img = join(out, "in.png");
  writeFileSync(img, png(10, 10));
  await generateImages({ prompt: "make it blue", inputs: [img] }, out, c.run, c.home);
  assert.deepEqual(c.calls[0].args.slice(7, 9), ["-i", img]);
  await assert.rejects(generateImages({ prompt: "x", inputs: ["/nope.png"] }, out, c.run, c.home), /not found/);
  await assert.rejects(generateImages({ prompt: " " }, out, c.run, c.home), /required/);
  assert.equal(c.calls.length, 1);
});

test("no image means a clear failure, never a fallback", async () => {
  const c = fakeCodex({ files: [], code: 1 });
  await assert.rejects(generateImages({ prompt: "x" }, tmpdir(), c.run, c.home), /codex exec failed/);
});

test("n is clamped to 1..4 and named in the prompt", () => {
  assert.match(buildPrompt({ prompt: "x", n: 9 }), /exactly 4 images/);
  assert.match(buildPrompt({ prompt: "x" }), /exactly 1 image at 1024x1024/);
});

test("the tool returns paths and inline image blocks", async () => {
  const c = fakeCodex({ files: [[8, 8], [8, 8]] });
  process.env.PIX_IMAGE_DIR = mkdtempSync(join(tmpdir(), "imggen-tool-"));
  process.env.CODEX_HOME = c.home;
  let tool;
  register({ registerTool: t => { tool = t; } }, c.run);
  const res = await tool.execute("id", { prompt: "two" });
  assert.equal(res.content.filter(x => x.type === "image").length, 2);
  assert.match(res.content[0].text, /Saved 2 image/);
  assert.equal(imageSize(res.details.images[0].path).width, 8);
});
