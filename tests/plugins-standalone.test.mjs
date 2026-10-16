// Each plugin can be switched off in `pi config`: every listed extension must load on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEventBus } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

const listed = JSON.parse(readFileSync('package.json', 'utf8')).pi.extensions;

test('every plugin loads alone, without the others', async t => {
	const agentDir = mkdtempSync(join(tmpdir(), 'pix-standalone-'));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	for (const path of listed) {
		const loaded = await loadExtensions([resolve(path)], process.cwd(), createEventBus());
		loaded.runtime.invalidate?.();
		assert.deepEqual(loaded.errors.map(e => e.error), [], path);
		assert.equal(loaded.extensions.length, 1, path);
	}
});
