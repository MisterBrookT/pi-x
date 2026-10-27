import { deflateRawSync, inflateRawSync } from "node:zlib";
import { markPhoneActive, markPhoneGone, phoneUse } from "./privacy-cover.ts";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { readRemoteToken, tailSession } from "./remote-hub.ts";
import { pluginRelayAllowed } from "../core/hub-plugin.ts";

/** Turns (user messages and everything after) a phone gets per session at first; older ones load on request. */
export const relayTail = 5;

/** Largest phone request body: text plus one resized photo (see remote-web image target). */
export const relayRequestLimit = 1_300_000;
/** Cloudflare Worker frame cap in relay/src/index.ts. */
export const relayFrameLimit = 2_000_000;
export const relayKeyPath = join(homedir(), ".pi", "agent", "pix-remote", "relay-key");
export { relayConfigPath } from "../core/hub-paths.ts";
import { relayConfigPath } from "../core/hub-paths.ts";

/** No shared relay is bundled with Pix. A self-hosted origin is an explicit local choice. */
export async function readRelayOrigin(path = relayConfigPath): Promise<string> {
  if (process.env.PIX_REMOTE_RELAY_URL !== undefined) return process.env.PIX_REMOTE_RELAY_URL;
  let config: string;
  try { config = await readFile(path, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; }
  const origin = JSON.parse(config)?.origin;
  if (typeof origin !== "string") throw Error("Pix Remote relay.json needs an HTTPS origin");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Pix Remote relay.json needs an HTTPS origin");
  return url.origin;
}
const digest = (prefix: string, secret: string) => createHash("sha256").update(prefix + secret).digest();
export const relayRoom = (secret: string) => digest("room:", secret).toString("hex");
export const sealRelayFrame = (secret: string, value: unknown) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", digest("key:", secret), iv);
  // Compress before encrypting (ciphertext does not compress): chat JSON shrinks ~4x on the phone link.
  const data = Buffer.concat([cipher.update(deflateRawSync(JSON.stringify(value))), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: iv.toString("base64url"), z: 1, data: data.toString("base64url") });
};
export const openRelayFrame = (secret: string, frame: string): any => {
  const value = JSON.parse(frame);
  const iv = Buffer.from(value.iv, "base64url");
  const data = Buffer.from(value.data, "base64url");
  if (iv.length !== 12 || data.length < 16 || data.length > 2_000_000) throw Error("Invalid encrypted frame");
  const decipher = createDecipheriv("aes-256-gcm", digest("key:", secret), iv);
  decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return JSON.parse((value.z === 1 ? inflateRawSync(plain, { maxOutputLength: 20_000_000 }) : plain).toString("utf8"));
};

export const relayAllowed = (url: string, method: string) => { const path = String(url).split("?")[0]; return path === "/api/push" && (method === "GET" || method === "POST") || path === "/api/here" && method === "GET" || method === "GET" && (path === "/api/sessions" || /^\/api\/sessions\/[a-zA-Z0-9_-]+$/.test(path) || /^\/api\/sessions\/[a-zA-Z0-9_-]+\/media\/[a-f0-9]{64}$/.test(path) || /^\/api\/sessions\/[a-zA-Z0-9_-]+\/(files|file|file\/preview|file\/thumb|file\/source)$/.test(path)) || method === "POST" && /^\/api\/sessions\/[a-zA-Z0-9_-]+\/(prompt|abort|action|file\/save|file\/create|file\/image|file\/upload)$/.test(path)
  || pluginRelayAllowed(path, method)
  || method === "GET" && (path === "/api/folders" || path === "/api/links" || path === "/api/past" || path === "/api/memory" || path === "/api/memory/file") || method === "POST" && (path === "/api/launch" || path === "/api/resume")
  || method === "POST" && path === "/api/desktop/open" || method === "GET" && /^\/api\/desktop\/[A-Za-z0-9_-]{24}\/read$/.test(path) || method === "POST" && /^\/api\/desktop\/[A-Za-z0-9_-]{24}\/(write|close|input)$/.test(path)
  || (method === "GET" || method === "POST") && desktopCredentialPath.test(path) || method === "DELETE" && path === "/api/desktop/credentials"; };
