import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setChoice, choice, recordUsage, usage } from '../plugins/pix-anthropic/accountkit.ts';

test('route and usage writes replace whole files without leftover temporary files', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pix-accountkit-'));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  setChoice('own');
  setChoice('auto');
  recordUsage('own', { left: 42 });
  recordUsage('own', { coolUntil: 100 });
  assert.equal(choice(), 'auto');
  assert.equal(await readFile(join(home, 'claude-route'), 'utf8'), 'auto\n');
  assert.equal(usage().own.left, 42);
  assert.equal(usage().own.coolUntil, 100);
  assert.deepEqual((await readdir(home)).sort(), ['accounts-usage.json', 'claude-route']);
});
