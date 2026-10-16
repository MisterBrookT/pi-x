/**
 * Fetching a URL and turning it into markdown a model can read.
 *
 * The pipeline is deliberately short: bounded download, MIME dispatch, then
 * Readability to find the article and Turndown to render it. Reads are capped
 * and streamed so a hostile or enormous response cannot exhaust memory.
 */

import { fetchRemoteUrl, type GuardOptions } from "./ssrf.ts";

const MAX_BYTES = 5 * 1024 * 1024;
/** Papers routinely exceed the HTML ceiling, so PDFs get their own. */
const MAX_PDF_BYTES = 30 * 1024 * 1024;

/** Render a timeout budget readably, so sub-second limits do not print "0s". */
function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * X rejects automated user agents with a 403, so it gets a browser string.
 * Everything else is told plainly what it is talking to.
 */
function userAgent(url: URL): string {
  return /(^|\.)(x\.com|twitter\.com)$/i.test(url.hostname) ? CHROME_UA : "Pix/1.0 (+https://github.com/brooktang/pix)";
}

function requestHeaders(url: URL): Record<string, string> {
  return {
    "User-Agent": userAgent(url),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  };
}

/**
 * Read a body with a hard ceiling, cancelling as soon as it is exceeded.
 *
 * `onProgress` reports each chunk so the caller can distinguish a stalled
 * connection from a slow but healthy one. A large PDF over a slow link is
 * still making progress and must not be treated as a timeout.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  onProgress?: () => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw sizeError(maxBytes);
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw sizeError(maxBytes);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Watch the deadline directly: a body that never yields another chunk must
  // not depend on the fetch implementation rejecting the pending read for us.
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      })
    : undefined;
  if (aborted) aborted.catch(() => {});
  try {
    for (;;) {
      const next = reader.read();
      const { done, value } = aborted ? await Promise.race([next, aborted]) : await next;
      if (done) break;
      if (!value) continue;
      onProgress?.();
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw sizeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function sizeError(maxBytes: number): Error {
  return new Error(`Response too large (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

/** Decode using the charset the server declared, falling back to UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function mimeOf(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isHtml(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

export function isPdf(url: string, contentType: string): boolean {
  return mimeOf(contentType).includes("application/pdf") || new URL(url).pathname.toLowerCase().endsWith(".pdf");
}

export function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/ld+json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

export interface FetchResult {
  url: string;
  title?: string;
  content: string;
  mime: string;
  status: number;
  error?: string;
}

export interface FetchArgs extends GuardOptions {
  mode?: "readable" | "raw";
  /** Time allowed with no progress at all. Renewed by each chunk received. */
  timeoutMs?: number;
  /** Absolute ceiling regardless of progress. */
  maxTotalMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  pdf?: { enabled?: boolean; maxPages?: number; maxSizeMB?: number };
}

/** Readability plus Turndown; loaded lazily so a plain fetch stays cheap. */
async function htmlToMarkdown(html: string, url: string): Promise<{ title?: string; markdown: string }> {
  const { parseHTML } = await import("linkedom");
  const { Readability } = await import("@mozilla/readability");
  const TurndownService = (await import("turndown")).default;

  const { document } = parseHTML(html);
  const documentTitle = document.title?.trim() || undefined;
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  // Scripts and styles survive Readability often enough to be worth removing.
  turndown.remove(["script", "style", "noscript"]);

  let article: { title?: string; content?: string } | null = null;
  try {
    article = new Readability(document as never).parse();
  } catch {
    article = null;
  }
  if (article?.content) {
    const markdown = turndown.turndown(article.content).trim();
    if (markdown.length > 0) return { title: article.title?.trim() || documentTitle, markdown };
  }
  // Readability gives up on landing pages and app shells; render the body.
  const body = document.body?.innerHTML ?? html;
  return { title: documentTitle, markdown: turndown.turndown(body).trim() };
}