const desktopCredentialPath = /^\/api\/desktop\/[A-Za-z0-9_-]{24}\/credentials$/;
/** Credential replies must not linger in the request dedup cache; those operations are idempotent anyway. */
const uncachedRelayPath = (url: string) => { const path = String(url).split("?")[0]; return path === "/api/desktop/credentials" || desktopCredentialPath.test(path); };

/** Which way the relay socket goes. Two failures in a row on one route switch to the other; success keeps it. */
export function relayRouter(start: "proxy" | "direct" = process.env.https_proxy || process.env.HTTPS_PROXY ? "proxy" : "direct") {
  let route = start, fails = 0;
  return {
    pick: () => route,
    ok: () => { fails = 0; },
    fail: () => { if (++fails >= 2) { route = route === "proxy" ? "direct" : "proxy"; fails = 0; } },
  };
}
// Pi sends fetch/WebSocket through the proxy (undici's global dispatcher). A direct socket needs undici's own WebSocket with a
// plain Agent: Node's built-in WebSocket ignores a dispatcher from another undici copy.
let undici: any, agent: unknown;
const directSocket = (url: string): WebSocket => { undici ??= createRequire(import.meta.url)("undici"); agent ??= new undici.Agent(); return new undici.WebSocket(url, { dispatcher: agent }); };
export function startRemoteRelayAgent(options: { origin: string; secret: string; localBase: string; localToken: string; onState?: (state: string) => void; heartbeatMs?: number; router?: ReturnType<typeof relayRouter> }) {
  const { origin, secret, localBase, localToken } = options;
  const relayRoute = options.router ?? relayRouter();
  const parsed = new URL(origin);
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw Error("Pix Remote relay must be an HTTPS origin (or loopback for tests)");
  let running = true, socket: WebSocket | undefined, stream: AbortController | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  const beatMs = options.heartbeatMs ?? 15_000;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => { if (!connected) rejectReady(Error("Could not reach the Pix Remote relay. Check your Mac's network.")); }, 10_000);
  // Cache completed/in-flight request IDs: a replay must never submit a prompt twice.
  const requests = new Map<string, Promise<unknown>>();
  const send = (message: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(sealRelayFrame(secret, message)); };
  const local = async (path: string, method = "GET", body?: string) => fetch(localBase + path, {
    method, body: method === "POST" ? body : undefined,
    headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  // On hello: the list, plugin events (For you…), and only the session the phone shows (its tail). Others load on open,
  // so a reconnect costs tens of KB instead of every transcript. Older phones send no `active`: all, tailed.
  const publishSessions = async (active?: string) => {
    // Fetch everything at once, and send the session the phone shows first: it is what Brook is looking at.
    const json = async (path: string) => { try { const r = await local(path); return r.ok ? await r.json() : undefined; } catch { return undefined; } };
    const one = (id: string) => json(`/api/sessions/${encodeURIComponent(id)}?tail=${relayTail}`);
    const [sessions, extras, shown] = await Promise.all([json("/api/sessions") as Promise<{ id: string }[] | undefined>, json("/api/extras") as Promise<[string, unknown][] | undefined>, active ? one(active) : undefined]);
    if (!sessions) return;
    send({ kind: "event", event: "sessions", data: sessions });
    if (shown && sessions.some(s => s.id === active)) send({ kind: "event", event: "session", data: shown });
    for (const [event, data] of extras ?? []) send({ kind: "event", event, data });
    if (typeof active !== "string") for (const s of await Promise.all(sessions.map(s => one(s.id)))) if (s) send({ kind: "event", event: "session", data: s });
  };
  const listen = async (controller: AbortController) => {
    try {
      const res = await fetch(localBase + `/api/events?token=${encodeURIComponent(localToken)}`, { signal: controller.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = block.match(/^event: ([\w-]+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (type && data) { try { const value = JSON.parse(data); send({ kind: "event", event: type, data: type === "session" ? tailSession(value, relayTail) : value }); } catch {} }
        }
        if (buffer.length > 2_000_000) buffer = "";
      }
    } catch { /* Local stream is cancelled on disconnect. */ }
  };
  const connect = () => {
    if (!running) return;
    const url = origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "") + `/socket/${relayRoom(secret)}/agent`;
    // Route: through the system proxy (Clash) or straight out. When one keeps failing, try the other, so a broken proxy
    // (10-26: the Clash line to brooktang.fun was down for 2 h) cannot cut brook off from his Mac.
    const route = relayRoute.pick();
    socket = route === "direct" ? directSocket(url) : new WebSocket(url);
    options.onState?.(`route ${route}`);
    // A socket that never opened, or dropped within a minute, counts against its route.
    let openedAt = 0;
    socket.addEventListener("open", () => { openedAt = Date.now(); });
    socket.addEventListener("close", () => { if (!openedAt || Date.now() - openedAt < 60_000) relayRoute.fail(); else relayRoute.ok(); });
    let heartbeat: ReturnType<typeof setInterval> | undefined, lastPong = Date.now();
    const current = socket;
    // After sleep or a network change the socket can look open while the relay has dropped it.
    // The relay answers "ping" itself; no answer within 45 s means reconnect.
    socket.addEventListener("open", () => { lastPong = Date.now(); heartbeat = setInterval(() => {
      // close() waits for the relay's close reply, which a dead link never sends: abandon it and reconnect now.
      if (Date.now() - lastPong > beatMs * 3) { options.onState?.("stale"); abandon(); return; }
      try { current.send("ping"); } catch {}
    }, beatMs); });
    socket.addEventListener("close", () => clearInterval(heartbeat));
    socket.addEventListener("open", () => { connected = true; clearTimeout(readyTimer); resolveReady(); options.onState?.("connected"); stream = new AbortController(); void listen(stream); });
    socket.addEventListener("message", async (event) => {
      try {
        if (event.data === "pong") { lastPong = Date.now(); return; }
        const message = openRelayFrame(secret, String(event.data));
        if (message.kind === "hello") { await publishSessions(typeof message.active === "string" ? message.active : undefined); return; }
        if (message.kind !== "request" || typeof message.id !== "string" || message.id.length > 100 || typeof message.body !== "string") return;
        { const use = phoneUse(message.path, String(message.method), message.body); if (use === "gone") markPhoneGone(); else if (use === "here") markPhoneActive(); }
        // Answer instead of staying silent, so an older Mac shows "reload Pi" rather than a timeout.
        if (!relayAllowed(message.path, message.method)) { send({ kind: "response", id: message.id, status: 404, error: "This Mac's Pix is older than the phone. Reload Pi on the Mac." }); return; }
        if (message.body.length > relayRequestLimit) { send({ kind: "response", id: message.id, status: 413, error: "Message and image are too large to send" }); return; }
        if (uncachedRelayPath(message.path)) {
          let reply;
          try {
            const response = await local(message.path, message.method, message.body);
            const body = await response.json() as { error?: string };
            reply = { kind: "response", id: message.id, status: response.status, body, error: response.ok ? undefined : body.error };
          } catch { reply = { kind: "response", id: message.id, status: 503, error: "Mac hub unavailable" }; }
          send(reply); return;
        }
        if (!requests.has(message.id)) {
          requests.set(message.id, (async () => {
            try {
              const response = await local(message.path, message.method, message.body);
              const body = await response.json() as { error?: string };
              return { kind: "response", id: message.id, status: response.status, body, error: response.ok ? undefined : body.error };
            } catch { return { kind: "response", id: message.id, status: 503, error: "Mac hub unavailable" }; }
          })());
          if (requests.size > 256) requests.delete(requests.keys().next().value!);
        }
        send(await requests.get(message.id));
      } catch { /* Never act on unauthenticated or malformed frames. */ }
    });
    let ended = false;
    const ended1 = (delay: number) => { if (ended) return; ended = true; clearInterval(heartbeat); options.onState?.("closed"); stream?.abort(); if (running && socket === current) retry = setTimeout(connect, delay); };
    const abandon = () => { relayRoute.fail(); ended1(0); try { (current as any).terminate?.() ?? current.close(); } catch {} };
    socket.addEventListener("close", () => ended1(1_500));
    socket.addEventListener("error", () => { options.onState?.("error"); current?.close(); });
  };
  connect();
  return { ready, stop: () => { running = false; clearTimeout(readyTimer); clearTimeout(retry); stream?.abort(); socket?.close(); } };
}

export async function readRelayKey(path = relayKeyPath) { return readRemoteToken(path); }

/** Replace the pairing secret atomically; previously scanned phones can no longer reconnect. */
export async function rotateRelayKey(path = relayKeyPath) {
  const key = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, key + "\n", { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return key;
}
