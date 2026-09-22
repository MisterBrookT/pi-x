import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody, fetchUrl, isHtml, isPdf, isTextual, mimeOf } from "../src/web/fetch.ts";

const lookup = async () => [{ address: "93.184.216.34" }];

/** Serve a fixed body so extraction is tested without a network. */
function serve(body, headers = { "content-type": "text/html" }, status = 200) {
	return async () => new Response(body, { status, headers });
}

test("content types are classified for dispatch", () => {
	assert.equal(mimeOf("text/html; charset=utf-8"), "text/html");
	assert.equal(isHtml("text/html"), true);
	assert.equal(isHtml("application/xhtml+xml"), true);
	assert.equal(isHtml("text/plain"), false);
	assert.equal(isTextual("application/json"), true);
	assert.equal(isTextual("image/png"), false);
	assert.equal(isPdf("https://x.test/a.pdf", ""), true);
	assert.equal(isPdf("https://x.test/a", "application/pdf"), true);
	assert.equal(isPdf("https://x.test/a", "text/html"), false);
});

test("a declared charset is honoured, and a bad one falls back to utf-8", () => {
	const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
	assert.equal(decodeBody(latin1, "text/html; charset=iso-8859-1"), "café");
	assert.equal(decodeBody(new TextEncoder().encode("ok"), "text/html; charset=nonsense-9000"), "ok");
});

test("an article becomes markdown with its title", async () => {
	const html = `<html><head><title>Doc Title</title></head><body><article>
		<h1>Heading</h1>${"<p>Readable sentence that carries enough weight to be extracted as the main article body.</p>".repeat(6)}
		</article></body></html>`;
	const result = await fetchUrl("https://example.com/post", { fetch: serve(html), lookup });
	assert.equal(result.status, 200);
	assert.equal(result.error, undefined);
	assert.match(result.content, /Readable sentence/);
	assert.match(result.content, /^#+ Heading/m, "headings use atx style");
	assert.ok(result.title?.includes("Title") || result.title === "Doc Title", `unexpected title ${result.title}`);
});

test("scripts and styles never reach the markdown", async () => {
	const html = `<html><head><title>T</title><style>.a{color:red}</style></head><body>
		<script>window.secret = "tracking-payload";</script>
		<p>${"Genuine visible prose that should survive extraction. ".repeat(10)}</p></body></html>`;
	const result = await fetchUrl("https://example.com/", { fetch: serve(html), lookup });
	assert.doesNotMatch(result.content, /tracking-payload/);
	assert.doesNotMatch(result.content, /color:red/);
	assert.match(result.content, /Genuine visible prose/);
});

test("a page Readability rejects still returns body text", async () => {
	const html = "<html><head><title>App</title></head><body><div><a href='/x'>Link</a><p>Short.</p></div></body></html>";
	const result = await fetchUrl("https://example.com/", { fetch: serve(html), lookup });
	assert.equal(result.error, undefined);
	assert.match(result.content, /Short\.|Link/);
});

test("raw mode returns the exact body without extraction", async () => {
	const html = "<html><body><p>Hi</p></body></html>";
	const result = await fetchUrl("https://example.com/", { mode: "raw", fetch: serve(html), lookup });
	assert.equal(result.content, html);
});

test("raw mode refuses binary content instead of returning mojibake", async () => {
	const result = await fetchUrl("https://example.com/a.png", {
		mode: "raw",
		fetch: serve("binary", { "content-type": "image/png" }),
		lookup,
	});
	assert.match(result.error ?? "", /Cannot return image\/png as raw text/);
});

test("JSON and plain text are returned verbatim in readable mode", async () => {
	const json = '{"ok":true}';
	const result = await fetchUrl("https://example.com/api", { fetch: serve(json, { "content-type": "application/json" }), lookup });
	assert.equal(result.content, json);
});

test("an unsupported binary type is reported, not guessed at", async () => {
	const result = await fetchUrl("https://example.com/v.mp4", { fetch: serve("...", { "content-type": "video/mp4" }), lookup });
	assert.match(result.error ?? "", /Unsupported content type: video\/mp4/);
});

test("an HTTP error is reported with its status", async () => {
	const result = await fetchUrl("https://example.com/missing", { fetch: serve("nope", { "content-type": "text/html" }, 404), lookup });
	assert.equal(result.status, 404);
	assert.match(result.error ?? "", /HTTP 404/);
});

test("an oversized declared response is refused on content-length alone", async () => {
	// The body itself is tiny, so only the declared length can trip the limit.
	const fetchImpl = async () =>
		new Response("small", { headers: { "content-type": "text/html", "content-length": "99999999" } });
	const result = await fetchUrl("https://example.com/big", { fetch: fetchImpl, lookup, maxBytes: 1024 });
	assert.match(result.error ?? "", /Response too large/);
});

test("an oversized stream is cancelled rather than buffered to the end", async () => {
	let cancelled = false;
	let chunks = 0;
	const fetchImpl = async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					chunks++;
					controller.enqueue(new Uint8Array(512));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-type": "text/html" } },
		);
	const result = await fetchUrl("https://example.com/endless", { fetch: fetchImpl, lookup, maxBytes: 1024 });
	assert.match(result.error ?? "", /Response too large/);
	assert.equal(cancelled, true, "an endless body must be cancelled");
	assert.ok(chunks < 10, `stopped early, read ${chunks} chunks`);
});

