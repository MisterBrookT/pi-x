// Local remote-control hub: a loopback HTTP service shared by every Pi session that ran /rc.
// Sessions push snapshots and long-poll for phone prompts; phones read Server-Sent Events.
import { frameCheck } from "./remote-frame.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { imageRef, maxImageBase64, type RemoteMedia, type RemoteMessage } from "./remote-state.ts";
import { validSubscription, type PushSender } from "./remote-push.ts";
import { remoteServiceWorker } from "./remote-sw.ts";
import { launchableFolder, listFolders, pastSessions, resumableSession, listMemory, readMemory, recentFolders } from "./remote-mac.ts";
import { renderRemoteMarkdown } from "./remote-markdown.ts";
import { checkRemotePath, convertDocument, listRemoteFiles, previewSourceLimit, readEditable, createEditable, saveMarkdownImage, saveUpload, readRemoteChunk, saveEditable } from "./remote-files.ts";
import { previewRemoteDocument } from "./remote-document-preview.ts";
import { remoteThumbnail } from "./remote-thumb.ts";
import { createDesktopBroker, desktopIdPattern, type DesktopBroker } from "../desktop/remote-desktop.ts";
import { createDesktopCredentialStore, type DesktopCredentialStore } from "../desktop/remote-desktop-credentials.ts";
import { createDesktopInput, createDesktopInputController, type DesktopInputController } from "../desktop/remote-desktop-input.ts";
import { remoteAppHtml, remoteIconSvg, remoteManifest } from "./remote-web.ts";
import { registeredHubPlugins, type HubPlugin, type HubContext } from "../core/hub-plugin.ts";

export { remoteHost, remoteDefaultPort, remoteTokenPath, remoteUploadsDir, remoteLinksPath, readRemoteLinks } from "../core/hub-paths.ts";
import { remoteHost, remoteDefaultPort, remoteTokenPath, remoteUploadsDir, remoteLinksPath, readRemoteLinks } from "../core/hub-paths.ts";

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
  /** Chat asks/handoffs to other sessions without a reply yet ("Waiting for pix"); not running work. */
  peerWait?: string;
  /** Docs, links and files this session pinned for brook (core/artifacts.ts); file urls are absolute paths. */
  pinned?: { title: string; url: string; kind: "doc" | "link" | "file" }[];
  /** Next scheduled background health check (epoch ms), shown on the phone like the Mac footer. */
  nextLook?: number;
  messages: RemoteMessage[];
  streaming?: string;
  streamingHtml?: string;
  /** Context window use, and the latest Pix todo plan. */
  context?: { tokens: number | null; window: number; percent: number | null };
  todos?: { id: string; text: string; status: string; parentId?: string }[];
  /** The slash commands this Pi offers (name, one-line description), for the phone's / menu. */
  commands?: { name: string; description?: string }[];
  /** Running pi-subagents helpers launched by this session. */
  helpers?: RemoteHelper[];
  footer?: { work?: string; core?: string; waits?: string };
  /** Current model and thinking level, and the choices the phone may switch between. */
  model?: { id: string; name: string };
  thinking?: string;
  models?: { id: string; name: string }[];
  thinkingLevels?: string[];
  /** Earlier user messages on this branch that the phone may rewind to, like double Esc on the Mac. */
  rewinds?: { id: string; text: string }[];
}

export interface RemotePrompt { text: string; images: { mimeType: string; data: string }[]; mode?: "steer" | "followUp" | "quiet" }
/** A phone request to stop the current Pi turn, like pressing Escape in the terminal. */
export interface RemoteAbort { abort: true }
export type RemoteActionName = "reload" | "new" | "compact" | "close" | "delete";
export interface RemoteAction { action: RemoteActionName | "model" | "thinking" | "answer" | "rewind"; value?: string }
export interface RemoteQuestion { id: string; question: string; context?: string; options: { label: string; description?: string }[]; questions?: { header: string; question: string; context?: string; options: { label: string; description?: string }[] }[] }

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
/**
 * Only the last `turns` turns (0 = all): from the `turns`-th last user message on. Tool calls and results
 * are messages too, so counting messages would cut a single turn. `older` counts what was left out.
 */
