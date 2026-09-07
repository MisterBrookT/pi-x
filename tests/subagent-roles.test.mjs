import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { configureSubagentRoles, roleSummary } = await jiti.import('../src/subagent-roles.ts');
const { discoverAgents } = await jiti.import('../node_modules/pi-subagents/src/agents/agents.ts');

function fixture(t, choices, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pix-roles-'));
  const home = join(root, 'agent'), cwd = join(root, 'project');
  mkdirSync(home); mkdirSync(join(cwd, '.pi'), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const settingsPath = join(home, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ unrelated: true, subagents: { agentOverrides: {
    worker: { model: 'test/old', thinking: 'high', tools: ['read'], fallbackModels: ['test/fallback'] },
  } } }));
  const notices = [], prompts = [];
  const ctx = {
    cwd, hasUI: true, mode: 'tui', scopedModels: [], model: { provider: 'test', id: 'parent' },
    isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [{ provider: 'test', id: 'new' }] },
    ui: {
      notify: (text, level) => notices.push({ text, level }),
      select: async (title, items) => {
        prompts.push({ title, items });
        const choice = choices.shift();
        if (choice === undefined) return undefined;
        const selected = items.find(item => item === choice || item.startsWith(choice + ' ·'));
        assert.ok(selected, `${choice} not in ${items}`);
        return selected;
      },
    },
    ...options,
  };
  return { ctx, cwd, settingsPath, notices, prompts, read: () => JSON.parse(readFileSync(settingsPath, 'utf8')) };
}

test('role picker exposes only worker and scout even when upstream has more roles', async t => {
  const f = fixture(t, []);
  assert.ok(discoverAgents(f.cwd, 'both', 'test').agents.some(a => a.name === 'reviewer'));
  await configureSubagentRoles(f.ctx);
  assert.deepEqual(f.prompts[0].items.map(label => label.split(' ·')[0]).sort(), ['scout', 'worker']);
});

test('model choice persists through upstream discovery and preserves unrelated role settings', async t => {
  const f = fixture(t, ['worker', 'Model', 'test/new']);
  await configureSubagentRoles(f.ctx);
  const settings = f.read();
  assert.equal(settings.unrelated, true);
  assert.deepEqual(settings.subagents.agentOverrides.worker, {
    model: 'test/new', thinking: 'high', tools: ['read'], fallbackModels: ['test/fallback'],
  });
  assert.equal(discoverAgents(f.cwd, 'both', 'test').agents.find(a => a.name === 'worker').model, 'test/new');
  assert.match(f.notices[0].text, /Applies to new children/);
  assert.match(f.prompts.at(-1).items.find(s => s.startsWith('worker ·')), /test\/new/);
});

test('effort persists without changing the role model', async t => {
  const f = fixture(t, ['worker', 'Effort', 'minimal']);
  await configureSubagentRoles(f.ctx);
  const resolved = discoverAgents(f.cwd, 'both', 'test').agents.find(a => a.name === 'worker');
  assert.equal(resolved.thinking, 'minimal');
  assert.equal(resolved.model, 'test/old');
});

test('off effort stays off rather than becoming inherited thinking', async t => {
  const f = fixture(t, ['worker', 'Effort', 'off']);
  await configureSubagentRoles(f.ctx);
  assert.equal(discoverAgents(f.cwd, 'both', 'test').agents.find(a => a.name === 'worker').thinking, 'off');
});

test('fallback editing preserves the primary model and respects scoped models', async t => {
  const f = fixture(t, ['worker', 'Fallback', 'test/scoped', 'low'], { scopedModels: [{ model: { provider: 'test', id: 'scoped' } }] });
  await configureSubagentRoles(f.ctx);
  assert.deepEqual(f.read().subagents.agentOverrides.worker.fallbackModels, ['test/scoped:low']);
  assert.equal(f.read().subagents.agentOverrides.worker.model, 'test/old');
  assert.ok(!f.prompts.find(p => p.title.includes('fallback ·')).items.includes('test/new'));
});

test('default effort removes only the user effort override', async t => {
  const f = fixture(t, ['worker', 'Effort', 'Default']);
  await configureSubagentRoles(f.ctx);
  assert.equal(f.read().subagents.agentOverrides.worker.thinking, undefined);
  assert.equal(f.read().subagents.agentOverrides.worker.model, 'test/old');
});

test('inherit explicitly restores parent model selection', async t => {
  const f = fixture(t, ['worker', 'Model', 'Inherit parent model']);
  await configureSubagentRoles(f.ctx);
  assert.equal(f.read().subagents.agentOverrides.worker.model, 'inherit');
  assert.match(roleSummary({ name: 'worker', model: 'inherit', thinking: false }), /parent model · parent effort/);
});

test('cancelling model selection does not write settings', async t => {
  const f = fixture(t, ['worker', 'Model']);
  const before = readFileSync(f.settingsPath, 'utf8');
  await configureSubagentRoles(f.ctx);
  assert.equal(readFileSync(f.settingsPath, 'utf8'), before);
  assert.equal(f.notices.length, 0);
});

test('headless and untrusted contexts do not open pickers or read project roles', async t => {
  const f = fixture(t, [], { hasUI: false });
  await configureSubagentRoles(f.ctx);
  await configureSubagentRoles({ ...f.ctx, hasUI: true, isProjectTrusted: () => false });
  assert.equal(f.prompts.length, 0);
  assert.equal(f.notices.length, 2);
  assert.ok(f.notices.every(n => n.level === 'error'));
});