async function pdfToMarkdown(bytes: Uint8Array, url: string, maxPages: number): Promise<{ title?: string; markdown: string }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const pageCount = Math.min(pdf.numPages, maxPages);
  const parts: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const text = await (await pdf.getPage(page)).getTextContent();
    const line = text.items
      .map((item: { str?: string }) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) parts.push(`## Page ${page}\n\n${line}`);
  }
  const truncated = pdf.numPages > pageCount ? `\n\n_Truncated at ${pageCount} of ${pdf.numPages} pages._` : "";
  return { title: undefined, markdown: `# ${url}\n\n${parts.join("\n\n")}${truncated}`.trim() };
}

/** Fetch one URL and return markdown, raw text, or a described failure. */
export async function fetchUrl(rawUrl: string, args: FetchArgs = {}): Promise<FetchResult> {
  const maxBytes = args.maxBytes ?? MAX_BYTES;
  const idleMs = args.timeoutMs ?? 30_000;
  // The deadline covers connecting and waiting for headers, then each chunk
  // renews it. A slow download therefore survives; a dead one still dies.
  const totalMs = args.maxTotalMs ?? Math.max(idleMs, 300_000);
  const timeout = new AbortController();
  const startedAt = Date.now();
  let timer = setTimeout(() => timeout.abort(), idleMs);
  let receiving = true;
  const keepAlive = () => {
    if (!receiving || Date.now() - startedAt >= totalMs) return;
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), idleMs);
  };
  /** Stop the clock once the bytes are in: parsing is not a network stall. */
  const finishReceiving = <T>(body: T): T => {
    receiving = false;
    clearTimeout(timer);
    return body;
  };
  const onAbort = () => timeout.abort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const target = new URL(rawUrl);
    const response = await fetchRemoteUrl(
      target,
      { headers: requestHeaders(target), signal: timeout.signal },
      { allowRanges: args.allowRanges, lookup: args.lookup, fetch: args.fetch },
    );
    const contentType = response.headers.get("content-type") ?? "";
    const mime = mimeOf(contentType);

    if (!response.ok && args.mode !== "raw") {
      return { url: rawUrl, content: "", mime, status: response.status, error: `HTTP ${response.status} ${response.statusText}`.trim() };
    }

    if (args.mode === "raw") {
      if (!isTextual(mime) && mime !== "") {
        return { url: rawUrl, content: "", mime, status: response.status, error: `Cannot return ${mime} as raw text` };
      }
      const bytes = finishReceiving(await readCapped(response, maxBytes, keepAlive, timeout.signal));
      return { url: rawUrl, content: decodeBody(bytes, contentType), mime, status: response.status };
    }

    if (isPdf(rawUrl, contentType)) {
      if (args.pdf?.enabled === false) {
        return { url: rawUrl, content: "", mime, status: response.status, error: "PDF extraction is disabled" };
      }
      const pdfMax = args.maxBytes ?? (args.pdf?.maxSizeMB ? args.pdf.maxSizeMB * 1024 * 1024 : MAX_PDF_BYTES);
      const bytes = finishReceiving(await readCapped(response, pdfMax, keepAlive, timeout.signal));
      const { markdown } = await pdfToMarkdown(bytes, rawUrl, args.pdf?.maxPages ?? 100);
      return { url: rawUrl, content: markdown, mime: "application/pdf", status: response.status };
    }

    if (isHtml(mime) || mime === "") {
      const bytes = finishReceiving(await readCapped(response, maxBytes, keepAlive, timeout.signal));
      const html = decodeBody(bytes, contentType);
      const { title, markdown } = await htmlToMarkdown(html, rawUrl);
      return { url: rawUrl, title, content: markdown, mime: mime || "text/html", status: response.status };
    }

    if (isTextual(mime)) {
      const bytes = finishReceiving(await readCapped(response, maxBytes, keepAlive, timeout.signal));
      return { url: rawUrl, content: decodeBody(bytes, contentType), mime, status: response.status };
    }

    return { url: rawUrl, content: "", mime, status: response.status, error: `Unsupported content type: ${mime}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = timeout.signal.aborted && !args.signal?.aborted;
    const stalled = `Timed out fetching ${rawUrl} (no data for ${formatDuration(idleMs)})`;
    return { url: rawUrl, content: "", mime: "", status: 0, error: timedOut ? stalled : message };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
  }
}
