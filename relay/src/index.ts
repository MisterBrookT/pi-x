import { remoteAppHtml, remoteIconSvg, remoteManifest } from "../../plugins/remote/remote-web.ts";
import { remoteRelayWebScript } from "../../plugins/remote/remote-relay-web.ts";
import { remoteServiceWorker } from "../../plugins/remote/remote-sw.ts";
import { pageUpdateScript } from "../../plugins/remote/remote-relay-web.ts";

// Build id: the page checks /version when it comes back to the screen and reloads itself when a newer
// page is deployed, so a home-screen app that stays open never keeps running old code.
const page = remoteAppHtml.replace("<script>", `<script>\n${remoteRelayWebScript}\n`);
const build = (() => { let h = 2166136261; for (let i = 0; i < page.length; i++) h = Math.imul(h ^ page.charCodeAt(i), 16777619); return (h >>> 0).toString(36); })();
const html = page.replace("<script>", `<script>\nconst PIX_BUILD=${JSON.stringify(build)};\n${pageUpdateScript}\n`);
const text = (body: string, type: string, headers: Record<string, string> = {}) => new Response(body, { headers: {
  "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000", ...headers,
} });

export default {
  fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const nonce = crypto.randomUUID().replace(/-/g, "");
      return text(html.replace("<script>", `<script nonce="${nonce}">`), "text/html; charset=utf-8", {
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' wss://${url.host}; img-src 'self' data: blob:; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (url.pathname === "/version") return text(JSON.stringify({ build }), "application/json");
    if (url.pathname === "/sw.js") return text(remoteServiceWorker, "text/javascript", { "service-worker-allowed": "/" });
    if (url.pathname === "/icon.svg") return text(remoteIconSvg, "image/svg+xml");
    if (url.pathname === "/manifest.webmanifest") return text(remoteManifest, "application/manifest+json");
    const route = url.pathname.match(/^\/socket\/([a-f0-9]{64})\/(agent|phone)$/);
    if (!route) return new Response("Not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    if (route[2] === "phone" && request.headers.get("origin") !== url.origin) return new Response("Wrong origin", { status: 403 });
    return env.ROOMS.getByName(route[1]).fetch(request);
  },
};

/** Routes opaque encrypted frames only. No key, plaintext, or transcript is stored here. */
export class Room {
  private state: any;
  constructor(state: any) { this.state = state; state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong")); }
  fetch(request: Request) {
    const role = new URL(request.url).pathname.endsWith("/agent") ? "agent" : "phone";
    // A phone that slept or lost signal leaves a socket the relay still counts. Refusing new phones ("Room full") then locked
    // brook out until those died. Instead the newest phone wins: drop the least recently heard ones.
    if (role === "phone") {
      // Phones ping every 15 s. One silent for 45 s is dead (slept, lost signal): drop it. Never drop live phones for a
      // newcomer (that made open pages kick each other off in a loop); allow up to 8 live ones.
      const heard = (ws: WebSocket) => (ws as any).deserializeAttachment?.()?.heard ?? 0;
      let phones = this.state.getWebSockets("phone");
      for (const old of phones) if (Date.now() - heard(old) > 45_000) { try { old.close(4000, "silent"); } catch {} }
      phones = phones.filter((ws: WebSocket) => Date.now() - heard(ws) <= 45_000);
      if (phones.length >= 8) return new Response("Room full", { status: 429 });
    }
    if (role === "agent") for (const old of this.state.getWebSockets("agent")) old.close(1000, "replaced");
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [role]);
    try { (pair[1] as any).serializeAttachment?.({ heard: Date.now() }); } catch {}
    if (role === "agent") this.signal("agent-online");
    else pair[1].send(JSON.stringify({ signal: this.state.getWebSockets("agent").length ? "agent-online" : "agent-offline" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private signal(value: string) {
    for (const phone of this.state.getWebSockets("phone")) {
      try { phone.send(JSON.stringify({ signal: value })); } catch {}
    }
  }
  webSocketClose(socket: WebSocket) {
    if (this.state.getTags(socket).includes("agent") && !this.state.getWebSockets("agent").some((other: WebSocket) => other !== socket && other.readyState === WebSocket.OPEN)) this.signal("agent-offline");
  }
  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    try { (socket as any).serializeAttachment?.({ heard: Date.now() }); } catch {}
    if (typeof data !== "string" || data.length > 2_000_000) { socket.close(1009, "frame too large"); return; }
    const other = this.state.getWebSockets("agent").includes(socket) ? "phone" : "agent";
    for (const peer of this.state.getWebSockets(other)) {
      try { peer.send(data); } catch { peer.close(1011, "send failed"); }
    }
  }
}
