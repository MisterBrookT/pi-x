// Dev server for the phone UI in the iOS Simulator. Proxies the live Mac hub (real sessions and For you data) and
// serves the page fresh from plugins/remote on every load, plus a tiny reload channel: edit a file, the page reloads.
// Dev only: listens on 127.0.0.1; the token never leaves the Mac (the Simulator runs on this Mac).
import { createServer, request } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const port = Number(process.env.PIX_SIM_PORT || 8790), hub = Number(process.env.PIX_HUB_PORT || 8787);
const dir = new URL("../plugins/remote/", import.meta.url).pathname;
const clients = new Set();
// Real app icons for source avatars, taken from the installed Mac apps (never committed: they are the vendors' marks).
const icons = new URL("../.pix/icons/", import.meta.url).pathname;
mkdirSync(icons, { recursive: true });
for (const [name, app, base] of [["wechat", "/Applications/WeChat.app", "AppIcon"], ["feishu", "/Applications/Lark.app", "app"], ["dingtalk", "/Applications/DingTalk.app", "AppIcon"], ["minara", "/Applications/Minara.app", ""], ["mail", "/System/Applications/Mail.app", "ApplicationIcon"], ["otty", "/Applications/Otty.app", ""]]) {
	if (existsSync(join(icons, name + ".png"))) continue;
	try { const r = join(app, "Contents/Resources"); const f = readdirSync(r).find(x => x.endsWith(".icns") && x.startsWith(base)); if (f) execFileSync("sips", ["-s", "format", "png", "-Z", "96", join(r, f), "--out", join(icons, name + ".png")], { stdio: "ignore" }); } catch { /* missing app: letter avatar */ }
}
let version = Date.now();
const reload = `<script>(()=>{const s=new EventSource("/__sim/reload");let v;s.onmessage=e=>{if(v&&e.data!==v)location.reload();v=e.data}})()</script>`;
// Never cache: a stale service worker would hide changes.
const noSw = `<script>navigator.serviceWorker?.getRegistrations?.().then(r=>r.forEach(x=>x.unregister()))</script>`;

async function page() {
	const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
	const { remoteAppHtml } = await jiti.import(dir + "remote-web.ts");
	return remoteAppHtml.replace("</head>", `${noSw}${reload}</head>`).replace(/navigator\.serviceWorker\.register\([^)]*\)/, "Promise.resolve(null)");
}

createServer(async (req, res) => {
	const path = (req.url || "/").split("?")[0];
	if (path === "/__sim/reload") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
		res.write(`data: ${version}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); return;
	}
	// Design mockups, dev only: /timeline is the X-style For you timeline on real data.
	if (req.method === "GET" && path.startsWith("/icons/")) {
		const f = join(icons, basename(path));
		if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" }); res.end(readFileSync(f)); return;
	}
	if (req.method === "GET" && path === "/timeline") {
		// Loopback-only server, so any caller is on this Mac: hand it the hub token (desktop Chrome and the Simulator app need no hash).
		const token = readFileSync(join(homedir(), ".pi/agent/pix-remote/token"), "utf8").trim();
		const html = readFileSync(dir + "foryou-timeline-mock.html", "utf8").replace("</head>", `<script>window.PIX_TOKEN=${JSON.stringify(token)}</script>${reload}</head>`);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); return;
	}
	if (req.method === "GET" && (path === "/" || path === "/index.html")) {
		try { const html = await page(); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); }
		catch (e) { res.writeHead(500, { "content-type": "text/plain" }); res.end(String(e?.stack || e)); }
		return;
	}
	const up = request({ host: "127.0.0.1", port: hub, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${hub}` } }, r => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
	up.on("error", e => { res.writeHead(502); res.end(`hub: ${e.message}`); });
	req.pipe(up);
}).listen(port, "127.0.0.1", () => console.log(`sim dev: http://127.0.0.1:${port} (hub :${hub}); watching plugins/remote`));

let t;
watch(dir, { recursive: true }, (_e, f) => {
	if (!f || !/\.(ts|css|html|svg|js)$/.test(f) || /test/.test(f)) return;
	clearTimeout(t); t = setTimeout(() => { version = Date.now(); console.log(`changed ${f}: reload`); for (const c of clients) c.write(`data: ${version}\n\n`); }, 150);
});
