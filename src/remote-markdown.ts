import { Marked } from "marked";
import { renderFitted } from "./mermaid.ts";
import { formatSize, mentionedFolders, resolveMention, type MentionContext } from "./remote-files.ts";

// Phone column width in monospace cells; wider diagrams scroll horizontally.
const phoneColumns = 44;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

// Set only during one synchronous parse: where relative file names in this message may live.
let mentionContext: MentionContext | undefined;
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
  image(token) { return `<span class="image-reference">Image: ${escapeHtml(token.text || "untitled")}</span>`; },
} });

/** With `files`, existing Mac paths in inline code and links render as file chips. */
export function renderRemoteMarkdown(text: string, files?: MentionContext): string {
  mentionContext = files ? { ...files, dirs: [...(files.dirs ?? []), ...mentionedFolders(text, files)] } : undefined;
  try { return parser.parse(text, { async: false }) as string; } finally { mentionContext = undefined; }
}
