import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
const execute = promisify(execFile);

test('phone opens every PDF/PPT/PPTX page and closes its enlarged preview by tap', { timeout: 120000 }, async t => {
  if (!existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice')) return t.skip('Real presentation journey requires LibreOffice');
  const result = await execute(process.execPath, ['scripts/verify-document-ui.mjs'], {
    env: { ...process.env, PIX_DOCUMENT_RELAY: '' }, timeout: 110000, maxBuffer: 1000000,
  });
  assert.match(result.stdout, /Evidence:/);
});
