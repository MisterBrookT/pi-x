import { Marked } from "marked";
import { renderFitted } from "./mermaid.ts";

// Phone column width in monospace cells; wider diagrams scroll horizontally.
const phoneColumns = 44;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

// The rendered HTML is inserted into the phone UI. Never let Markdown supply raw HTML,
// arbitrary protocols, image fetches, or attributes. Conversation images use the
// separate encrypted media path, not Markdown's network-addressable image syntax.
const parser = new Marked({ renderer: {
  html({ text }) { return escapeHtml(text); },
  link(token) {
    const label = this.parser.parseInline(token.tokens);
    let url: URL;
    try { url = new URL(token.href); } catch { return label; }
    if (url.protocol === "file:") return `<span class="local-link">${label}<small>Mac only</small></span>`;
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return label;
    return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
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

export function renderRemoteMarkdown(text: string): string {
  return parser.parse(text, { async: false }) as string;
}
