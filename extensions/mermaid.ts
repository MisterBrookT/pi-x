import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { colorize, renderFitted } from "../src/mermaid.ts";

/**
 * Render ```mermaid blocks with the current `lovely-mermaid` instead of the
 * older parser pi bundles, which drops valid diagrams (HTML entities, `<br/>`
 * in edge labels). Runs before pi's own mermaid pass and replaces the block
 * with a plain code block, so pi has nothing left to reject.
 *
 * A diagram too wide for the pane is re-laid out top-down before giving up,
 * since models habitually emit `flowchart LR` regardless of terminal width.
 *
 * `classDef` colours are kept, because a legend like "green = done, yellow =
 * open question" is unreadable once every box looks the same.
 *
 * Pi's `markdown.mermaid` setting still applies: `off` leaves blocks alone
 * and `final` waits for the finished message.
 */

const FENCE = /^(\s*)(`{3,}|~{3,})\s*mermaid\b[^\n]*\n([\s\S]*?)\n\1\2[ \t]*$/gm;

export function transformMermaidBlocks(markdown: string, availableWidth: number): string {
  if (!markdown.includes("mermaid")) return markdown;
  return markdown.replace(FENCE, (raw, indent: string, _fence: string, src: string) => {
    const art = renderFitted(src, availableWidth);
    if (art.warnings.length > 0 || art.plain.length === 0 || art.width > availableWidth) return raw;
    return `${indent}\`\`\`text\n${colorize(art).map((line) => indent + line).join("\n")}\n${indent}\`\`\``;
  });
}

type Mode = "off" | "final" | "streaming";

/** Pi's own `markdown.mermaid` setting, read once per session. */
function readMode(): Mode {
  try {
    const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
    const mode = JSON.parse(raw)?.markdown?.mermaid;
    return mode === "off" || mode === "final" ? mode : "streaming";
  } catch {
    return "streaming";
  }
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = readMode();
  pi.on("session_start", () => { mode = readMode(); });
  pi.registerMarkdownTransformer((markdown, { messageType, isStreaming, availableWidth }) => {
    if (messageType === "assistant-thinking") return markdown;
    if (mode === "off") return markdown;
    if (isStreaming && mode !== "streaming") return markdown;
    return transformMermaidBlocks(markdown, availableWidth);
  });
}
