// Phone VNC over the encrypted relay: HTTP JSON polling bridged to the Mac's own Screen Sharing
// (127.0.0.1:5900). The destination is fixed here; phones only open, read, write, and close.
//
// Protocol (all bodies JSON, bytes base64):
//   POST /api/desktop/open             -> { id }
//   GET  /api/desktop/:id/read?seq=N   -> { seq: N, data, closed }  (long poll)
//     Read N returns the next chunk; asking for N again replays the same bytes (a lost HTTP reply is
//     retried safely). Ask N+1 only after N delivered non-empty data. Empty data does not use up N.
//   POST /api/desktop/:id/write { seq, data } -> { ack }  (ack = next expected seq)
//     seq below the expected one is a duplicate and ignored; a gap is refused with 409.
//   POST /api/desktop/:id/close        -> { ok }
import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";

export const desktopHost = "127.0.0.1";
export const desktopPort = 5900;
export const desktopChunkLimit = 64 * 1024;
// Screen updates are much larger than input. Batch them to avoid a relay round trip per 64 KiB.
// 512 KiB still fits below the relay's 2 MiB frame limit after both base64 layers and encryption.
export const desktopReadChunkLimit = 512 * 1024;
export const desktopQueueLimit = 4 * 1024 * 1024;
export const desktopMaxSessions = 2;
export const desktopIdleMs = 60_000;
/** Below the relay agent's 15 s local fetch timeout. */
export const desktopPollMs = 10_000;
export const desktopIdPattern = "[A-Za-z0-9_-]{24}";

export interface DesktopResult { status: number; body: Record<string, unknown> }

interface DesktopSession {
  socket: Socket;
  queue: Buffer[];
  queued: number;
  closed: boolean;
  lastActive: number;
  nextRead: number;
  delivered?: { seq: number; data: string };
  nextWrite: number;
  reader?: () => void;
}

export interface DesktopBrokerOptions {
  /** Tests only: replaces the fixed 127.0.0.1:5900 connection. */
  connect?: () => Socket;
  idleMs?: number;
  pollMs?: number;
  maxSessions?: number;
  queueLimit?: number;
}

const strictBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const seqOf = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function createDesktopBroker(options: DesktopBrokerOptions = {}) {
  const connect = options.connect ?? (() => netConnect(desktopPort, desktopHost));
  const idleMs = options.idleMs ?? desktopIdleMs, pollMs = options.pollMs ?? desktopPollMs;
  const maxSessions = options.maxSessions ?? desktopMaxSessions, queueLimit = options.queueLimit ?? desktopQueueLimit;
  const sessions = new Map<string, DesktopSession>();

  const wake = (s: DesktopSession) => { const r = s.reader; s.reader = undefined; r?.(); };
  const dispose = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.closed = true; s.queue = []; s.queued = 0; s.delivered = undefined;
    s.socket.destroy();
    wake(s);
  };
  const sweep = setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.lastActive > idleMs) dispose(id); }, Math.min(5_000, idleMs));
  sweep.unref();

  const live = (id: string) => { const s = sessions.get(id); if (s) s.lastActive = Date.now(); return s; };
  const gone: DesktopResult = { status: 404, body: { error: "desktop session ended" } };

  return {
    get size() { return sessions.size; },
    /** Open and its Screen Sharing connection still up. */
    has(id: string) { const s = sessions.get(id); return !!s && !s.closed; },
    open(): DesktopResult {
      if (sessions.size >= maxSessions) return { status: 429, body: { error: "too many desktop sessions" } };
      const id = randomBytes(18).toString("base64url");
      const socket = connect();
      const s: DesktopSession = { socket, queue: [], queued: 0, closed: false, lastActive: Date.now(), nextRead: 0, nextWrite: 0 };
      sessions.set(id, s);
      socket.on("data", (chunk: Buffer) => {
        if (s.closed) return;
        s.queue.push(chunk); s.queued += chunk.length;
        // Bounded: stop reading from VNC until the phone catches up.
        if (s.queued >= queueLimit) socket.pause();
        wake(s);
      });
      const end = () => { s.closed = true; wake(s); };
      socket.on("end", end); socket.on("close", end); socket.on("error", end);
      return { status: 200, body: { id } };
    },
    async read(id: string, seqInput: unknown): Promise<DesktopResult> {
      const seq = seqOf(typeof seqInput === "string" && /^\d{1,15}$/.test(seqInput) ? Number(seqInput) : seqInput);
      const s = live(id);
      if (!s) return gone;
      if (seq === undefined) return { status: 400, body: { error: "invalid seq" } };
      if (s.delivered && seq === s.delivered.seq) return { status: 200, body: { seq, data: s.delivered.data, closed: s.closed && !s.queue.length } };
      if (seq !== s.nextRead) return { status: 409, body: { error: "read out of order", expected: s.nextRead } };
      if (!s.queue.length && !s.closed) {
        // One pending read: a newer poll (an HTTP retry) supersedes the old one, which returns empty.
        wake(s);
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { if (s.reader === done) s.reader = undefined; resolve(); }, pollMs);
          const done = () => { clearTimeout(timer); resolve(); };
          s.reader = done;
        });
        if (sessions.get(id) !== s) return gone;
        // Superseded or out of turn by now: give back nothing so no bytes are consumed here.
        if (seq !== s.nextRead) return { status: 200, body: { seq, data: "", closed: s.closed } };
      }
      s.lastActive = Date.now();
      if (!s.queue.length) return { status: 200, body: { seq, data: "", closed: s.closed } };
      const parts: Buffer[] = []; let size = 0;
      while (s.queue.length && size < desktopReadChunkLimit) {
        const head = s.queue[0], take = Math.min(head.length, desktopReadChunkLimit - size);
        parts.push(head.subarray(0, take)); size += take;
        if (take === head.length) s.queue.shift(); else s.queue[0] = head.subarray(take);
      }
      s.queued -= size;
      if (s.queued < queueLimit && !s.closed) s.socket.resume();
      const data = Buffer.concat(parts).toString("base64");
      s.delivered = { seq, data }; s.nextRead = seq + 1;
      return { status: 200, body: { seq, data, closed: s.closed && !s.queue.length } };
    },
    write(id: string, input: unknown): DesktopResult {
      const s = live(id);
      if (!s) return gone;
      const value = input && typeof input === "object" ? input as { seq?: unknown; data?: unknown } : {};
      const seq = seqOf(value.seq), data = value.data;
      if (seq === undefined || typeof data !== "string" || data.length > Math.ceil(desktopChunkLimit / 3) * 4 || !strictBase64.test(data)) return { status: 400, body: { error: "invalid write" } };
      if (seq < s.nextWrite) return { status: 200, body: { ack: s.nextWrite, duplicate: true } };
      if (seq > s.nextWrite) return { status: 409, body: { error: "write out of order", expected: s.nextWrite } };
      if (s.closed) return { status: 410, body: { error: "desktop connection closed" } };
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > desktopChunkLimit) return { status: 400, body: { error: "invalid write" } };
      // Not acked when the Mac side is backed up: the phone retries the same seq later.
      if (s.socket.writableLength + bytes.length > queueLimit) return { status: 503, body: { error: "desktop busy" } };
      s.socket.write(bytes);
      s.nextWrite = seq + 1;
      return { status: 200, body: { ack: s.nextWrite } };
    },
    close(id: string): DesktopResult { dispose(id); return { status: 200, body: { ok: true } }; },
    dispose() { clearInterval(sweep); for (const id of [...sessions.keys()]) dispose(id); },
  };
}

export type DesktopBroker = ReturnType<typeof createDesktopBroker>;
