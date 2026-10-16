import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { remoteRelayWebScript } from '../plugins/remote/remote-relay-web.ts';

test('document conversion has a longer relay deadline; ordinary requests keep the short deadline', async () => {
  const code = remoteRelayWebScript.slice(remoteRelayWebScript.indexOf('function relayApi('), remoteRelayWebScript.indexOf('function relayConnect('));
  const deadlines = [];
  const pending = new Map();
  const api = runInNewContext(code + ';relayApi', {
    relayWaitOnline: async () => true,
    crypto: { randomUUID: () => String(deadlines.length) },
    relayPending: pending,
    setTimeout: (_, ms) => { deadlines.push(ms); return ms; },
    relaySeal: async frame => frame,
    relaySocket: { send: frame => { pending.get(frame.id).resolve({ ok: true }); } },
  });
  await api('/api/sessions/demo/file/preview?path=test.pptx');
  await api('/api/sessions/demo/file?path=test.pptx');
  assert.deepEqual(deadlines, [120000, 15000]);
});
