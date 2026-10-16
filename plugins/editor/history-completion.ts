import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map(part => part.text)
    .join("\n")
    .trim();
}

export function historySuggestion(history: readonly string[], prefix: string): string | undefined {
  if (!prefix || prefix.trimStart().startsWith("/")) return undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const historical = history[index];
    if (historical?.startsWith(prefix) && historical.length > prefix.length) return historical.slice(prefix.length);
  }
  return undefined;
}

export default function registerHistoryCompletion(pi: ExtensionAPI): (prefix: string) => string | undefined {
  let history: string[] = [];
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    history = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const text = messageText(entry.message.content);
      if (text) history.push(text);
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "user") return;
    const text = messageText(event.message.content);
    if (text) history.push(text);
  });
  return prefix => historySuggestion(history, prefix);
}
