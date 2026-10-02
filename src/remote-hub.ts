// Local remote-control hub: a loopback HTTP service shared by every Pi session that ran /rc.
// Sessions push snapshots and long-poll for phone prompts; phones read Server-Sent Events.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { imageRef, maxImageBase64, type RemoteMedia, type RemoteMessage } from "./remote-state.ts";
import { validSubscription, type PushSender } from "./remote-push.ts";
import { remoteServiceWorker } from "./remote-sw.ts";
import { launchableFolder, listFolders, listMemory, readMemory, recentFolders } from "./remote-mac.ts";
import { renderRemoteMarkdown } from "./remote-markdown.ts";
import { checkRemotePath, convertDocument, listRemoteFiles, previewSourceLimit, readRemoteChunk } from "./remote-files.ts";
import { remoteAppHtml, remoteIconSvg, remoteManifest } from "./remote-web.ts";

export const remoteHost = "127.0.0.1";
export const remoteDefaultPort = 8787;
export const remoteTokenPath = join(homedir(), ".pi/agent/pix-remote/token");

import type { RemoteHelper } from "./remote-helpers.ts";
export interface RemoteSnapshot {
  id: string;
  name: string;
  /** True when the name is a Pi session name, not the fallback folder name. */
  named?: boolean;
  cwd: string;
  busy: boolean;
  /** Where Brook last typed: in the Mac terminal or on the phone. Pushes follow the conversation. */
  origin?: "mac" | "phone";
  /** A question tool call waiting for Brook; answerable from the phone. */
  question?: RemoteQuestion;
  /** Background jobs still running while the agent is idle: Pi will resume on its own. */
  waiting?: number;
  messages: RemoteMessage[];
  streaming?: string;
  streamingHtml?: string;
  /** Context window use, and the latest Pix todo plan. */
  context?: { tokens: number | null; window: number; percent: number | null };
  todos?: { id: string; text: string; status: string; parentId?: string }[];
  /** Running pi-subagents helpers launched by this session. */
  helpers?: RemoteHelper[];
  /** Current model and thinking level, and the choices the phone may switch between. */
  model?: { id: string; name: string };
  thinking?: string;
  models?: { id: string; name: string }[];
  thinkingLevels?: string[];
}

export interface RemotePrompt { text: string; images: { mimeType: string; data: string }[]; mode?: "steer" | "followUp" }
/** A phone request to stop the current Pi turn, like pressing Escape in the terminal. */
export interface RemoteAbort { abort: true }
export type RemoteActionName = "reload" | "new" | "compact" | "close" | "delete";
export interface RemoteAction { action: RemoteActionName | "model" | "thinking" | "answer"; value?: string }
export interface RemoteQuestion { id: string; question: string; options: { label: string; description?: string }[] }

interface Registered extends RemoteSnapshot {
  seenAt: number;
  updatedAt: number;
  prompts: (string | RemotePrompt | RemoteAbort | RemoteAction)[];
  waiter?: (prompts: (string | RemotePrompt | RemoteAbort | RemoteAction)[]) => void;
}

const staleMs = 20_000;
const pollMs = 25_000;
const bodyLimit = 2_000_000;
// A relay frame base64-encodes the encrypted JSON again; leave room for that wrapper.
export function fitRemoteSnapshot(snapshot: RemoteSnapshot, maxBytes = 1_300_000): RemoteSnapshot {
  if (Buffer.byteLength(JSON.stringify(snapshot)) <= maxBytes) return snapshot;
  let low = 0, high = snapshot.messages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...snapshot, messages: snapshot.messages.slice(middle) };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) high = middle;
    else low = middle + 1;
  }
  return { ...snapshot, messages: snapshot.messages.slice(low) };
}

export async function readRemoteToken(path = remoteTokenPath): Promise<string> {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (token.length >= 32) return token;
  } catch {}
  const token = randomBytes(24).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

