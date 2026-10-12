import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { remoteAppHtml } from '../src/remote-web.ts';

const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
function viewer(api) {
  const { document } = parseHTML('<div id="fileTitle"></div><div id="fileView" hidden></div><div id="fileBody"></div><button id="shareFile" hidden></button>');
  const start = script.indexOf('async function openFile(');
  const end = script.indexOf("$('shareFile').onclick=", start);
  const helpers = script.indexOf('async function renderDocumentPages(');
  const code = (helpers < 0 ? '' : script.slice(helpers, start)) + script.slice(start, end);
  const context = { document, $: id => document.getElementById(id), fileApi: api, fileJob: 1, kbd: false, closeFile: () => true, esc: s => String(s).replaceAll('<', '&lt;'), fetchFileBlob: () => { throw Error('original should not download for preview'); }, fileIcons: {}, fmtSize: String, URL, console };
  return { document, open: runInNewContext(code + ';openFile', context), context };
}

test('PDF and PowerPoint display every page without a native PDF iframe', async () => {
  for (const kind of ['pdf', 'slides']) {
    const calls = [];
    const app = viewer(async (what, path, extra) => {
      calls.push(extra || '');
      if (!extra) return { kind: 'pages', pages: 2 };
      return { mimeType: 'image/jpeg', data: '/9j/AA==' };
    });
    await app.open('/home/demo.' + (kind === 'pdf' ? 'pdf' : 'pptx'), kind);
    assert.equal(app.document.querySelectorAll('.document-page img').length, 2);
    assert.equal(app.document.querySelector('iframe'), null);
    assert.deepEqual(calls, ['', '&page=1', '&page=2']);
    assert.equal(app.document.querySelector('img').alt, `${kind === 'pdf' ? 'Page' : 'Slide'} 1 of 2`);
    assert.equal(app.document.getElementById('shareFile').hidden, false);
  }
});

test('preview failure keeps original download available', async () => {
  const app = viewer(async () => { throw Error('Cannot convert presentation'); });
  await app.open('/home/demo.ppt', 'slides');
  assert.match(app.document.getElementById('fileBody').textContent, /Cannot convert presentation/);
  assert.equal(app.document.getElementById('shareFile').hidden, false);
  assert.equal(app.document.getElementById('shareFile').dataset.path, '/home/demo.ppt');
});

test('failed pages offer a working retry rather than a stuck loading state', async () => {
  let attempts = 0;
  const app = viewer(async (_, __, extra) => {
    if (!extra) return { kind: 'pages', pages: 1 };
    if (++attempts === 1) throw Error('Temporary page failure');
    return { mimeType: 'image/jpeg', data: '/9j/AA==' };
  });
  await app.open('/home/demo.pdf', 'pdf');
  const retry = app.document.querySelector('.document-page button');
  assert.equal(retry.textContent, 'Retry page 1');
  retry.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.document.querySelectorAll('.document-page img').length, 1);
});

test('closing a document during page loading prevents stale pages', async () => {
  let app;
  app = viewer(async (_, __, extra) => {
    if (!extra) return { kind: 'pages', pages: 2 };
    app.context.fileJob++;
    return { mimeType: 'image/jpeg', data: '/9j/AA==' };
  });
  await app.open('/home/demo.pdf', 'pdf');
  assert.equal(app.document.querySelectorAll('.document-page img').length, 0);
});
