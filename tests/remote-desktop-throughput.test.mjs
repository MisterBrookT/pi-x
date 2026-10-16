import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createDesktopBroker } from '../plugins/desktop/remote-desktop.ts';
import { sealRelayFrame } from '../plugins/remote/remote-relay-agent.ts';

test('desktop batches queued screen bytes into 512 KiB reads without enlarging input writes', async t => {
  const payload = Buffer.alloc(640 * 1024);
  let seed = 123456;
  for (let i = 0; i < payload.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; payload[i] = seed & 255; }
  let peer;
  const server = createServer(s => { peer = s; s.on('error', () => {}); s.write(payload); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { peer?.destroy(); server.close(); });
  let received = 0, complete;
  const ready = new Promise(r => { complete = r; });
  const broker = createDesktopBroker({ connect: () => {
    const socket = connect(server.address().port, '127.0.0.1');
    socket.on('data', b => { received += b.length; if (received === payload.length) complete(); });
    return socket;
  } });
  t.after(() => broker.dispose());
  const { id } = broker.open().body;
  await ready;
  const first = await broker.read(id, 0);
  const chunk = Buffer.from(first.body.data, 'base64');
  assert.equal(chunk.length, 512 * 1024, 'one RTT should carry eight old chunks');
  assert.deepEqual((await broker.read(id, 0)).body, first.body, 'retry remains byte-identical');
  const rest = Buffer.from((await broker.read(id, 1)).body.data, 'base64');
  assert.deepEqual(Buffer.concat([chunk, rest]), payload);
  assert.ok(Buffer.byteLength(sealRelayFrame('fixture-key-not-real', { kind: 'response', id: 'test', status: 200, body: first.body })) < 2 * 1024 * 1024, 'encrypted/base64 frame stays below relay limit');
  assert.equal(broker.write(id, { seq: 0, data: Buffer.alloc(64 * 1024 + 1).toString('base64') }).status, 400, 'input chunks keep the smaller limit');
});
