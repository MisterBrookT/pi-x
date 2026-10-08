// /rc: expose this live Pi session to the Pix Remote web app through a loopback-only hub.
import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fitRemoteSnapshot, readRemoteToken, remoteTokenPath, remoteDefaultPort, remoteHost, startRemoteHub, type RemoteHub, type RemoteAbort, type RemoteAction, type RemotePrompt, type RemoteSnapshot } from "../src/remote-hub.ts";
import { branchMessages, remoteMedia, remoteMessages } from "../src/remote-state.ts";
import { createPushSender } from "../src/remote-push.ts";
import { backgroundState } from "../src/background-state.ts";
import { runningHelpers } from "../src/remote-helpers.ts";
import { autoReloadEnabled, createAutoReload, pixCodeVersion } from "../src/remote-autoreload.ts";
import { QUESTION_ANSWER, QUESTION_CLOSE, QUESTION_OPEN } from "./question.ts";
import { renderRemoteMarkdown } from "../src/remote-markdown.ts";
import remend from "remend";
import { prepareRemotePairing, prepareRelayPairing } from "../src/remote-pair.ts";
import { deletableSessionFile, launchPi, remoteSessionsDir, type Spawner } from "../src/remote-mac.ts";
import { bypassProxyForLoopback } from "../src/remote-loopback.ts";
import { readRelayKey, readRelayOrigin, relayKeyPath, rotateRelayKey, startRemoteRelayAgent } from "../src/remote-relay-agent.ts";

const messageLimit = 200;
const heartbeatMs = 8_000;

/** A QR is for adding a device, not for every /rc session. */
export function shouldShowRemotePairing(action: string, paired: boolean) {
  return !paired || action === "pair" || action === "reset" || action === "tailnet pair";
}

export interface RemoteOptions {
  port?: number; tokenPath?: string; relayUrl?: string; relayKeyPath?: string;
  /** Test seams for the phone's New session and Delete actions. */
  spawn?: Spawner; hasOtty?: boolean; sessionsDir?: string; home?: string; memoryRoot?: string;
}

/** Survives extension reloads within one Pi process (module state does not). */
const reloadResume: Map<string, { relay: boolean }> = ((globalThis as any).__pixRemoteReloadResume ??= new Map());
/** Key for "keep remote on in the next session", set by the phone's New chat action. */
const nextSession = "__next";

