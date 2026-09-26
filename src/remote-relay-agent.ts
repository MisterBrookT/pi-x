import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readRemoteToken } from "./remote-hub.ts";

/** Largest phone request body: text plus one resized photo (see remote-web image target). */
export const relayRequestLimit = 1_300_000;
/** Cloudflare Worker frame cap in relay/src/index.ts. */
export const relayFrameLimit = 2_000_000;
export const relayKeyPath = join(homedir(), ".pi", "agent", "pix-remote", "relay-key");
export const relayConfigPath = join(homedir(), ".pi", "agent", "pix-remote", "relay.json");

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
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: iv.toString("base64url"), data: data.toString("base64url") });
};
export const openRelayFrame = (secret: string, frame: string): any => {
  const value = JSON.parse(frame);
  const iv = Buffer.from(value.iv, "base64url");
  const data = Buffer.from(value.data, "base64url");
  if (iv.length !== 12 || data.length < 16 || data.length > 2_000_000) throw Error("Invalid encrypted frame");
  const decipher = createDecipheriv("aes-256-gcm", digest("key:", secret), iv);
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8"));
};

const allowed = (path: string, method: string) => method === "GET" && (path === "/api/sessions" || /^\/api\/sessions\/[a-zA-Z0-9_-]+$/.test(path) || /^\/api\/sessions\/[a-zA-Z0-9_-]+\/media\/[a-f0-9]{64}$/.test(path)) || method === "POST" && /^\/api\/sessions\/[a-zA-Z0-9_-]+\/(prompt|abort|action)$/.test(path);

export function startRemoteRelayAgent(options: { origin: string; secret: string; localBase: string; localToken: string; onState?: (state: string) => void }) {
  const { origin, secret, localBase, localToken } = options;
  const parsed = new URL(origin);
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw Error("Pix Remote relay must be an HTTPS origin (or loopback for tests)");
  let running = true, socket: WebSocket | undefined, stream: AbortController | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
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
  const publishSessions = async () => {
    const res = await local("/api/sessions");
    if (!res.ok) return;
    const sessions = await res.json() as { id: string }[];
    send({ kind: "event", event: "sessions", data: sessions });
    for (const { id } of sessions) {
      const one = await local(`/api/sessions/${encodeURIComponent(id)}`);
      if (one.ok) send({ kind: "event", event: "session", data: await one.json() });
    }
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
          const type = block.match(/^event: (sessions|session)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (type && data) { try { send({ kind: "event", event: type, data: JSON.parse(data) }); } catch {} }
        }
        if (buffer.length > 2_000_000) buffer = "";
      }
    } catch { /* Local stream is cancelled on disconnect. */ }
  };
  const connect = () => {
    if (!running) return;
    const url = origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "") + `/socket/${relayRoom(secret)}/agent`;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { connected = true; clearTimeout(readyTimer); resolveReady(); options.onState?.("connected"); stream = new AbortController(); void listen(stream); });
    socket.addEventListener("message", async (event) => {
      try {
        const message = openRelayFrame(secret, String(event.data));
        if (message.kind === "hello") { await publishSessions(); return; }
        if (message.kind !== "request" || typeof message.id !== "string" || message.id.length > 100 || !allowed(message.path, message.method) || typeof message.body !== "string") return;
        if (message.body.length > relayRequestLimit) { send({ kind: "response", id: message.id, status: 413, error: "Message and image are too large to send" }); return; }
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
    socket.addEventListener("close", () => { options.onState?.("closed"); stream?.abort(); if (running) retry = setTimeout(connect, 1_500); });
    const current = socket;
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