function sameToken(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res: ServerResponse, status: number, value: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(value) : String(value);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

export interface RemoteHub {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Start the hub on loopback. Rejects with EADDRINUSE when another session already hosts it. */
export interface RemoteHubOptions {
  token: string; port?: number; host?: string; push?: PushSender;
  /** Start a new Pi process with remote on in this already validated folder. */
  launch?: (dir: string) => Promise<void>;
  home?: string; sessionsDir?: string; memoryRoot?: string;
  /** Milliseconds since the Mac keyboard or mouse was last used; injectable for tests. */
  macIdleMs?: () => number;
  /** How long one "visible" presence report counts as Pix on screen; injectable for tests. */
  presenceMs?: number;
}

/** Mac-started work notifies the phone only once Brook has left the Mac this long. */
export const macAwayMs = 5 * 60_000;

/** macOS HID idle time. Unknown counts as away, so a failure never swallows a notification. */
export function readMacIdleMs(): number {
  try {
    const out = execFileSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", timeout: 1000 });
    const ns = /"HIDIdleTime" = (\d+)/.exec(out)?.[1];
    return ns ? Number(ns) / 1e6 : Infinity;
  } catch { return Infinity; }
}

function validQuestion(q: any): RemoteQuestion | undefined {
  if (!q || typeof q.id !== "string" || typeof q.question !== "string" || !Array.isArray(q.options)) return undefined;
  return { id: q.id.slice(0, 200), question: q.question.slice(0, 4000),
    options: q.options.slice(0, 12).map((o: any) => ({ label: String(o?.label ?? "").slice(0, 200), description: o?.description ? String(o.description).slice(0, 400) : undefined })) };
}

export async function startRemoteHub(options: RemoteHubOptions): Promise<RemoteHub> {
  const { token, push } = options;
  // Notify the phone when a session finishes a turn, i.e. Pi is waiting for Brook. Background jobs
  // alone do not notify; when one ends Pi resumes, and that turn's end notifies. Only the session
  // name and outcome are sent, never message text: the push service can read the title.
  const notifyChanges = (old: Registered | undefined, next: Registered) => {
    if (!push || !old) return;
    // A conversation driven from the Mac terminal stays on the Mac while Brook is sitting there.
    if (next.origin === "mac" && (options.macIdleMs ?? readMacIdleMs)() < macAwayMs) return;
    // Like chat apps: no notification on a phone that has Pix open on screen right now.
    // Idle but background work still running: Pi resumes by itself, so Brook is not needed yet.
    if (next.question && next.question.id !== old.question?.id) notifyPhones({ title: next.name, body: "Pi has a question", session: next.id, tag: `ask-${next.id}` });
    if (old.busy && !next.busy && !next.waiting) notifyPhones({ title: next.name, body: "Pi finished", session: next.id, tag: `turn-${next.id}` });
  };
  // A phone that switches apps may be suspended before its "hidden" report arrives, so a "visible"
  // report is only trusted until it expires. A push held back for an on-screen phone is sent then if
  // the phone went silent; any newer presence report means it was really showing Pix, so it stays quiet.
  const presenceMs = options.presenceMs ?? 25_000;
  const heldBack = new Set<ReturnType<typeof setTimeout>>();
  const onScreenNow = (endpoint: string) => (onScreen.get(endpoint) ?? 0) > Date.now();
  const notifyPhones = (message: { title: string; body: string; session: string; tag: string }) => {
    for (const [endpoint, until] of onScreen) if (until > Date.now()) holdBack(message, endpoint, until);
    void push!.notify(message, onScreenNow);
  };
  const holdBack = (message: { title: string; body: string; session: string; tag: string }, endpoint: string, until: number) => {
    const timer = setTimeout(() => {
      heldBack.delete(timer);
      if (onScreen.get(endpoint) === until) void push!.notify(message, other => other !== endpoint);
    }, until - Date.now() + 50);
    timer.unref?.();
    heldBack.add(timer);
  };
  // Phone endpoint -> time until which it counts as looking at Pix (refreshed every 10 s while visible).
  const onScreen = new Map<string, number>();
  const sessions = new Map<string, Registered>();
  const mediaBySession = new Map<string, Map<string, RemoteMedia>>();
  const phones = new Set<ServerResponse>();

  const summary = () => [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, name, named, cwd, busy, waiting, updatedAt, messages }) => {
      const last = messages.at(-1);
      const preview = last?.background ? `Job ${last.background.id}: ${last.background.state}` : last?.text.slice(0, 140) ?? "";
      return { id, name, named, cwd, busy, waiting, updatedAt, preview };
    });
  const publish = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const phone of phones) phone.write(frame);
  };
  const publicSession = ({ prompts: _p, waiter: _w, seenAt: _s, ...s }: Registered) => ({ ...s, messages: s.messages, streaming: s.streaming, streamingHtml: s.streamingHtml, updatedAt: s.updatedAt });
  const drop = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    session.waiter?.([]);
    sessions.delete(id);
    mediaBySession.delete(id);
    publish("sessions", summary());
  };
  const sweep = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.seenAt > staleMs) drop(id);
    for (const phone of phones) phone.write(": ping\n\n");
  }, 5_000);
  sweep.unref();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(res, 200, remoteAppHtml, "text/html");
      if (req.method === "GET" && path === "/manifest.webmanifest") return send(res, 200, remoteManifest, "application/manifest+json");
      if (req.method === "GET" && path === "/sw.js") return send(res, 200, remoteServiceWorker, "text/javascript");
      if (req.method === "GET" && path === "/icon.svg") return send(res, 200, remoteIconSvg, "image/svg+xml");

      const bearer = req.headers.authorization?.replace(/^Bearer /, "");
      if (!sameToken(bearer ?? url.searchParams.get("token"), token)) return send(res, 401, { error: "unauthorized" });

      if (path === "/api/push" && req.method === "GET") return push ? send(res, 200, { publicKey: await push.publicKey(), phones: await push.count() }) : send(res, 404, { error: "notifications are off" });
      if (path === "/api/push" && req.method === "POST") {
        if (!push) return send(res, 404, { error: "notifications are off" });
        const input = await body(req) as any;
        if (typeof input?.presence === "string" && typeof input.endpoint === "string" && input.endpoint.length < 1000) {
          if (input.presence === "visible") onScreen.set(input.endpoint, Date.now() + presenceMs); else onScreen.delete(input.endpoint);
          if (onScreen.size > 20) onScreen.delete(onScreen.keys().next().value!);
          return send(res, 200, { ok: true });
        }
        if (!validSubscription(input?.subscription)) return send(res, 400, { error: "invalid subscription" });
        await push.subscribe(input.subscription);
        if (input.test) await push.notify({ title: "Pix", body: "Notifications are on", tag: "pix-test" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: sessions\ndata: ${JSON.stringify(summary())}\n\n`);
        phones.add(res);
        req.on("close", () => phones.delete(res));
        return;
      }
      if (req.method === "GET" && path === "/api/sessions") return send(res, 200, summary());
      if (req.method === "GET" && path === "/api/folders") {
        const browse = await listFolders(url.searchParams.get("path") ?? "", options.home);
        if (!browse) return send(res, 404, { error: "folder unavailable" });
        return send(res, 200, { ...browse, recent: url.searchParams.get("path") ? undefined : await recentFolders(options.sessionsDir) });
      }
      if (req.method === "POST" && path === "/api/launch") {
        if (!options.launch) return send(res, 404, { error: "starting sessions is unavailable" });
        const dir = await launchableFolder((await body(req))?.path, options.home, options.sessionsDir);
        if (!dir) return send(res, 400, { error: "choose a folder in your home directory" });
        try { await options.launch(dir); } catch (error) { return send(res, 500, { error: `Could not start Pi: ${error instanceof Error ? error.message : String(error)}` }); }
        return send(res, 202, { started: true, path: dir });
      }
      if (req.method === "GET" && path === "/api/memory") return send(res, 200, await listMemory(options.memoryRoot));
      if (req.method === "GET" && path === "/api/memory/file") {
        const file = await readMemory(url.searchParams.get("path"), options.memoryRoot);
        return file ? send(res, 200, { path: file.path, html: renderRemoteMarkdown(file.text) }) : send(res, 404, { error: "file unavailable" });
      }
      const mediaGet = path.match(/^\/api\/sessions\/([^/]+)\/media\/([a-f0-9]{64})$/);
      if (req.method === "GET" && mediaGet) {
        const id = decodeURIComponent(mediaGet[1]);
        if (!sessions.has(id)) return send(res, 404, { error: "session is no longer connected" });
        const media = mediaBySession.get(id)?.get(mediaGet[2]);
        return send(res, media ? 200 : 404, media ?? { error: "image unavailable" });
      }
      // Mac files named in chat or browsed in the Files panel; remote-files.ts checks every path.
      const fileMatch = path.match(/^\/api\/sessions\/([^/]+)\/(files|file|file\/preview)$/);
      if (req.method === "GET" && fileMatch) {
        const session = sessions.get(decodeURIComponent(fileMatch[1]));
        if (!session) return send(res, 404, { error: "session is no longer connected" });
        const roots = { home: options.home, hubRoot: options.memoryRoot };
        const target = url.searchParams.get("path");
        if (fileMatch[2] === "files") {
          const list = listRemoteFiles(target || (checkRemotePath(session.cwd, roots)?.dir ? session.cwd : ""), roots);
          return list ? send(res, 200, list) : send(res, 404, { error: "folder unavailable" });
        }
        if (fileMatch[2] === "file") {
          const { status, ...chunk } = readRemoteChunk(target, Number(url.searchParams.get("offset")) || 0, roots);
          return send(res, status, chunk);
        }
        const file = checkRemotePath(target, roots);
        if (file && !file.dir && file.kind === "markdown" && file.size <= 256_000) return send(res, 200, { path: file.path, name: file.name, html: renderRemoteMarkdown(await readFile(file.path, "utf8"), { home: options.home, hubRoot: options.memoryRoot, dirs: [dirname(file.path)] }) });
        if (!file || file.dir || file.kind !== "word" || file.size > previewSourceLimit) return send(res, 404, { error: "no preview for this file" });
        const html = await convertDocument(file.path).catch(() => undefined);
        if (html === undefined) return send(res, 415, { error: "This document cannot be previewed" });
        if (Buffer.byteLength(html) > 1_000_000) return send(res, 413, { error: "Preview is too large; download the original" });
        return send(res, 200, { path: file.path, name: file.name, html });
      }
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/prompt|\/abort|\/action)?$/);
      if (sessionMatch) {
        const session = sessions.get(decodeURIComponent(sessionMatch[1]));
        if (!session) return send(res, 404, { error: "session is no longer connected" });
        if (req.method === "GET" && !sessionMatch[2]) return send(res, 200, publicSession(session));
        if (req.method === "POST" && sessionMatch[2] === "/abort") {
          await body(req);
          session.prompts.push({ abort: true });
          if (session.waiter) { const w = session.waiter; session.waiter = undefined; w(session.prompts.splice(0)); }
          return send(res, 202, { queued: true });
        }
        if (req.method === "POST" && sessionMatch[2] === "/action") {
          const input = await body(req), action = input.action, value = typeof input.value === "string" ? input.value : undefined;
          if (!["reload", "new", "compact", "close", "delete", "model", "thinking", "answer"].includes(action)) return send(res, 400, { error: "unknown action" });
          // Only offer what this session listed, so the phone cannot pick arbitrary models.
          if (action === "answer" && (!session.question || !value?.trim())) return send(res, 400, { error: "no question is waiting" });
          if (action === "model" && !session.models?.some(m => m.id === value)) return send(res, 400, { error: "unknown model" });
          if (action === "thinking" && !session.thinkingLevels?.includes(value ?? "")) return send(res, 400, { error: "unknown thinking level" });
          // A question arrives mid-turn, so answering is the one action allowed while Pi works.
          if (session.busy && action !== "answer") return send(res, 409, { error: "Pi is working. Stop it or wait, then try again." });
          session.prompts.push(value ? { action, value } : { action });
          if (session.waiter) { const w = session.waiter; session.waiter = undefined; w(session.prompts.splice(0)); }
          return send(res, 202, { queued: true });
        }
        if (req.method === "POST" && sessionMatch[2] === "/prompt") {
          const input = await body(req);
          const text = String(input.text ?? "").trim();
          const images = input.images ?? [];
          if (!Array.isArray(images) || images.length > 2 || images.some((image: any) => !imageRef({ type: "image", ...image }))
            || images.reduce((sum: number, image: any) => sum + image.data.length, 0) > maxImageBase64) return send(res, 400, { error: "invalid or oversized image" });
          if (!text && !images.length) return send(res, 400, { error: "empty prompt" });
          const mode = input.mode === "followUp" ? "followUp" : input.mode === "steer" ? "steer" : undefined;
          session.prompts.push(images.length || mode ? { text: text.slice(0, 100_000), images, ...(mode ? { mode } : {}) } : text.slice(0, 100_000));
          if (session.waiter) { const w = session.waiter; session.waiter = undefined; w(session.prompts.splice(0)); }
          return send(res, 202, { queued: true });
        }
      }

      const mediaPut = path.match(/^\/agent\/([^/]+)\/media\/([a-f0-9]{64})$/);
      if (req.method === "PUT" && mediaPut) {
        const media = (await body(req)) as RemoteMedia;
        const ref = imageRef({ type: "image", ...media });
        if (!ref || ref.id !== mediaPut[2]) return send(res, 400, { error: "invalid image" });
        const id = decodeURIComponent(mediaPut[1]);
        let items = mediaBySession.get(id);
        if (!items) { items = new Map(); mediaBySession.set(id, items); }
        items.delete(ref.id);
        items.set(ref.id, { ...ref, data: media.data });
        while (items.size > 24) items.delete(items.keys().next().value!);
        return send(res, 200, { ok: true });
      }
      const agentMatch = path.match(/^\/agent\/([^/]+)(\/next)?$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (req.method === "PUT" && !agentMatch[2]) {
          const snapshot = (await body(req)) as RemoteSnapshot;
          const old = sessions.get(id);
          const { prompts: _p, waiter: _w, seenAt: _s, updatedAt: _u, ...extra } = snapshot as any;
          const next: Registered = {
            ...extra,
            id, name: String(snapshot.name || "Pi session"), named: snapshot.named === true, cwd: String(snapshot.cwd || ""), busy: Boolean(snapshot.busy), origin: snapshot.origin === "phone" ? "phone" : snapshot.origin === "mac" ? "mac" : undefined, question: validQuestion((snapshot as any).question), waiting: Math.max(0, Number(snapshot.waiting) || 0),
            model: snapshot.model, thinking: snapshot.thinking, models: Array.isArray(snapshot.models) ? snapshot.models.slice(0, 40) : undefined, thinkingLevels: Array.isArray(snapshot.thinkingLevels) ? snapshot.thinkingLevels.slice(0, 10) : undefined,
            messages: Array.isArray(snapshot.messages) ? snapshot.messages : [], streaming: snapshot.streaming || undefined, streamingHtml: snapshot.streamingHtml || undefined,
            seenAt: Date.now(), updatedAt: Date.now(), prompts: old?.prompts ?? [], waiter: old?.waiter,
          };
          sessions.set(id, next);
          notifyChanges(old, next);
          publish("session", publicSession(next));
          publish("sessions", summary());
          return send(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && !agentMatch[2]) { drop(id); return send(res, 200, { ok: true }); }
        if (req.method === "GET" && agentMatch[2]) {
          const session = sessions.get(id);
          if (!session) return send(res, 404, { error: "not registered" });
          session.seenAt = Date.now();
          if (session.prompts.length) return send(res, 200, { prompts: session.prompts.splice(0) });
          session.waiter?.([]);
          let finished = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = (prompts: (string | RemotePrompt | RemoteAbort | RemoteAction)[]) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (session.waiter === finish) session.waiter = undefined;
            if (!res.destroyed && !res.writableEnded) send(res, 200, { prompts });
          };
          timer = setTimeout(() => finish([]), pollMs);
          session.waiter = finish;
          res.on("close", () => finish([]));
          return;
        }
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof Error && error.message === "body too large" ? 413 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? remoteDefaultPort, options.host ?? remoteHost, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? remoteDefaultPort;
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => {
      clearInterval(sweep);
      for (const timer of heldBack) clearTimeout(timer);
      for (const session of sessions.values()) session.waiter?.([]);
      for (const phone of phones) phone.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
