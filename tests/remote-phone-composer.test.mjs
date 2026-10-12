import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { remoteAppHtml } from '../src/remote-web.ts';

const html = remoteAppHtml;
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const line = prefix => script.split('\n').find(s => s.startsWith(prefix)) ?? assert.fail(prefix);

test('phone loads five turns, keeps full history on refresh, and uses muted status', () => {
  assert.match(line('async function open(id,'), /\?tail=5/);
  assert.match(script, /expandedSession===s.id&&current\?\.id===s.id/);
  assert.match(script, /expandedSession===p.id/);
  assert.match(html, /\.composer-status\{[^}]*color:var\(--muted\)/);
  for (const status of ['Answered', 'Compacting…', 'Preparing image…', 'Reopening session in '])
    assert.doesNotMatch(script, new RegExp(`composerStatus\\([^\\n]*${status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('expanded session retains its prefix and accepts the next patch', () => {
  const listeners = new Map();
  class EventSource {
    constructor() { this.listeners = listeners; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
  }
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, classList: { remove() {}, add() {} }, setAttribute() {} });
    return nodes.get(id);
  };
  const app = runInNewContext(`
    let token='test', events, paired=false, active='a', current={id:'a',older:0,messages:[{id:'old'},{id:'first'},{id:'last'}]},expandedSession='a';
    let sessions=[],pendingNew=null,missingSince=0;
    ${script.slice(script.indexOf('function connect(){'), script.indexOf('// Pins are a per-device'))}
    ({snapshot:()=>current, expanded:()=>expandedSession, connect})
  `, {
    EventSource, $, fromCache() {}, nearBottom: () => true, renderChat() {},
    renderList() {}, open() { throw Error('unexpected full reload'); },
    api() { throw Error('unexpected API call'); }, encodeURIComponent,
  });
  app.connect();
  const emit = (name, data) => listeners.get(name)({ data: JSON.stringify(data) });
  emit('session', { id: 'a', older: 1, messages: [{ id: 'first' }, { id: 'last' }] });
  assert.deepEqual(Array.from(app.snapshot().messages, m => m.id), ['old', 'first', 'last']);
  assert.equal(app.snapshot().older, 0, 'retained prefix means no earlier messages remain');
  emit('sessionPatch', { id: 'a', base: 3, keep: 3, tail: [{ id: 'next' }] });
  assert.deepEqual(Array.from(app.snapshot().messages, m => m.id), ['old', 'first', 'last', 'next']);
  assert.equal(app.snapshot().older, 0);
  // Regression: a closed question is omitted from the JSON patch and must not linger on the phone.
  emit('sessionPatch', { id: 'a', base: 4, keep: 4, tail: [], question: { id: 'q', question: 'Q?', options: [] } });
  assert.equal(app.snapshot().question?.id, 'q');
  emit('sessionPatch', { id: 'a', base: 4, keep: 4, tail: [] });
  assert.equal(app.snapshot().question, undefined);
});

test('optimistic prompts appear immediately and reconcile once, without losing failures', () => {
    const code = [line('const esc='), line('function reconcilePrompts('), line('function promptRows(')].join('\n');
  const app = runInNewContext(`let pendingPrompts=[];const acknowledgedPrompts=new Set();${code};({add:p=>pendingPrompts.push(p),reconcilePrompts,promptRows})`);
  const p = { id: 1, session: 'a', text: '<steer>', known: new Set(['old']), failed: false };
  app.add(p);
  assert.match(app.promptRows({ id: 'a', messages: [] }), /&lt;steer&gt;/);
  assert.equal(app.promptRows({ id: 'b', messages: [] }), '');
  p.failed = true;
  assert.match(app.promptRows({ id: 'a', messages: [] }), /Could not send/);
  const snapshot = { id: 'a', messages: [{ id: 'old', role: 'user', text: '<steer>' }, { id: 'new', role: 'user', text: '<steer>' }] };
  assert.equal(app.promptRows(snapshot), '');
  app.add({ ...p, id: 2, known: new Set(['old']), failed: false });
  assert.match(app.promptRows(snapshot), /pending-2/, 'already acknowledged message cannot consume another prompt');
});
