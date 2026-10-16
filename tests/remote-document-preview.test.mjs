import assert from "node:assert/strict";
import { access, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { previewRemoteDocument } from "../plugins/remote/remote-document-preview.ts";

async function home(t) {
  const path = await mkdtemp(join(tmpdir(), "pix-preview-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("PDF metadata and distinct real rendered pages, with strict page validation", async t => {
  const dir = await home(t), pdf = join(dir, "document.pdf");
  await copyFile(resolve("scripts/fixtures/document-multipage.pdf"), pdf);
  const roots = { home: dir, hubRoot: dir };
  const meta = await previewRemoteDocument(pdf, null, roots);
  assert.equal(meta.status, 200);
  assert.equal(meta.kind, "pages");
  assert.ok(meta.pages >= 2);
  const first = await previewRemoteDocument(pdf, "1", roots);
  const second = await previewRemoteDocument(pdf, "2", roots);
  assert.equal(first.mimeType, "image/jpeg");
  assert.equal(first.page, 1);
  assert.ok(first.data.length < 1_000_000);
  assert.notEqual(first.data, second.data);
  for (const bad of ["0", "1;echo hacked", "-1", "1.2", "999999"]) assert.equal((await previewRemoteDocument(pdf, bad, roots)).status, 400);
  assert.equal((await previewRemoteDocument(pdf, String(meta.pages + 1), roots)).status, 400);
  assert.equal((await previewRemoteDocument("/etc/passwd", null, roots)).status, 404);
});

test("corrupt and oversized sources fail explicitly; runner receives argv not shell", async t => {
  const dir = await home(t), pdf = join(dir, "a;touch hacked.pdf");
  await writeFile(pdf, "broken");
  const roots = { home: dir, hubRoot: dir };
  let args;
  const runner = async (command, argv) => {
    args = [command, argv];
    throw Error("Command failed: encrypted password");
  };
  const result = await previewRemoteDocument(pdf, null, roots, runner);
  assert.match(result.error, /password-protected/);
  assert.deepEqual(args, ["pdfinfo", [await realpath(pdf)]]);
  await writeFile(pdf, Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal((await previewRemoteDocument(pdf, null, roots, runner)).status, 413);
});

test("PPT and PPTX conversion operates on a private copy and rejects excessive page counts", async t => {
  const dir = await home(t);
  for (const extension of ['ppt', 'pptx']) {
    const source = join(dir, 'original.' + extension);
    await writeFile(source, 'synthetic presentation');
    let copiedSource;
    const runner = async (command, args, options) => {
      if (command.includes('soffice')) {
        assert.equal(options.timeout, 90_000);
        assert.deepEqual(args.slice(1, 5), ['--headless', '--convert-to', 'pdf', '--outdir']);
        copiedSource = args.at(-1);
        assert.notEqual(copiedSource, source);
        assert.match(copiedSource, /pix-document-preview-/);
        assert.equal(await readFile(copiedSource, 'utf8'), 'synthetic presentation');
        assert.equal(args[5], join(copiedSource, '..'));
        assert.equal(args[0], `-env:UserInstallation=${new URL(`file://${join(args[5], 'profile')}`).href}`);
        await writeFile(join(args[5], 'source.pdf'), '%PDF-mock');
        return { stdout: '' };
      }
      assert.equal(command, 'pdfinfo');
      return { stdout: 'Pages: 201\nEncrypted: no\n' };
    };
    const result = await previewRemoteDocument(source, null, { home: dir, hubRoot: dir }, runner);
    assert.equal(result.status, 415);
    assert.match(result.error, /too many pages/);
    await assert.rejects(access(copiedSource), /ENOENT/, 'failed conversion cleans its temporary source');
  }
});

test('missing converter, timeout and missing output fail explicitly without leaking private copies', async t => {
  const dir = await home(t), source = join(dir, 'slides; echo unsafe.pptx');
  await writeFile(source, 'slides');
  for (const scenario of ['missing', 'timeout', 'output']) {
    let copiedSource;
    const runner = async (command, args) => {
      assert.match(command, /soffice$/);
      copiedSource = args.at(-1);
      assert.equal(await readFile(copiedSource, 'utf8'), 'slides');
      if (scenario === 'missing') throw Object.assign(Error('spawn failed'), { code: 'ENOENT' });
      if (scenario === 'timeout') throw Object.assign(Error('process stopped'), { killed: true, signal: 'SIGTERM' });
      return { stdout: 'conversion success', stderr: '' };
    };
    const result = await previewRemoteDocument(source, null, { home: dir, hubRoot: dir }, runner);
    assert.equal(result.status, 415);
    assert.match(result.error, scenario === 'missing' ? /install Poppler or LibreOffice/ : scenario === 'timeout' ? /timed out/ : /conversion failed/);
    await assert.rejects(access(copiedSource), /ENOENT/);
  }
});

test("real PPTX conversion through LibreOffice when requested", async t => {
  if (process.env.PIX_TEST_LIBREOFFICE !== '1') return t.skip('LibreOffice integration requires PIX_TEST_LIBREOFFICE=1');
  const dir = await home(t), path = join(dir, "slides.pptx");
  await copyFile(resolve("scripts/fixtures/document-slides.pptx"), path);
  const result = await previewRemoteDocument(path, null, { home: dir, hubRoot: dir });
  assert.equal(result.status, 200, result.error);
  assert.ok(result.pages >= 2);
});
