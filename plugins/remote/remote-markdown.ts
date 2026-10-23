import { Marked } from "marked";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { renderFitted } from "../core/mermaid.ts";
import { formatSize, mentionedFolders, resolveMention, type MentionContext } from "./remote-files.ts";

// Phone column width in monospace cells; wider diagrams scroll horizontally.
const phoneColumns = 44;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

// Set only during one synchronous parse: where relative file names in this message may live.
let mentionContext: MentionContext | undefined;
let inlineMode = false;

/* A picture named in a message goes the same way as one Pi viewed with a tool: its bytes are sent to the hub
   with the transcript (media), so the phone shows and opens it at once, with no chunked file download. */
export interface InlineMedia { id: string; mimeType: string; data: string }
const MAX_INLINE = 1_200_000;
const inlineByFile = new Map<string, InlineMedia | null>(), recentMedia = new Map<string, InlineMedia>();
const mimeOf = (p: string) => /\.png$/i.test(p) ? "image/png" : /\.jpe?g$/i.test(p) ? "image/jpeg" : /\.webp$/i.test(p) ? "image/webp" : /\.gif$/i.test(p) ? "image/gif" : undefined;
export function inlineImage(path: string): InlineMedia | undefined {
  let key: string; try { const st = statSync(path); key = `${path}:${st.size}:${st.mtimeMs}`; } catch { return undefined; }
  if (inlineByFile.has(key)) return inlineByFile.get(key) ?? undefined;
  let mimeType = mimeOf(path), data: string | undefined;
  try {
    const raw = readFileSync(path);
    if (mimeType && raw.length * 4 / 3 <= MAX_INLINE) data = raw.toString("base64");
    else {
      // Too big for one relay frame (or HEIC/TIFF): a phone-sized JPEG copy, made once per file version.
      const out = execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1600", path, "--out", "/dev/stdout"], { maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      if (out.length * 4 / 3 <= MAX_INLINE) { data = out.toString("base64"); mimeType = "image/jpeg"; }
    }
  } catch {}
  const media = data && mimeType ? { id: createHash("sha256").update(mimeType).update(data).digest("hex"), mimeType, data } : undefined;
  inlineByFile.set(key, media ?? null);
  if (inlineByFile.size > 200) inlineByFile.delete(inlineByFile.keys().next().value!);
  return media;
}
/** Pictures rendered from message paths, newest last; the remote plugin uploads them with the transcript. */
export function markdownMedia(): InlineMedia[] { return [...recentMedia.values()]; }
const fileIcons: Record<string, string> = { folder: "📁", pdf: "📕", word: "📝", video: "🎬", audio: "🎵", image: "🖼", sheet: "📊", slides: "📽", markdown: "📄", text: "📄", other: "📎" };
/** A Mac file or folder mentioned in chat becomes a tappable chip, only if it exists and may be served. */
function fileChip(raw: string): string | undefined {
  if (!mentionContext) return undefined;
  const file = resolveMention(raw, mentionContext);
  if (!file) return undefined;
  return `<button type="button" class="file-chip" data-file="${escapeHtml(file.path)}" data-kind="${file.kind}"><span class="file-icon" aria-hidden="true">${fileIcons[file.kind]}</span><span class="file-name">${escapeHtml(file.name)}</span>${file.dir ? "" : `<small>${formatSize(file.size)}</small>`}</button>`;
}

// The rendered HTML is inserted into the phone UI. Never let Markdown supply raw HTML,
// arbitrary protocols, image fetches, or attributes. Conversation images use the
// separate encrypted media path, not Markdown's network-addressable image syntax.
const parser = new Marked({ renderer: {
  html({ text }) { return escapeHtml(text); },
  link(token) {
    const label = this.parser.parseInline(token.tokens);
    let url: URL;
    try { url = new URL(token.href); } catch { let path = token.href; try { path = decodeURIComponent(path); } catch {} return fileChip(path) ?? label; }
    if (url.protocol === "file:") return fileChip(token.href) ??  `<span class="local-link">${label}<small>Mac only</small></span>`;
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return label;
    return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
  codespan(token) {
    const raw = token.text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return fileChip(raw) ?? `<code>${escapeHtml(raw)}</code>`;
  },
  code(token) {
    const language = (token.lang || "").trim().split(/\s+/)[0];
    if (language === "mermaid") {
      try {
        const art = renderFitted(token.text, phoneColumns);
        if (!art.warnings.length && art.plain.length) return `<figure class="diagram" aria-label="Mermaid diagram"><pre>${escapeHtml(art.plain.join("\n"))}</pre></figure>`;
      } catch {}
      return `<figure class="diagram failed"><figcaption>Diagram could not be drawn; source:</figcaption><pre><code>${escapeHtml(token.text)}</code></pre></figure>`;
    }
    return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(token.text)}</code></pre>`;
  },
  table(token) {
    const cell = (c: any, tag: string) => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
    return `<div class="table-scroll" tabindex="0"><table><thead><tr>${token.header.map((c: any) => cell(c, "th")).join("")}</tr></thead><tbody>${token.rows.map((r: any[]) => `<tr>${r.map(c => cell(c, "td")).join("")}</tr>`).join("")}</tbody></table></div>`;
  },
  image(token) {
    let raw = token.href; try { raw = decodeURIComponent(raw); } catch {}
    const file = mentionContext && !/^[a-z]+:/i.test(raw) ? resolveMention(raw, mentionContext) : undefined;
    if (file && !file.dir && file.kind === "video") return `<video class="md-image md-video" data-src-path="${escapeHtml(file.path)}" controls playsinline preload="metadata" aria-label="${escapeHtml(token.text || file.name)}"></video>`;
    if (file && !file.dir && file.kind === "pdf") return `<img class="md-image md-pdf" data-pdf-path="${escapeHtml(file.path)}" alt="${escapeHtml(token.text || file.name)}">`;
    if (file && !file.dir && file.kind === "image") {
      const m = inlineMode ? inlineImage(file.path) : undefined;
      if (m) {
        recentMedia.delete(m.id); recentMedia.set(m.id, m);
        if (recentMedia.size > 24) recentMedia.delete(recentMedia.keys().next().value!);
        return `<button type="button" class="image-card" data-image="${m.id}" aria-label="View ${escapeHtml(token.text || file.name)}"><span>Loading image…</span></button>`;
      }
      return `<img class="md-image" data-src-path="${escapeHtml(file.path)}" alt="${escapeHtml(token.text || file.name)}">`;
    }
    return `<span class="image-reference">Image: ${escapeHtml(token.text || "untitled")}</span>`;
  },
} });

/** With `files`, existing Mac paths in inline code and links render as file chips. */
/** `inline`: chat messages, whose pictures travel with the transcript (see inlineImage). */
export function renderRemoteMarkdown(text: string, files?: MentionContext, o: { inline?: boolean } = {}): string {
  inlineMode = !!o.inline;
  mentionContext = files ? { ...files, dirs: [...(files.dirs ?? []), ...mentionedFolders(text, files)] } : undefined;
  try { return parser.parse(text, { async: false }) as string; } finally { mentionContext = undefined; inlineMode = false; }
}
