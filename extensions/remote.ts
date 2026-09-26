// /rc: expose this live Pi session to the Pix Remote web app through a loopback-only hub.
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { fitRemoteSnapshot, readRemoteToken, remoteTokenPath, remoteDefaultPort, remoteHost, startRemoteHub, type RemoteHub, type RemoteAbort, type RemoteAction, type RemotePrompt, type RemoteSnapshot } from "../src/remote-hub.ts";
import { branchMessages, remoteMedia, remoteMessages } from "../src/remote-state.ts";
import { createPushSender } from "../src/remote-push.ts";
import { renderRemoteMarkdown } from "../src/remote-markdown.ts";
import { prepareRemotePairing, prepareRelayPairing } from "../src/remote-pair.ts";
import { readRelayKey, readRelayOrigin, relayKeyPath, rotateRelayKey, startRemoteRelayAgent } from "../src/remote-relay-agent.ts";

const messageLimit = 200;
const heartbeatMs = 8_000;

/** A QR is for adding a device, not for every /rc session. */
export function shouldShowRemotePairing(action: string, paired: boolean) {
  return !paired || action === "pair" || action === "reset" || action === "tailnet pair";
}

export interface RemoteOptions { port?: number; tokenPath?: string; relayUrl?: string; relayKeyPath?: string; }

/** Survives extension reloads within one Pi process (module state does not). */
const reloadResume: Map<string, { relay: boolean }> = ((globalThis as any).__pixRemoteReloadResume ??= new Map());
/** Key for "keep remote on in the next session", set by the phone's New chat action. */
const nextSession = "__next";

export default function registerRemote(pi: ExtensionAPI, options: RemoteOptions = {}) {
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
  const asking = new Set<string>();
  let streaming = "";
  let sessionId = "";
  let polling: AbortController | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPairing: (() => Promise<void>) | undefined;
  const uploadedMedia = new Set<string>();

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
  const ensureRelay = async () => {
    if (!hub) return;
    relayAgent ||= startRemoteRelayAgent({ origin: publicOrigin, secret: relayKey, localBase: base, localToken: token, onState: logRelay });
    await relayAgent.ready;
  };

  const ensureHub = async (useRelay = false) => {
    try {
      const probe = await request("/api/sessions", { signal: AbortSignal.timeout(1_500) });
      if (probe.ok) {
        if (useRelay) await ensureRelay();
        return;
      }
      if (probe.status === 401) throw new Error(`Port ${port} is used by a Pix Remote hub with a different token.`);
      throw new Error(`Port ${port} is in use by another service.`);
    } catch (error) {
      if (error instanceof Error && /Pix Remote|another service/.test(error.message)) throw error;
    }
    try { hub = await startRemoteHub({ token, port, push: createPushSender(join(dirname(options.tokenPath ?? remoteTokenPath), "push.json")) }); }
    catch (error: any) { if (error?.code !== "EADDRINUSE") throw error; }
    if (useRelay) await ensureRelay();
  };

  const snapshot = (branch: readonly any[]): RemoteSnapshot | undefined => {
    if (!ctx) return;
    const manager = ctx.sessionManager;
    const messages = remoteMessages(branch).slice(-messageLimit);
    const visibleStream = streaming.slice(-12_000);
    const named = pi.getSessionName?.() || manager.getSessionName();
    return fitRemoteSnapshot({ id: sessionId, name: named || basename(ctx.cwd) || "Pi session", named: !!named, cwd: ctx.cwd, busy, messages, ...modelChoices(), context: contextUsage(), asking: asking.size > 0 || undefined, todos: latestTodos(branch), streaming: visibleStream || undefined, streamingHtml: visibleStream ? renderRemoteMarkdown(visibleStream) : undefined });
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

  const push = async () => {
    if (!connected) return;
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
  const schedulePush = (delay = 0) => {
    if (!connected || pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = undefined; void push(); }, delay);
  };

  const deliver = (prompt: string | RemotePrompt | RemoteAbort | RemoteAction) => {
    if (!ctx) return;
    if (typeof prompt === "object" && "abort" in prompt) { if (!ctx.isIdle()) ctx.abort(); return; }
    // Reload and New chat need a command context, so phone actions run through a Pix command.
    if (typeof prompt === "object" && "action" in prompt && prompt.action === "model") { void switchModel(prompt.value ?? ""); return; }
    if (typeof prompt === "object" && "action" in prompt && prompt.action === "thinking") {
      if (ctx.isIdle() && modelChoices().thinkingLevels?.includes(prompt.value ?? "")) pi.setThinkingLevel(prompt.value as any);
      schedulePush(); return;
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

  const connect = async (next: ExtensionContext, useRelay: boolean) => {
    ctx = next;
    token ||= await readRemoteToken(options.tokenPath);
    if (useRelay) relayKey ||= await readRelayKey(options.relayKeyPath);
    await ensureHub(useRelay);
    sessionId = next.sessionManager.getSessionId();
    uploadedMedia.clear();
    busy = !next.isIdle();
    connected = true;
    await push();
    heartbeat = setInterval(() => void push(), heartbeatMs);
    heartbeat.unref?.();
    void poll();
    next.ui.setStatus("pix-remote", "remote on");
  };

  const track = (_event: unknown, next: ExtensionContext) => { ctx = next; };
  pi.on("agent_start", (_e, next) => { ctx = next; busy = true; streaming = ""; schedulePush(); });
  pi.on("tool_execution_start", (e, next) => { if (e.toolName === "question") { ctx = next; asking.add(e.toolCallId); schedulePush(); } });
  pi.on("tool_execution_end", (e, next) => { if (asking.delete(e.toolCallId)) { ctx = next; schedulePush(); } });
  pi.on("agent_settled", (_e, next) => { ctx = next; busy = false; asking.clear(); streaming = ""; schedulePush(); });
  pi.on("message_update", (event, next) => {
    ctx = next;
    const delta = event.assistantMessageEvent;
    if (delta.type === "text_delta") { streaming += delta.delta; schedulePush(120); }
  });
  pi.on("message_end", (event, next) => {
    ctx = next; streaming = ""; schedulePush();
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
        if (!connected) await connect(next, useRelay);
        else if (useRelay) { relayKey ||= await readRelayKey(options.relayKeyPath); await ensureHub(true); }
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
