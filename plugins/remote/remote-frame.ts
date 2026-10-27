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

export async function frameCheck(url: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<FrameCheck> {
	let u: URL;
	try { u = new URL(url); } catch { return { ok: false, reason: "not a web address" }; }
	if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "not a web address" };
	const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const r = await fetcher(u.href, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } });
		void r.body?.cancel().catch(() => {});
		return frameAllowed(r.headers);
	} catch {
		// Unknown (offline, slow): let the pane try; the page still has an "Open normally" button.
		return { ok: true, reason: "could not check" };
	} finally { clearTimeout(timer); }
}
