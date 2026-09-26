import { remoteAppHtml, remoteIconSvg, remoteManifest } from "../../src/remote-web.ts";
import { remoteRelayWebScript } from "../../src/remote-relay-web.ts";
import { remoteServiceWorker } from "../../src/remote-sw.ts";

const html = remoteAppHtml.replace("<script>", `<script>\n${remoteRelayWebScript}\n`);
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
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self' wss://${url.host}; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
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
  constructor(private state: any) { state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong")); }
  fetch(request: Request) {
    const role = new URL(request.url).pathname.endsWith("/agent") ? "agent" : "phone";
    if (role === "phone" && this.state.getWebSockets("phone").length >= 3) return new Response("Room full", { status: 429 });
    if (role === "agent") for (const old of this.state.getWebSockets("agent")) old.close(1000, "replaced");
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [role]);
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
    if (typeof data !== "string" || data.length > 2_000_000) { socket.close(1009, "frame too large"); return; }
    const other = this.state.getWebSockets("agent").includes(socket) ? "phone" : "agent";
    for (const peer of this.state.getWebSockets(other)) {
      try { peer.send(data); } catch { peer.close(1011, "send failed"); }
    }
  }
}
