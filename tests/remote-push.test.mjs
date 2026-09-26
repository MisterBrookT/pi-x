import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPushSender, encryptPushPayload } from "../src/remote-push.ts";
import { startRemoteHub } from "../src/remote-hub.ts";

const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
// A phone-side subscription and the RFC 8291 decryption a browser performs.
const phone = () => {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); const auth = randomBytes(16);
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  const decrypt = body => {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
    const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const d = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
    d.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
    assert.equal(plain.at(-1), 2, "last-record delimiter");
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { sub, decrypt };
};

test("push payloads decrypt on the phone and carry a valid VAPID signature", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-push-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  const sender = createPushSender(join(dir, "push.json"), { fetch: async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 201 }); } });
  const p = phone();
  await sender.subscribe(p.sub);
  await sender.notify({ title: "workspace", body: "Pi finished", session: "s1" });
  assert.equal(sent.length, 1);
  assert.deepEqual(p.decrypt(Buffer.from(sent[0].init.body)), { title: "workspace", body: "Pi finished", session: "s1" });
  const [, jwt, k] = sent[0].init.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, await sender.publicKey());
  const [h, c, sig] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).aud, "https://push.example");
  const pub = Buffer.from(k, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  assert.equal((await stat(join(dir, "push.json"))).mode & 0o777, 0o600, "keys are private");
});

test("expired phone subscriptions are dropped", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pix-push-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const sender = createPushSender(join(dir, "push.json"), { fetch: async () => new Response(null, { status: 410 }) });
  await sender.subscribe(phone().sub);
  await sender.notify({ title: "x", body: "y" });
  assert.equal(await sender.count(), 0);
});

test("the hub notifies when a turn ends or a background job finishes, without message text", async t => {
  const notes = [];
  const push = { publicKey: async () => "k", count: async () => 1, subscribe: async () => {}, notify: async m => { notes.push(m); } };
  const token = "t".repeat(40);
  const hub = await startRemoteHub({ token, port: 0, push }); t.after(() => hub.close());
  const put = body => fetch(`http://127.0.0.1:${hub.port}/agent/s1`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "s1", name: "workspace", cwd: "/w", ...body }) });
  const job = state => ({ role: "assistant", text: "", background: { id: 3, state, command: "npm test" } });
  await put({ busy: true, messages: [{ role: "user", text: "secret plan" }] });
  await put({ busy: true, messages: [{ role: "user", text: "secret plan" }, job("running")] });
  assert.equal(notes.length, 0, "starting work is not a notification");
  await put({ busy: true, messages: [{ role: "user", text: "secret plan" }, job("failed")] });
  await put({ busy: false, messages: [{ role: "user", text: "secret plan" }, job("failed"), { role: "assistant", text: "secret answer" }] });
  await put({ busy: false, messages: [{ role: "user", text: "secret plan" }, job("failed"), { role: "assistant", text: "secret answer" }] });
  assert.deepEqual(notes.map(n => n.body), ["Job 3 failed", "Pi finished"]);
  assert.ok(notes.every(n => n.session === "s1" && n.title === "workspace"));
  assert.ok(!JSON.stringify(notes).includes("secret"), "no message text in notifications");
});

test("encryption matches the RFC 8291 example byte for byte", () => {
  const as = createECDH("prime256v1"); as.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const out = encryptPushPayload({ endpoint: "https://x", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } }, "When I grow up, I want to be a watermelon", Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), as);
  assert.equal(out.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});
