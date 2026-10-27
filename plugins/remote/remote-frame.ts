/**
 * Can pi-rc show this web page in its own pane (an iframe)? Sites refuse with X-Frame-Options or a CSP
 * frame-ancestors list; the browser then shows a blank or error frame we cannot detect from the page.
 * The Mac asks the site once and the phone falls back to opening the link normally.
 */
export type FrameCheck = { ok: boolean; reason?: string };

/** Decide from response headers alone (pure, for tests). */
export function frameAllowed(headers: { get(name: string): string | null }): FrameCheck {
	const xfo = (headers.get("x-frame-options") ?? "").trim().toLowerCase();
	if (xfo === "deny" || xfo === "sameorigin" || xfo.startsWith("allow-from")) return { ok: false, reason: `the site sends X-Frame-Options: ${xfo.toUpperCase()}` };
	const csp = headers.get("content-security-policy") ?? "";
	const fa = csp.split(";").map(d => d.trim()).find(d => /^frame-ancestors\b/i.test(d));
	if (fa) {
		const srcs = fa.split(/\s+/).slice(1).map(s => s.toLowerCase());
		if (!srcs.includes("*") && !srcs.some(s => s === "https:" || s === "https://*")) return { ok: false, reason: `the site only allows framing by ${srcs.join(" ") || "'none'"}` };
	}
	return { ok: true };
}

/** Loopback, private, link-local, CGNAT/tailnet, ULA: the Mac must not fetch these for the phone (no probing the hub or LAN). */
export function privateAddress(ip: string): boolean {
	const v = ip.toLowerCase().replace(/^::ffff:/, "");
	const m = v.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
	if (m) { const a = +m[1], b = +m[2]; return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); }
	return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}
const privateName = (h: string) => /(^|\.)(localhost|local|ts\.net|internal|lan|home\.arpa)$/i.test(h);
type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async h => (await (await import("node:dns")).promises.lookup(h, { all: true })).map(a => a.address);

/** Is this URL safe for the Mac to fetch? Private targets are reported as such, never fetched. */
async function publicUrl(u: URL, lookup: Lookup): Promise<boolean> {
	const host = u.hostname.replace(/^\[|\]$/g, "");
	if (privateName(host)) return false;
	const ips = /^[\d.]+$|:/.test(host) ? [host] : await lookup(host).catch(() => [] as string[]);
	return ips.length > 0 && !ips.some(privateAddress);
}

export async function frameCheck(url: string, fetcher: typeof fetch = fetch, timeoutMs = 5000, lookup: Lookup = dnsLookup): Promise<FrameCheck> {
	let u: URL;
	try { u = new URL(url); } catch { return { ok: false, reason: "not a web address" }; }
	if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "not a web address" };
	const allowPrivate = process.env.PIX_FRAME_CHECK_PRIVATE === "1";
	const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		// Follow redirects by hand so every hop is checked; a private page is left to the phone's own browser.
		for (let hop = 0; hop < 5; hop++) {
			if (!allowPrivate && !(await publicUrl(u, lookup))) return { ok: true, reason: "not checked (private or unknown address)" };
			const r = await fetcher(u.href, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } });
			void r.body?.cancel().catch(() => {});
			const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
			if (!loc) return frameAllowed(r.headers);
			u = new URL(loc, u);
			if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: true, reason: "could not check" };
		}
		return { ok: true, reason: "could not check" };
	} catch {
		// Unknown (offline, slow): let the pane try; the page still has an "Open normally" button.
		return { ok: true, reason: "could not check" };
	} finally { clearTimeout(timer); }
}
