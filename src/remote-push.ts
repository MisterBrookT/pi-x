// Web Push from the Mac straight to the phone's push service (Apple, Google, Mozilla).
// Implements VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291) with node:crypto,
// so the relay never sees notifications and no dependency is needed.
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
interface Store { vapid: { publicKey: string; privateKey: string }; subscriptions: PushSubscription[] }

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export function validSubscription(value: any): value is PushSubscription {
  try {
    const url = new URL(value?.endpoint);
    return url.protocol === "https:" && value.endpoint.length < 1000
      && unb64(String(value.keys?.p256dh)).length === 65 && unb64(String(value.keys?.auth)).length === 16;
  } catch { return false; }
}

/** RFC 8291 aes128gcm body for one subscription. */
export function encryptPushPayload(sub: PushSubscription, payload: string, salt = randomBytes(16), server?: ReturnType<typeof createECDH>) {
  if (!server) { server = createECDH("prime256v1"); server.generateKeys(); }
  const uaPublic = unb64(sub.keys.p256dh), auth = unb64(sub.keys.auth), asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, asPublic, body]);
}

function vapidJwt(store: Store, endpoint: string, subject: string) {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const pub = unb64(store.vapid.publicKey);
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: store.vapid.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) }, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64(signature)}`;
}

export function createPushSender(path: string, options: { subject?: string; fetch?: typeof fetch } = {}) {
  let store: Store | undefined;
  const subject = options.subject || "mailto:pix-remote@users.noreply.github.com";
  const send = options.fetch ?? fetch;
  const load = async (): Promise<Store> => {
    if (store) return store;
    if (existsSync(path)) {
      try { store = JSON.parse(await readFile(path, "utf8")); if (store?.vapid?.publicKey) return store; } catch {}
    }
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    store = { vapid: { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) }, subscriptions: [] };
    await save();
    return store;
  };
  const save = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(store), { mode: 0o600 });
    await chmod(path, 0o600);
  };
  return {
    publicKey: async () => (await load()).vapid.publicKey,
    subscribe: async (sub: PushSubscription) => {
      const s = await load();
      s.subscriptions = [...s.subscriptions.filter(x => x.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }].slice(-10);
      await save();
    },
    count: async () => store || existsSync(path) ? (await load()).subscriptions.length : 0,
    /** Send to every phone. Subscriptions the push service reports as gone are removed. */
    notify: async (message: { title: string; body: string; session?: string; tag?: string }, skip: (endpoint: string) => boolean = () => false) => {
      // No phone has subscribed yet: do nothing, and do not create keys on disk.
      if (!store && !existsSync(path)) return;
      const s = await load();
      const payload = JSON.stringify(message);
      let gone = false;
      await Promise.all(s.subscriptions.filter(sub => !skip(sub.endpoint)).map(async sub => {
        try {
          const res = await send(sub.endpoint, {
            method: "POST",
            headers: { authorization: `vapid t=${vapidJwt(s, sub.endpoint, subject)}, k=${s.vapid.publicKey}`, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "3600", urgency: "high", ...(message.tag ? { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}) },
            body: encryptPushPayload(sub, payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 404 || res.status === 410) { s.subscriptions = s.subscriptions.filter(x => x !== sub); gone = true; }
        } catch { /* Offline; the next event tries again. */ }
      }));
      if (gone) await save();
    },
  };
}
export type PushSender = ReturnType<typeof createPushSender>;

