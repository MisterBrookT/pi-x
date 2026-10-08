import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { configureHttpDispatcher } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js";
import { bypassProxyForLoopback } from "../src/remote-loopback.ts";

test("hub requests on loopback skip an http_proxy that answers 502 (regression: phone saw no sessions)", async () => {
  const proxy = createServer((_q, r) => { r.writeHead(502); r.end(); });
  const hub = createServer((_q, r) => { r.end("[]"); });
  await new Promise(r => proxy.listen(0, "127.0.0.1", r));
  await new Promise(r => hub.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  try {
    for (const k of ["no_proxy", "NO_PROXY"]) delete process.env[k];
    process.env.http_proxy = process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    configureHttpDispatcher(); // Pi's real global fetch setup; reads NO_PROXY per request
    const url = `http://127.0.0.1:${hub.address().port}/api/sessions`;
    // Like Clash: the proxy refuses loopback, so the hub is unreachable.
    assert.notEqual(await fetch(url).then(r => r.status, () => "failed"), 200);
    bypassProxyForLoopback();
    assert.equal((await fetch(url)).status, 200);
  } finally {
    process.env = saved; proxy.close(); hub.close();
  }
});

test("keeps existing NO_PROXY entries and leaves * alone", () => {
  const env = { NO_PROXY: "corp.local" };
  bypassProxyForLoopback(env);
  assert.equal(env.NO_PROXY, "corp.local,127.0.0.1,localhost,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  const star = { no_proxy: "*" };
  bypassProxyForLoopback(star);
  assert.deepEqual(star, { no_proxy: "*" });
});