export default function registerRemote(pi: ExtensionAPI, options: RemoteOptions = {}) {
  bypassProxyForLoopback();
  const port = options.port ?? Number(process.env.PIX_REMOTE_PORT || remoteDefaultPort);
  const base = `http://${remoteHost}:${port}`;
  let publicOrigin = "";
  let relayKey = "";
  let relayAgent: ReturnType<typeof startRemoteRelayAgent> | undefined;
  let ctx: ExtensionContext | undefined;
  // Pi's terminal shows user images only as text. For photos sent from the phone, add a display-only
  // entry after the message so the terminal draws them. It stores a timestamp, not a second copy.
  const phoneImages = new Set<string>();
  pi.registerEntryRenderer<{ timestamp: number }>("pix-remote-image", (entry, _options, theme) => {
    const message = ctx?.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user" && e.message.timestamp === entry.data?.timestamp);
    const content = message?.type === "message" && Array.isArray(message.message.content) ? message.message.content : [];
    const images = content.filter(part => part.type === "image");
    if (!images.length) return undefined;
    const box = new Container();
    box.addChild(new Text(theme.fg("dim", "Photo from phone"), 1, 0));
    for (const image of images) box.addChild(new Image(image.data, image.mimeType, { fallbackColor: text => theme.fg("muted", text) }, { maxWidthCells: 60 }));
    return box;
  });
  let token = "";
  let hub: RemoteHub | undefined;
  let connected = false;
  let busy = false;
  // Who drives this session right now: the Mac terminal or the phone. The hub pushes only for the phone side.
  let origin: "mac" | "phone" = "mac";
  pi.on("input", event => { if (event.source === "interactive") origin = "mac"; });
  let pendingQuestion: { id: string; question: string; options: { label: string; description?: string }[] } | undefined;
  pi.events.on(QUESTION_OPEN, (data: any) => { if (data?.id) { pendingQuestion = { id: String(data.id), question: String(data.question ?? "").slice(0, 4000), options: (Array.isArray(data.options) ? data.options : []).slice(0, 12).map((o: any) => ({ label: String(o?.label ?? "").slice(0, 200), description: o?.description ? String(o.description).slice(0, 400) : undefined })) }; schedulePush(); } });
  pi.events.on(QUESTION_CLOSE, (data: any) => { if (pendingQuestion && data?.id === pendingQuestion.id) { pendingQuestion = undefined; schedulePush(); } });
  const answerQuestion = (answer: string) => { if (!pendingQuestion || !answer.trim()) return false; pi.events.emit(QUESTION_ANSWER, { id: pendingQuestion.id, answer }); return true; };
  let streaming = "";
  let sessionId = "";
  let polling: AbortController | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPairing: (() => Promise<void>) | undefined;
  const uploadedMedia = new Set<string>();
  let deleteOnShutdown: string | undefined;

  const request = (path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

  // One line per relay state change, so "Mac is not connected" on the phone can be checked later.
  const logRelay = (state: string) => {
    try {
      const file = join(dirname(options.tokenPath ?? remoteTokenPath), "relay.log");
      if (existsSync(file) && statSync(file).size > 200_000) renameSync(file, file + ".1");
      appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${state}\n`);
    } catch {}
  };
  // Reload this session when Pix code on disk changes, so the hub and phone never run stale code.
  const pixRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const autoReload = !autoReloadEnabled() ? undefined : createAutoReload({
    version: () => pixCodeVersion(pixRoot),
    ready: () => !!ctx?.isIdle() && !pendingQuestion && backgroundState(pi).running === 0,
    reload: () => pi.sendUserMessage("/rc reload", { expandPromptTemplates: true }),
    log: logRelay,
  });
  // Only an explicit /rc waits for the relay, to report a broken network. Reloads and other
  // automatic paths return at once; the agent keeps retrying and the phone reconnects on its own.
  const ensureRelay = async (wait = false) => {
    if (!hub) return;
    relayAgent ||= startRemoteRelayAgent({ origin: publicOrigin, secret: relayKey, localBase: base, localToken: token, onState: logRelay });
    // A slow network is not fatal: warn, keep the agent retrying, and leave remote on.
    if (wait) await relayAgent.ready.catch(() => ctx?.ui.notify("The relay is slow to reach. Remote is on and keeps retrying; check your network or proxy if the phone stays offline.", "warning"));
    else relayAgent.ready.catch(() => {});
  };

  // The hub lives in whichever session started it. If that session runs older Pix code (it may have
  // turned remote off, so it never auto-reloads), a session whose code matches disk takes over.
  const codeHash = () => createHash("sha256").update(pixCodeVersion(pixRoot)).digest("hex").slice(0, 16);
  const loadedVersion = codeHash();
  let lastStaleCheck = 0;
  const replaceStaleHub = async () => {
    if (hub || Date.now() - lastStaleCheck < 30_000) return false;
    lastStaleCheck = Date.now();
    if (loadedVersion !== codeHash()) return false; // this session is the stale one; it reloads itself
    try {
      const running = await (await request("/agent/version", { signal: AbortSignal.timeout(1_500) })).json() as { version?: string };
      if (running.version === loadedVersion) return false;
      await request("/agent/retire", { method: "POST", body: "{}" });
      for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); try { await fetch(base + "/api/sessions", { signal: AbortSignal.timeout(300) }); } catch { return true; } }
    } catch {}
    return false;
  };
  const ensureHub = async (useRelay = false, wait = false) => {
    try {
      const probe = await request("/api/sessions", { signal: AbortSignal.timeout(1_500) });
      if (probe.ok) {
        if (!(await replaceStaleHub())) { if (useRelay) await ensureRelay(wait); return; }
      }
      else {
      if (probe.status === 401) throw new Error(`Port ${port} is used by a Pix Remote hub with a different token.`);
      throw new Error(`Port ${port} is in use by another service.`); }
    } catch (error) {
      if (error instanceof Error && /Pix Remote|another service/.test(error.message)) throw error;
    }
    // A phone-started Pi uses the same network mode as the session hosting the hub.
    const launch = async (dir: string) => { await launchPi(dir, relayKey ? "relay" : "tailnet", { spawn: options.spawn, hasOtty: options.hasOtty }); };
    try { hub = await startRemoteHub({ token, port, launch, version: loadedVersion, onRetire: () => { relayAgent?.stop(); relayAgent = undefined; const old = hub; hub = undefined; void old?.close(); logRelay("hub handed to a session with newer Pix code"); }, home: options.home, sessionsDir: options.sessionsDir, memoryRoot: options.memoryRoot, push: createPushSender(join(dirname(options.tokenPath ?? remoteTokenPath), "push.json")) }); }
    catch (error: any) { if (error?.code !== "EADDRINUSE") throw error; }
    if (useRelay) await ensureRelay(wait);
  };

  const snapshot = (branch: readonly any[]): RemoteSnapshot | undefined => {
    if (!ctx) return;
    const manager = ctx.sessionManager;
    const messages = remoteMessages(branch, { cwd: ctx.cwd, home: options.home, hubRoot: options.memoryRoot }).slice(-messageLimit);
    const visibleStream = streaming.slice(-12_000);
    const named = pi.getSessionName?.() || manager.getSessionName();
    return fitRemoteSnapshot({ id: sessionId, name: named || basename(ctx.cwd) || "Pi session", named: !!named, cwd: ctx.cwd, busy, origin, waiting: busy ? 0 : backgroundState(pi).running, question: pendingQuestion, messages, ...modelChoices(), context: contextUsage(), todos: latestTodos(branch), helpers: runningHelpers(manager.getSessionFile?.()), streaming: visibleStream || undefined, streamingHtml: visibleStream ? renderRemoteMarkdown(remend(visibleStream), { cwd: ctx.cwd, home: options.home, hubRoot: options.memoryRoot }) : undefined });
  };

  const contextUsage = () => {
    const u = ctx?.getContextUsage();
    return u ? { tokens: u.tokens, window: u.contextWindow, percent: u.percent } : undefined;
  };
  // The todo tool stores the whole plan in each result; the newest one on this branch is current.
  const latestTodos = (branch: readonly any[]) => {
    for (let i = branch.length - 1; i >= 0; i--) {
      const m = branch[i]?.type === "message" ? branch[i].message : branch[i];
      if (m?.role !== "toolResult" || m.toolName !== "todo" || !Array.isArray(m.details?.items)) continue;
      return m.details.items.slice(0, 60).map((x: any) => ({ id: String(x.id), text: String(x.text).slice(0, 300), status: String(x.status), ...(x.parentId === undefined ? {} : { parentId: String(x.parentId) }) }));
    }
    return undefined;
  };

  // The phone may switch between the same models the terminal's model picker offers:
  // enabledModels when configured, otherwise every model with a key.
  const modelKey = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
  const choices = () => {
    if (!ctx) return [];
    const scoped = ctx.scopedModels.map(s => s.model);
    return scoped.length ? scoped : ctx.modelRegistry.getAvailable();
  };
  const modelChoices = () => {
    if (!ctx) return {};
    const current = ctx.model;
    const levels: string[] = current ? getSupportedThinkingLevels(current) : ["off"];
    return {
      model: current ? { id: modelKey(current), name: current.name || current.id } : undefined,
      thinking: pi.getThinkingLevel(),
      models: choices().map(m => ({ id: modelKey(m), name: m.name || m.id })),
      thinkingLevels: levels,
    };
  };
  const switchModel = async (value: string) => {
    const model = choices().find(m => modelKey(m) === value);
    if (!model || !ctx?.isIdle()) return;
    if (!(await pi.setModel(model))) ctx.ui.notify(`No API key for ${modelKey(model)}`, "warning");
    schedulePush();
  };

  let streamTimer: ReturnType<typeof setTimeout> | undefined, streamBusy = false, streamDirty = false;
  const push = async () => {
    if (!connected) return;
    for (let i = 0; i < 40 && streamBusy; i++) await new Promise(r => setTimeout(r, 25));
    const branch = ctx ? branchMessages(ctx.sessionManager.getBranch()) : [];
    const body = snapshot(branch);
    if (!body) return;
    const media = remoteMedia(branch.slice(-messageLimit * 2));
    const publish = async () => {
      for (const image of media) {
        if (uploadedMedia.has(image.id)) continue;
        const res = await request(`/agent/${encodeURIComponent(sessionId)}/media/${image.id}`, { method: "PUT", body: JSON.stringify(image) });
        if (!res.ok) throw new Error(`Image upload failed: ${res.status}`);
        uploadedMedia.add(image.id);
      }
      const res = await request(`/agent/${encodeURIComponent(sessionId)}`, { method: "PUT", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(String(res.status));
    };
    try { await publish(); }
    catch {
      // The session hosting the hub may have exited; the next connected session takes over.
      try { await ensureHub(!!relayKey); uploadedMedia.clear(); await publish(); } catch {}
    }
  };
  // Live text goes out on its own small channel: only the growing reply, not the whole session,
  // so the phone sees it word by word instead of in lumps. One request in flight; the newest text wins.
  const sendStream = async () => {
    if (!connected || !ctx) return;
    if (streamBusy) { streamDirty = true; return; }
    streamBusy = true; streamDirty = false;
    const text = streaming.slice(-12_000);
    try {
      const res = await request(`/agent/${encodeURIComponent(sessionId)}/stream`, { method: "PUT", body: JSON.stringify({ streaming: text, streamingHtml: text ? renderRemoteMarkdown(remend(text), { cwd: ctx.cwd, home: options.home, hubRoot: options.memoryRoot }) : "" }) });
      if (res.status === 404) schedulePush(); // the hub does not know this session yet
    } catch {} finally { streamBusy = false; if (streamDirty) scheduleStream(); }
  };
  const scheduleStream = () => { if (!connected || streamTimer) return; streamTimer = setTimeout(() => { streamTimer = undefined; void sendStream(); }, 80); };
  const schedulePush = (delay = 0) => {
    if (!connected || pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = undefined; void push(); }, delay);
  };

  const deliver = (prompt: string | RemotePrompt | RemoteAbort | RemoteAction) => {
    if (!ctx) return;
    origin = "phone";
    if (typeof prompt === "object" && "abort" in prompt) { if (!ctx.isIdle()) ctx.abort(); return; }
    // Reload and New chat need a command context, so phone actions run through a Pix command.
    if (typeof prompt === "object" && "action" in prompt && prompt.action === "answer") { answerQuestion(prompt.value ?? ""); return; }
    // A typed phone message while a question waits is the answer (the terminal picker cannot be tapped remotely).
    if (pendingQuestion && (typeof prompt === "string" || (!("action" in prompt) && !("abort" in prompt) && !prompt.images?.length))) {
      const text = typeof prompt === "string" ? prompt : (prompt as RemotePrompt).text;
      if (answerQuestion(text)) return;
    }
    if (typeof prompt === "object" && "action" in prompt && prompt.action === "model") { void switchModel(prompt.value ?? ""); return; }
    if (typeof prompt === "object" && "action" in prompt && prompt.action === "thinking") {
      if (ctx.isIdle() && modelChoices().thinkingLevels?.includes(prompt.value ?? "")) pi.setThinkingLevel(prompt.value as any);
      schedulePush(); return;
    }
    // Close and Delete quit this Pi process like /quit; Delete also removes its saved session file.
    if (typeof prompt === "object" && "action" in prompt && (prompt.action === "close" || prompt.action === "delete")) {
      if (!ctx.isIdle()) return;
      if (prompt.action === "delete") deleteOnShutdown = ctx.sessionManager.getSessionFile() ?? "";
      ctx.shutdown(); return;
    }
    if (typeof prompt === "object" && "action" in prompt) { pi.sendUserMessage(`/rc ${prompt.action}`, { expandPromptTemplates: true }); return; }
    const content = typeof prompt === "string" ? prompt : [
      // Pi always sends a text part, and Anthropic rejects an empty one, so a photo-only message gets a short label.
      { type: "text" as const, text: prompt.text || "(photo)" },
      ...prompt.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    ];
    if (typeof prompt === "object") for (const image of prompt.images) phoneImages.add(image.data);
    // While Pi works, a phone message steers the current turn by default, like Enter in the terminal.
    if (ctx.isIdle()) pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: typeof prompt === "object" && prompt.mode === "followUp" ? "followUp" : "steer" });
  };

  const poll = async () => {
    const controller = polling = new AbortController();
    while (connected && polling === controller) {
      try {
        const res = await request(`/agent/${encodeURIComponent(sessionId)}/next`, { signal: controller.signal });
        if (res.status === 404) { await push(); continue; }
        const { prompts = [] } = (await res.json()) as { prompts?: (string | RemotePrompt | RemoteAbort | RemoteAction)[] };
        for (const prompt of prompts) deliver(prompt);
      } catch {
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await push();
      }
    }
  };

  const disconnect = async () => {
    if (!connected) return;
    connected = false;
    polling?.abort();
    clearInterval(heartbeat);
    clearTimeout(pushTimer);
    pushTimer = undefined;
    try { await request(`/agent/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal: AbortSignal.timeout(1_000) }); } catch {}
    if (hub && relayAgent) {
      try { if ((await (await request("/api/sessions")).json() as unknown[]).length === 0) { relayAgent.stop(); relayAgent = undefined; } } catch {}
    }
    ctx?.ui.setStatus("pix-remote", undefined);
    await cleanupPairing?.();
    cleanupPairing = undefined;
  };

  const connect = async (next: ExtensionContext, useRelay: boolean, wait = false) => {
    ctx = next;
    token ||= await readRemoteToken(options.tokenPath);
    if (useRelay) relayKey ||= await readRelayKey(options.relayKeyPath);
    await ensureHub(useRelay, wait);
    sessionId = next.sessionManager.getSessionId();
    uploadedMedia.clear();
    busy = !next.isIdle();
    connected = true;
    await push();
    heartbeat = setInterval(() => { void push(); autoReload?.tick(); void replaceStaleHub().then(stale => { if (stale) return ensureHub(!!relayKey).then(() => push()); }).catch(() => {}); }, heartbeatMs);
    heartbeat.unref?.();
    void poll();
    next.ui.setStatus("pix-remote", "remote on");
  };

  const track = (_event: unknown, next: ExtensionContext) => { ctx = next; };
  pi.on("agent_start", (_e, next) => { ctx = next; busy = true; streaming = ""; schedulePush(); });
  pi.on("agent_settled", (_e, next) => { ctx = next; busy = false; streaming = ""; schedulePush(); if (connected) autoReload?.tick(); });
  pi.on("message_update", (event, next) => {
    ctx = next;
    const delta = event.assistantMessageEvent;
    if (delta.type === "text_delta") { streaming += delta.delta; scheduleStream(); }
  });
  pi.on("message_end", (event, next) => {
    ctx = next; streaming = ""; clearTimeout(streamTimer); streamTimer = undefined; streamDirty = false; schedulePush();
    const message = event.message;
    if (message.role !== "user" || !Array.isArray(message.content)) return;
    const fromPhone = message.content.filter(part => part.type === "image" && phoneImages.delete(part.data));
    // Pi saves the message after this handler returns; wait so the picture lands below it.
    if (fromPhone.length) setTimeout(() => pi.appendEntry("pix-remote-image", { timestamp: message.timestamp }), 0);
  });
  pi.on("tool_execution_start", (e, next) => { track(e, next); schedulePush(); });
  pi.on("tool_execution_end", (e, next) => { track(e, next); schedulePush(); });
  pi.on("session_tree", (e, next) => { track(e, next); schedulePush(); });
  pi.on("session_compact", (e, next) => { track(e, next); schedulePush(); });
  pi.on("session_info_changed", (e, next) => { track(e, next); schedulePush(); });
  pi.on("model_select", (e, next) => { track(e, next); schedulePush(); });
  pi.on("thinking_level_select", (e, next) => { track(e, next); schedulePush(); });
  // /reload replaces this extension instance; remember "remote on" so the new instance resumes it.
  // Quitting or switching sessions still turns remote off.
  pi.on("session_start", async (event, next) => {
    // A Pi started from the phone's New session turns remote on by itself.
    const autostart = process.env.PIX_REMOTE_AUTOSTART;
    if (event.reason === "startup" && autostart && !connected) {
      delete process.env.PIX_REMOTE_AUTOSTART;
      try {
        publicOrigin = options.relayUrl ?? await readRelayOrigin();
        await connect(next, autostart !== "tailnet" && !!publicOrigin);
      } catch (error) {
        await disconnect();
        next.ui.notify(`Remote control could not start: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      return;
    }
    const key = event.reason === "new" ? nextSession : next.sessionManager.getSessionId();
    const resume = reloadResume.get(key);
    reloadResume.delete(key);
    if ((event.reason !== "reload" && event.reason !== "new") || !resume || connected) return;
    try {
      publicOrigin = options.relayUrl ?? await readRelayOrigin();
      if (resume.relay && !publicOrigin) return;
      await connect(next, resume.relay);
    } catch (error) {
      await disconnect();
      next.ui.notify(`Remote control could not resume after reload: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload" && connected && sessionId) reloadResume.set(sessionId, { relay: Boolean(relayKey) });
    await disconnect();
    relayAgent?.stop();
    relayAgent = undefined;
    await hub?.close();
    hub = undefined;
    if (deleteOnShutdown !== undefined) {
      const file = await deletableSessionFile(deleteOnShutdown, sessionId, options.sessionsDir ?? remoteSessionsDir);
      deleteOnShutdown = undefined;
      if (file) await unlink(file).catch(() => {});
    }
  });

  pi.registerCommand("rc", {
    description: "Control this Pi session from Pix Remote on your phone",
    getArgumentCompletions: (prefix: string) => {
      const items = ["off", "status", "pair", "reset", "tailnet", "tailnet pair", "reload", "new", "compact"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, next) => {
      const action = args.trim();
      // Phone quick actions arrive as /rc reload|new|compact; typing them in the terminal also works.
      if (action === "reload" || action === "new" || action === "compact") {
        if (!next.isIdle()) { next.ui.notify("Pi is working. Stop it or wait, then try again.", "warning"); return; }
        if (action === "compact") { next.compact({ onError: error => next.ui.notify(`Compact failed: ${error.message}`, "error") }); return; }
        if (action === "reload") { await next.reload(); return; }
        if (connected) reloadResume.set(nextSession, { relay: Boolean(relayKey) });
        if ((await next.newSession()).cancelled) reloadResume.delete(nextSession);
        return;
      }
      if (action === "off") {
        await disconnect();
        next.ui.notify("Remote control is off for this session.", "info");
        return;
      }
      if (action === "status") {
        next.ui.notify(connected ? `Remote control is on${relayKey ? " via encrypted relay" : " via private tailnet"}.` : "Remote control is off. Run /rc to turn it on.", "info");
        return;
      }
      const tailnet = action === "tailnet" || action === "tailnet pair";
      if (action && !tailnet && action !== "reset" && action !== "pair") { next.ui.notify("Usage: /rc [off|status|pair|reset|tailnet|tailnet pair|reload|new|compact]", "warning"); return; }
      const keyPath = tailnet ? options.tokenPath ?? remoteTokenPath : options.relayKeyPath ?? relayKeyPath;
      const showPairing = shouldShowRemotePairing(action, existsSync(keyPath));
      try {
        publicOrigin = options.relayUrl ?? await readRelayOrigin();
        if (action === "reset" && (!hub || !publicOrigin)) { next.ui.notify("Run /rc reset in the Pi session that started the relay hub.", "warning"); return; }
        if (!publicOrigin && !tailnet) {
          next.ui.notify("No relay configured. Set PIX_REMOTE_RELAY_URL or ~/.pi/agent/pix-remote/relay.json, or use /rc tailnet.", "warning");
          return;
        }
        const useRelay = !tailnet;
        if (action === "reset") {
          await disconnect();
          relayAgent?.stop(); relayAgent = undefined;
          relayKey = await rotateRelayKey(options.relayKeyPath);
        }
        if (!connected) await connect(next, useRelay, true);
        else if (useRelay) { relayKey ||= await readRelayKey(options.relayKeyPath); await ensureHub(true, true); }
        if (!showPairing) {
          next.ui.notify("Remote control is on. Refresh Pix Remote on your paired phone. Use /rc pair to add another device.", "info");
        } else if (next.mode === "tui") {
          await cleanupPairing?.();
          const pairing = useRelay ? await prepareRelayPairing(publicOrigin, relayKey) : await prepareRemotePairing(port, token);
          cleanupPairing = pairing.cleanup;
          next.ui.notify(`Remote control is on. ${pairing.message}`, "info");
        } else {
          next.ui.notify(`Remote control is on. Open ${useRelay ? `${publicOrigin}/#key=${relayKey}` : `${base}/#token=${token}`}`, "info");
        }
      } catch (error) {
        await disconnect();
        relayAgent?.stop(); relayAgent = undefined;
        next.ui.notify(`Remote control failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