export function tailSession<T extends { messages: unknown[] }>(session: T, turns: number): T & { older?: number } {
  if (!(turns > 0)) return session;
  let start = session.messages.length, seen = 0;
  while (start > 0 && seen < turns) if ((session.messages[--start] as { role?: string })?.role === "user") seen++;
  if (seen < turns) start = 0;
  if (start === 0) return session;
  return { ...session, messages: session.messages.slice(start), older: start };
}
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
  /** Where files sent from the phone composer are saved (default ~/.pi/agent/pix-remote/uploads). */
  uploadsDir?: string;
  /** Start a new Pi process with remote on in this already validated folder. */
  launch?: (dir: string, session?: string) => Promise<void>;
  home?: string; sessionsDir?: string; memoryRoot?: string; linksPath?: string;
  /** Milliseconds since the Mac keyboard or mouse was last used; injectable for tests. */
  macIdleMs?: () => number;
  /** How long one "visible" presence report counts as Pix on screen; injectable for tests. */
  presenceMs?: number;
  /** Pix code version this hub runs; a session with newer code asks it to retire. */
  version?: string;
  /** Called when a newer session takes the hub over; the host stops serving. */
  onRetire?: () => void;
  /** Remembered desktop login; tests inject a store with a fake security runner. */
  desktopCredentials?: DesktopCredentialStore;
  /** Native keyboard for the desktop; tests inject a fake controller so no real keystrokes happen. */
  desktopInput?: DesktopInputController;
  /** Tests only: a broker wired to a fake VNC server; production always uses the fixed 127.0.0.1:5900 broker. */
  desktopBroker?: DesktopBroker;
  /** Features that add their own routes, phone events and session fields (For you, …). */
  plugins?: HubPlugin[];
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
  return { id: q.id.slice(0, 200), question: q.question.slice(0, 4000), ...(typeof q.context === "string" && q.context.trim() ? { context: q.context.slice(0, 2000) } : {}),
    options: q.options.slice(0, 12).map((o: any) => ({ label: String(o?.label ?? "").slice(0, 200), description: o?.description ? String(o.description).slice(0, 400) : undefined })), ...multiQuestions(q.questions) };
}

