import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('Pi separately loads the role action and /tool, including after reload', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pix-action-runtime-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const bus = createEventBus();
  for (let reload = 0; reload < 2; reload++) {
    const loaded = await loadExtensions([
      resolve('extensions/upstream-tools.ts'), resolve('extensions/computer.ts'), resolve('extensions/tool.ts'),
    ], process.cwd(), bus);
    t.after(() => loaded.runtime.invalidate());
    assert.deepEqual(loaded.errors, []);
    const tool = loaded.extensions.find(e => e.commands.has('tool')).commands.get('tool');
    let active = ['subagent'];
    loaded.runtime.getAllTools = () => [{ name: 'subagent', description: 'Delegate', parameters: {} }];
    loaded.runtime.getActiveTools = () => active;
    loaded.runtime.setActiveTools = names => { active = names; };
    const completions = tool.getArgumentCompletions('subagent r');
    assert.ok(completions?.some(item => item.value === 'subagent roles'), 'roles must cross Pi extension module boundaries');
    const notices = [];
    const ctx = {
      cwd: process.cwd(), mode: 'tui', hasUI: false,
      ui: {
        notify: (text, level) => notices.push({ text, level }),
        custom: async factory => new Promise(done => {
          const view = factory({ requestRender() {} }, { fg: (_c, text) => text, bold: text => text }, new KeybindingsManager(TUI_KEYBINDINGS), done);
          view.handleInput('\r');
          assert.match(view.render(160).join('\n'), /R roles/);
          view.handleInput('r');
        }),
      },
    };
    await tool.handler('', ctx);
    assert.match(notices.at(-1).text, /role configuration requires/);
    loaded.runtime.getAllTools = () => [{ name: 'computer', description: 'Desktop', parameters: {} }];
    const computerActions = tool.getArgumentCompletions('computer ');
    assert.ok(computerActions.some(item => item.value === 'computer check'));
    assert.ok(computerActions.some(item => item.value === 'computer stop'));
    const beforeReload = [];
    bus.emit('pix:capability-actions:query', { capabilityId: 'subagent', actions: beforeReload });
    assert.equal(beforeReload.length, 1, 'each loaded provider contributes once');
    loaded.runtime.invalidate();
    // Old providers must not leave callbacks behind across /reload.
    const collected = [];
    bus.emit('pix:capability-actions:query', { capabilityId: 'subagent', actions: collected });
    assert.deepEqual(collected, []);
  }
});