test("a lying content-length is caught while streaming", async () => {
	const fetchImpl = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (let i = 0; i < 16; i++) controller.enqueue(new Uint8Array(256));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/html" } },
		);
	const result = await fetchUrl("https://example.com/big", { fetch: fetchImpl, lookup, maxBytes: 1024 });
	assert.match(result.error ?? "", /Response too large/);
});

test("a blocked address is surfaced as an error, not a throw", async () => {
	const result = await fetchUrl("http://127.0.0.1:9/secret");
	assert.match(result.error ?? "", /Blocked internal address/);
	assert.equal(result.status, 0);
});

test("a response that never arrives times out with a clear message", async () => {
	const fetchImpl = (_url, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
		});
	const result = await fetchUrl("https://example.com/slow", { fetch: fetchImpl, lookup, timeoutMs: 40 });
	assert.match(result.error ?? "", /Timed out fetching .*no data for 40ms/);
});

/**
 * Deliver a complete HTML document in `chunks` pieces `gapMs` apart, so the
 * download is slow but never stalled.
 */
function trickle({ chunks, gapMs, headers }) {
	const body = `<p>This paragraph is a chunk of slowly delivered prose, repeated so the extractor keeps it as article content. ${"Padding sentence for article scoring. ".repeat(6)}</p>`;
	return async () => {
		let sent = 0;
		return new Response(
			new ReadableStream({
				async pull(controller) {
					await new Promise((r) => setTimeout(r, gapMs));
					if (sent === 0) controller.enqueue(new TextEncoder().encode("<html><head><title>Slow paper</title></head><body>"));
					else if (sent <= chunks) controller.enqueue(new TextEncoder().encode(body));
					else {
						controller.enqueue(new TextEncoder().encode("</body></html>"));
						controller.close();
					}
					sent++;
				},
			}),
			{ headers },
		);
	};
}

test("a slow but progressing download is not killed by the idle timeout", async () => {
	// Ten chunks 60ms apart take ~600ms, far beyond the 250ms idle budget,
	// yet no single gap reaches it.
	const result = await fetchUrl("https://example.com/slow-paper", {
		fetch: trickle({ chunks: 10, gapMs: 60, headers: { "content-type": "text/html" } }),
		lookup,
		timeoutMs: 250,
	});
	assert.equal(result.error, undefined, "progress must renew the deadline");
	assert.match(result.content, /slowly delivered prose/);
});

test("a download that stalls mid-body is still abandoned", async () => {
	let sent = false;
	const fetchImpl = async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					if (sent) return new Promise(() => {});
					sent = true;
					controller.enqueue(new TextEncoder().encode("<p>start</p>"));
				},
			}),
			{ headers: { "content-type": "text/html" } },
		);
	const result = await fetchUrl("https://example.com/stalled", { fetch: fetchImpl, lookup, timeoutMs: 60 });
	assert.match(result.error ?? "", /no data for/);
});

test("an absolute ceiling still bounds an endlessly trickling response", async () => {
	const result = await fetchUrl("https://example.com/endless-trickle", {
		fetch: trickle({ chunks: Number.POSITIVE_INFINITY, gapMs: 5, headers: { "content-type": "text/html" } }),
		lookup,
		timeoutMs: 250,
		maxTotalMs: 300,
	});
	assert.match(result.error ?? "", /Timed out fetching/);
});

test("a paper larger than the HTML ceiling is not refused on size", async () => {
	const big = new Uint8Array(6 * 1024 * 1024);
	const fetchImpl = async () => new Response(big, { headers: { "content-type": "application/pdf" } });
	const result = await fetchUrl("https://arxiv.test/paper.pdf", { fetch: fetchImpl, lookup });
	assert.doesNotMatch(result.error ?? "", /too large/i);
});

test("a configured pdf.maxSizeMB still bounds the download", async () => {
	const big = new Uint8Array(3 * 1024 * 1024);
	const fetchImpl = async () => new Response(big, { headers: { "content-type": "application/pdf" } });
	const result = await fetchUrl("https://arxiv.test/paper.pdf", { fetch: fetchImpl, lookup, pdf: { maxSizeMB: 1 } });
	assert.match(result.error ?? "", /too large/i);
});

test("X gets a browser user agent so it does not answer 403", async () => {
	const agents = {};
	const fetchImpl = async (url, init) => {
		agents[new URL(url).hostname] = init.headers["User-Agent"];
		return new Response("<html><body><p>ok</p></body></html>", { headers: { "content-type": "text/html" } });
	};
	for (const host of ["x.com", "twitter.com", "api.x.com", "example.com"]) {
		await fetchUrl(`https://${host}/a`, { fetch: fetchImpl, lookup });
	}
	assert.match(agents["x.com"], /Mozilla\/5\.0/);
	assert.match(agents["twitter.com"], /Mozilla\/5\.0/);
	assert.match(agents["api.x.com"], /Mozilla\/5\.0/, "subdomains of x.com need it too");
	assert.match(agents["example.com"], /^Pix\//, "everything else identifies itself honestly");
});