/** Several questions in one card (2-4), trimmed like the single form. */
export function multiQuestions(qs: any): { questions?: RemoteQuestion["questions"] } {
  if (!Array.isArray(qs) || qs.length < 2) return {};
  return { questions: qs.slice(0, 4).map((q: any) => ({ header: String(q?.header ?? "").slice(0, 40), question: String(q?.question ?? "").slice(0, 2000), ...(q?.context ? { context: String(q.context).slice(0, 2000) } : {}), options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o: any) => ({ label: String(o?.label ?? "").slice(0, 200), description: o?.description ? String(o.description).slice(0, 400) : undefined })) })) };
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
  const notifyPhones = (message: { title: string; body: string; session: string; tag: string; foryou?: boolean }) => {
    for (const [endpoint, until] of onScreen) if (until > Date.now()) holdBack(message, endpoint, until);
    void push!.notify(message, onScreenNow);
  };
  const holdBack = (message: { title: string; body: string; session: string; tag: string; foryou?: boolean }, endpoint: string, until: number) => {
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
  // Phone VNC to this Mac's Screen Sharing; the destination is fixed inside remote-desktop.ts.
  const desktop = options.desktopBroker ?? createDesktopBroker({ onClose: id => desktopInput.close(id) });
  const desktopCredentials = options.desktopCredentials ?? createDesktopCredentialStore();
  // A test/injected VNC broker must never accidentally type on the host Mac.
  const desktopInput = createDesktopInput(options.desktopInput ?? createDesktopInputController(options.desktopBroker ? "injected-broker" : process.platform));

  const summary = () => [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, name, named, cwd, busy, waiting, nextLook, peerWait, updatedAt, messages, todos, question }) => {
      const last = messages.at(-1);
      const preview = last?.background ? `Job ${last.background.id}: ${last.background.state}` : last?.text.slice(0, 140) ?? "";
      // The step it is on now: For you uses this to see what brook is working on.
      const todo = todos?.find(t => t.status === "active")?.text.slice(0, 160);
      return { id, name, named, cwd, busy, waiting, nextLook, ...(peerWait ? { peerWait } : {}), updatedAt, preview, ...(todo ? { todo } : {}), ...extraSummary(id), ...(question ? { asks: true } : {}) };
    });
  const publish = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const phone of phones) phone.write(frame);
  };
  // Plugins: each gets the hub's shared pieces and adds routes, phone events and session fields.
  const ctx: HubContext = {
    publish: (event, data) => publish(event, data),
    notify: message => { if (push) notifyPhones(message); },
    liveSessions: () => [...sessions.values()].map(({ id, name, cwd, busy }) => ({ id, name, cwd, busy })),
    queue: (sid, text) => {
      const live = sessions.get(sid);
      if (!live) return false;
      live.prompts.push(live.busy ? { text, images: [], mode: "followUp" } : text);
      if (live.waiter) { const w = live.waiter; live.waiter = undefined; w(live.prompts.splice(0)); }
      return true;
    },
    note: (sid, text) => {
      const live = sessions.get(sid);
      if (!live) return false;
      live.prompts.push({ text, images: [], mode: "quiet" });
      if (live.waiter) { const w = live.waiter; live.waiter = undefined; w(live.prompts.splice(0)); }
      return true;
    },
    refreshSession: id => { const s = sessions.get(id); if (s) publish("session", publicSession(s)); publish("sessions", summary()); },
  };
  const hubPlugins = (options.plugins ?? registeredHubPlugins()).map(p => p(ctx));
  const extras = () => hubPlugins.flatMap(p => p.initial?.() ?? []);
  function extraSummary(id: string) { return Object.assign({}, ...hubPlugins.map(p => p.summary?.(id) ?? {})); }
  function extraSession(id: string) { return Object.assign({}, ...hubPlugins.map(p => p.session?.(id) ?? {})); }
  const sessionPatch = (old: Registered | undefined, next: Registered) => {
    if (!old) return undefined;
    const { messages: a, ...oldMeta } = publicSession(old), { messages: b, ...meta } = publicSession(next);
    let keep = 0;
    while (keep < a.length && keep < b.length && JSON.stringify(a[keep]) === JSON.stringify(b[keep])) keep++;
    // The window slid (old messages dropped off the front): send everything.
    if (keep === 0 && a.length && b.length && a[0].id !== b[0].id) return undefined;
    const same = (x: any, y: any) => JSON.stringify({ ...x, updatedAt: 0 }) === JSON.stringify({ ...y, updatedAt: 0 });
    if (keep === a.length && keep === b.length && same(oldMeta, meta)) return null;
    return { ...meta, keep, base: a.length, tail: b.slice(keep) };
  };
  const publicSession = ({ prompts: _p, waiter: _w, seenAt: _s, ...s }: Registered) => ({ ...s, messages: s.messages, streaming: s.streaming, streamingHtml: s.streamingHtml, updatedAt: s.updatedAt, ...extraSession(s.id) });
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

      if (path === "/agent/version" && req.method === "GET") return send(res, 200, { version: options.version ?? "" });
      if (path === "/agent/retire" && req.method === "POST") { send(res, 200, { ok: true }); setTimeout(() => options.onRetire?.(), 50); return; }
      if (path === "/api/here" && req.method === "GET") return send(res, 200, { ok: true });  // phone presence for the privacy cover (read by the relay agent)
      if (path === "/api/push" && req.method === "GET") return push ? send(res, 200, { publicKey: await push.publicKey(), phones: await push.count() }) : send(res, 404, { error: "notifications are off" });
      if (path === "/api/push" && req.method === "POST") {
        if (!push) return send(res, 404, { error: "notifications are off" });
        const input = await body(req) as any;
        if (typeof input?.presence === "string" && typeof input.endpoint === "string" && input.endpoint.length < 1000) {
          if (input.presence === "visible") onScreen.set(input.endpoint, Date.now() + presenceMs); else onScreen.delete(input.endpoint);
          if (onScreen.size > 20) onScreen.delete(onScreen.keys().next().value!);
          return send(res, 200, { ok: true });
        }
        if (typeof input?.unsubscribe === "string" && input.unsubscribe.length < 1000) { await push.unsubscribe(input.unsubscribe); onScreen.delete(input.unsubscribe); return send(res, 200, { ok: true }); }
        if (!validSubscription(input?.subscription)) return send(res, 400, { error: "invalid subscription" });
        await push.subscribe(input.subscription);
        if (input.test) await push.notify({ title: "Pix", body: "Notifications are on", tag: "pix-test" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: sessions\ndata: ${JSON.stringify(summary())}\n\n`);
        for (const [event, data] of extras()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        phones.add(res);
        req.on("close", () => phones.delete(res));
        return;
      }
      if (req.method === "POST" && path === "/api/desktop/open") { await body(req); const r = desktop.open(); return send(res, r.status, r.status === 200 && desktopInput.enabled ? { ...r.body, nativeInput: true } : r.body); }
      if (path === "/api/desktop/credentials" && req.method === "DELETE") {
        try { await desktopCredentials.remove(); return send(res, 200, { ok: true }); } catch { return send(res, 500, { error: "could not forget desktop login" }); }
      }
      const credentialMatch = path.match(new RegExp(`^/api/desktop/(${desktopIdPattern})/credentials$`));
      if (credentialMatch && (req.method === "GET" || req.method === "POST")) {
        if (!desktop.has(credentialMatch[1])) return send(res, 404, { error: "desktop session ended" });
        if (req.method === "GET") {
          try { const saved = await desktopCredentials.load(); return send(res, 200, saved ? { saved: true, ...saved } : { saved: false }); }
          catch { return send(res, 500, { error: "could not read desktop login" }); }
        }
        let input: unknown;
        try { input = await body(req); } catch { return send(res, 400, { error: "invalid desktop login" }); }
        try { await desktopCredentials.save(input); return send(res, 200, { ok: true }); }
        catch { return send(res, 400, { error: "could not save desktop login" }); }
      }
      const desktopMatch = path.match(new RegExp(`^/api/desktop/(${desktopIdPattern})/(read|write|close|input)$`));
      if (desktopMatch) {
        const [, id, verb] = desktopMatch;
        if (verb === "read" && req.method === "GET") { const r = await desktop.read(id, url.searchParams.get("seq")); return res.destroyed ? undefined : send(res, r.status, r.body); }
        if (verb === "write" && req.method === "POST") { const r = desktop.write(id, await body(req)); return send(res, r.status, r.body); }
        if (verb === "input" && req.method === "POST") {
          let input: unknown;
          try { input = await body(req); } catch { return send(res, 400, { error: "invalid desktop input" }); }
          const r = await desktopInput.input(id, input, () => desktop.has(id));
          return res.destroyed ? undefined : send(res, r.status, r.body);
        }
        if (verb === "close" && req.method === "POST") { desktopInput.close(id); const r = desktop.close(id); return send(res, r.status, r.body); }
      }
      if (req.method === "GET" && path === "/api/sessions") return send(res, 200, summary());
      if (req.method === "GET" && path === "/api/extras") return send(res, 200, extras());
      for (const p of hubPlugins) {
        const r = await p.route?.(req.method ?? "GET", path, () => body(req));
        if (r) return send(res, r.status, r.body);
      }
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
      // Reopen a saved session, like `pi -r` on the Mac. Live sessions are already in the list.
      if (req.method === "GET" && path === "/api/past") return send(res, 200, await pastSessions(options.sessionsDir, new Set(sessions.keys())));
      if (req.method === "POST" && path === "/api/resume") {
        if (!options.launch) return send(res, 404, { error: "starting sessions is unavailable" });
        const target = await resumableSession((await body(req))?.path, options.sessionsDir);
        if (!target) return send(res, 400, { error: "choose a saved session" });
        try { await options.launch(target.cwd, target.file); } catch (error) { return send(res, 500, { error: `Could not start Pi: ${error instanceof Error ? error.message : String(error)}` }); }
        return send(res, 202, { started: true, path: target.cwd });
      }
      if (req.method === "GET" && path === "/api/links") return send(res, 200, await readRemoteLinks(options.linksPath));
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
      // Phone editor: open and save existing Markdown/text files; saveEditable refuses stale overwrites.
      const makeMatch = path.match(/^\/api\/sessions\/([^/]+)\/file\/(create|image|upload)$/);
      if (makeMatch && req.method === "POST") {
        if (!sessions.has(decodeURIComponent(makeMatch[1]))) return send(res, 404, { error: "session is no longer connected" });
        const roots = { home: options.home, hubRoot: options.memoryRoot };
        const input = await body(req);
        const { status, ...result } = makeMatch[2] === "create" ? createEditable(input, roots) : makeMatch[2] === "upload" ? saveUpload(input, options.uploadsDir ?? remoteUploadsDir) : saveMarkdownImage(input, roots);
        return send(res, status, result);
      }
      const editMatch = path.match(/^\/api\/sessions\/([^/]+)\/file\/(source|save)$/);
      if (editMatch && (req.method === "GET" && editMatch[2] === "source" || req.method === "POST" && editMatch[2] === "save")) {
        if (!sessions.has(decodeURIComponent(editMatch[1]))) return send(res, 404, { error: "session is no longer connected" });
        const roots = { home: options.home, hubRoot: options.memoryRoot };
        const { status, ...result } = editMatch[2] === "source" ? readEditable(url.searchParams.get("path"), roots) : saveEditable(await body(req), roots);
        return send(res, status, result);
      }
      if (req.method === "GET" && path === "/api/frame-check") return send(res, 200, await frameCheck(url.searchParams.get("url") ?? ""));
      const fileMatch = path.match(/^\/api\/sessions\/([^/]+)\/(files|file|file\/preview|file\/thumb)$/);
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
        if (fileMatch[2] === "file/thumb") {
          const { status, ...result } = await remoteThumbnail(target, roots);
          return send(res, status, result);
        }
        const file = checkRemotePath(target, roots);
        if (file && !file.dir && (file.kind === "pdf" || file.kind === "slides")) {
          const { status, ...result } = await previewRemoteDocument(target, url.searchParams.get("page"), roots);
          return send(res, status, result);
        }
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
        if (req.method === "GET" && !sessionMatch[2]) return send(res, 200, tailSession(publicSession(session), Number(url.searchParams.get("tail")) || 0));
        if (req.method === "POST" && sessionMatch[2] === "/abort") {
          await body(req);
          session.prompts.push({ abort: true });
          if (session.waiter) { const w = session.waiter; session.waiter = undefined; w(session.prompts.splice(0)); }
          return send(res, 202, { queued: true });
        }
        if (req.method === "POST" && sessionMatch[2] === "/action") {
          const input = await body(req), action = input.action, value = typeof input.value === "string" ? input.value : undefined;
          if (!["reload", "new", "compact", "close", "delete", "model", "thinking", "answer", "rewind"].includes(action)) return send(res, 400, { error: "unknown action" });
          // Only offer what this session listed, so the phone cannot pick arbitrary models.
          if (action === "answer" && (!session.question || !value?.trim())) return send(res, 400, { error: "no question is waiting" });
          if (action === "model" && !session.models?.some(m => m.id === value)) return send(res, 400, { error: "unknown model" });
          if (action === "rewind" && !session.rewinds?.some(r => r.id === value)) return send(res, 400, { error: "unknown message" });
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
          if (!Array.isArray(images) || images.length > 4 || images.some((image: any) => !imageRef({ type: "image", ...image }))
            || images.reduce((sum: number, image: any) => sum + image.data.length, 0) > maxImageBase64) return send(res, 400, { error: "invalid or oversized image" });
          if (!text && !images.length) return send(res, 400, { error: "empty prompt" });
          // Idempotent send: the phone tags each message with an id and retries with the same id until it gets an answer,
          // so a retry after a lost reply (timeout, reconnect) is acknowledged without queueing the message twice.
          const cid = typeof input.cid === "string" && /^[\w-]{8,64}$/.test(input.cid) ? input.cid : "";
          if (cid) { const seen = (session as any).cids as string[] ?? ((session as any).cids = []); if (seen.includes(cid)) return send(res, 202, { queued: true, duplicate: true }); seen.push(cid); if (seen.length > 200) seen.shift(); }
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
      const streamPut = path.match(/^\/agent\/([^/]+)\/stream$/);
      if (req.method === "PUT" && streamPut) {
        const session = sessions.get(decodeURIComponent(streamPut[1]));
        if (!session) return send(res, 404, { error: "not registered" });
        const input = await body(req);
        session.streaming = typeof input.streaming === "string" && input.streaming ? input.streaming.slice(-12_000) : undefined;
        session.streamingHtml = session.streaming && typeof input.streamingHtml === "string" ? input.streamingHtml.slice(0, 200_000) : undefined;
        session.busy = session.busy || !!session.streaming; session.seenAt = Date.now();
        publish("stream", { id: session.id, streaming: session.streaming ?? "", streamingHtml: session.streamingHtml ?? "" });
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
            id, name: String(snapshot.name || "Pi session"), named: snapshot.named === true, cwd: String(snapshot.cwd || ""), busy: Boolean(snapshot.busy), origin: snapshot.origin === "phone" ? "phone" : snapshot.origin === "mac" ? "mac" : undefined, question: validQuestion((snapshot as any).question), waiting: Math.max(0, Number(snapshot.waiting) || 0), nextLook: Number.isFinite(Number(snapshot.nextLook)) && Number(snapshot.nextLook) > 0 ? Number(snapshot.nextLook) : undefined,
            model: snapshot.model, thinking: snapshot.thinking, models: Array.isArray(snapshot.models) ? snapshot.models.slice(0, 40) : undefined, thinkingLevels: Array.isArray(snapshot.thinkingLevels) ? snapshot.thinkingLevels.slice(0, 10) : undefined,
            rewinds: Array.isArray(snapshot.rewinds) ? snapshot.rewinds.slice(-40).map((r: any) => ({ id: String(r?.id ?? "").slice(0, 100), text: String(r?.text ?? "").slice(0, 300) })) : undefined,
            messages: Array.isArray(snapshot.messages) ? snapshot.messages : [], streaming: snapshot.streaming || undefined, streamingHtml: snapshot.streamingHtml || undefined,
            seenAt: Date.now(), updatedAt: Date.now(), prompts: old?.prompts ?? [], waiter: old?.waiter,
          };
          sessions.set(id, next);
          notifyChanges(old, next);
          // A session joining can add a "Send to" button to the card.
          if (!old) for (const p of hubPlugins) p.sessionJoined?.(id);
          // Phones get only what changed: messages after the first difference, plus the small fields.
          // A heartbeat with nothing new sends nothing, so the phone never re-draws for no reason.
          const patch = sessionPatch(old, next);
          if (patch === undefined) publish("session", publicSession(next));
          else if (patch) publish("sessionPatch", patch);
          if (!old || patch !== null) publish("sessions", summary());
          // "fresh": this hub has no images from this session (it restarted, or the session is new here), so the session
          // must upload them again; otherwise the phone shows "Image unavailable" after a reconnect.
          return send(res, 200, { ok: true, fresh: !mediaBySession.has(id) });
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
            // The Mac's poll went away (sleep, network change): keep its prompts for the next poll instead of dropping them.
            if (!res.destroyed && !res.writableEnded) send(res, 200, { prompts });
            else if (prompts.length) session.prompts.unshift(...prompts);
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
      for (const p of hubPlugins) p.close?.();
      desktopInput.dispose();
      desktop.dispose();
      for (const timer of heldBack) clearTimeout(timer);
      for (const session of sessions.values()) session.waiter?.([]);
      for (const phone of phones) phone.end();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
