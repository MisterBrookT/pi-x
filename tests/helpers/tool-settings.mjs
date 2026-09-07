import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolSettings } from '../../src/tool-settings.ts';
const stores = new WeakMap();
const dirs = [];
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive:true, force:true }); });
export function settingsFor(session) {
 if (!stores.has(session)) {
  const directory=mkdtempSync(join(tmpdir(),'pix-settings-test-')); dirs.push(directory);
  stores.set(session, toolSettings(directory));
 }
 return stores.get(session);
}
