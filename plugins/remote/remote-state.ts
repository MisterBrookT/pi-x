// Converts Pi transcript messages into the compact shape the remote-control web app renders.
import { createHash } from "node:crypto";
import { renderRemoteMarkdown } from "./remote-markdown.ts";
import type { MentionContext } from "./remote-files.ts";

export interface RemoteImage { id: string; mimeType: string }
export interface RemoteMedia extends RemoteImage { data: string }
export const maxImageBase64 = 1_200_000; // Encrypted relay frames must stay below 2 MB.
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function imageRef(part: any): RemoteImage | undefined {
  if (part?.type !== "image" || !imageTypes.has(part.mimeType) || typeof part.data !== "string"
    || !part.data.length || part.data.length > maxImageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) return;
  return { id: createHash("sha256").update(part.mimeType).update(part.data).digest("hex"), mimeType: part.mimeType };
}
const imagesOf = (content: unknown): RemoteImage[] => Array.isArray(content)
  ? content.filter((part: any) => part?.type === "image").flatMap((part: any) => { const ref = imageRef(part); return ref ? [ref] : []; }) : [];

/** Image bytes stay on the authenticated Mac hub; transcript snapshots carry only references. */
export function remoteMedia(messages: readonly any[]): RemoteMedia[] {
  const media = new Map<string, RemoteMedia>();
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "toolResult") continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const ref = imageRef(part);
      if (ref) media.set(ref.id, { ...ref, data: part.data });
    }
  }
  return [...media.values()];
}

export interface RemoteTool {
  id: string;
  name: string;
  input?: string;
  label?: string;
  output?: string;
  isError?: boolean;
  images?: RemoteImage[];
}

export interface RemoteBackground {
  /** "subagent" cards come from pi-subagents completion notices; absent means a pix background shell job. */
  kind?: "subagent";
  id: string;
  /** Short agent name(s) shown instead of "Job <id>". */
  name?: string;
  state: "running" | "completed" | "failed" | "stopped" | "paused";
  command: string;
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface RemoteMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  html?: string;
  tools?: RemoteTool[];
  background?: RemoteBackground;
  images?: RemoteImage[];
  timestamp: number;
}

const clip = (text: string, limit = 12_000) => (text.length > limit ? `${text.slice(0, limit)}\n… truncated` : text);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" ? part.text : part?.type === "image" && !imageRef(part) ? "[image too large or unsupported]" : ""))
    .filter(Boolean)
    .join("\n");
}

function toolLabel(args: any): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = [args.path, args.command, args.query, args.url, args.task, args.description].find(item => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 120) : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// pi-subagents sends "subagent-notify" without details; its first line is the stable header from formatSingleCompletion/formatGroupedCompletion.
const subagentHeader = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/;
const subagentGroupHeader = /^Background tasks (completed) \((\d+)\): (.+)$/;
function subagentBackground(text: string): RemoteBackground | undefined {
  const [first = "", ...rest] = text.split("\n");
  const body = rest.join("\n").trim();
  const single = first.match(subagentHeader);
  if (single) return { kind: "subagent", id: "", name: single[2], state: single[1] as RemoteBackground["state"], command: single[3] ?? "", output: clip(body, 4_000), truncated: body.length > 4_000 };
  const group = first.match(subagentGroupHeader);
  if (group) return { kind: "subagent", id: "", name: group[3].replace(/\*\*/g, "").slice(0, 240), state: "completed", command: `${group[2]} tasks`, output: clip(body, 4_000), truncated: body.length > 4_000 };
  return undefined;
}

const escapeText = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/**
 * A loop task Pix itself wrote (card answer or handoff, from proactive-store) reads as one short line on
 * screen: the loop and what brook picked; the full prompt stays in the message and behind Details.
 * Only Pix's own prompt shapes match, so brook's own prose is never folded.
 */
export function loopPromptSummary(text: string): { title: string; you?: string } | undefined {
	const body = /^(?:\(Picked up again[^\n]*\n\n)?A proactive loop from [^\n]*:\n\n\*\*(.+)\*\*\nWhy: /m;
	const tapped = text.match(/^brook tapped "(.+?)" on loop [\w-]+\./), own = text.match(/^brook answered loop [\w-]+ with his own instruction\. Do this instead of the suggested step:\n([\s\S]*?)\n\n\(The loop, for context:\)\n/);
	const head = tapped || own;
	if (!head && !/^(?:\(Picked up again[^\n]*\n\n)?A proactive loop from /.test(text)) return undefined;
	const title = text.match(body)?.[1] ?? text.match(/^\*\*(.+)\*\*\nWhy: /m)?.[1];
	if (!title || !/\nWhen you stop, record where the loop stands/.test(text)) return undefined;
	return { title, ...(head ? { you: head[1] } : {}) };
}
/** Pix's own loop prompts go into Pi as this custom message: the model reads the full text, screens show one line. */
export const LOOP_MESSAGE = "pix-loop";
export const loopMessage = (text: string) => {
	const s = loopPromptSummary(text);
	return s ? { customType: LOOP_MESSAGE, content: text, display: true, details: s } : undefined;
};
const loopPromptHtml = (s: { title: string; you?: string }, text: string) => `<p><b>${escapeText(s.title)}</b>${s.you ? `<br>You: ${escapeText(s.you)}` : ""}</p><details class="loop-ctx"><summary>Details</summary><pre>${escapeText(text)}</pre></details>`;

/** Build remote messages from Pi agent messages; tool results attach to the assistant call that produced them. */
export function remoteMessages(messages: readonly any[], files?: MentionContext): RemoteMessage[] {
  const result: RemoteMessage[] = [];
  const tools = new Map<string, RemoteTool>();
  messages.forEach((message, index) => {
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : 0;
    const id = `${timestamp}-${index}`;
    if (message?.role === "user") {
      const text = textOf(message.content);
      const images = imagesOf(message.content);
      const loop = loopPromptSummary(text);
      if (text || images.length) result.push({ id, role: "user", text: clip(text), html: loop ? loopPromptHtml(loop, clip(text)) : renderRemoteMarkdown(clip(text), files), images: images.length ? images : undefined, timestamp });
    } else if (message?.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const calls: RemoteTool[] = parts
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => ({ id: String(part.id), name: String(part.name), input: clip(stringify(part.arguments), 2_000), label: toolLabel(part.arguments) }));
      for (const call of calls) tools.set(call.id, call);
      const text = textOf(parts);
      const error = message.stopReason === "error" && message.errorMessage ? `Error: ${message.errorMessage}` : "";
      if (text || calls.length || error) result.push({ id, role: "assistant", text: clip(text || error), html: renderRemoteMarkdown(clip(text || error), files), tools: calls.length ? calls : undefined, timestamp });
    } else if (message?.role === "toolResult") {
      const call = tools.get(String(message.toolCallId));
      if (call) {
        call.output = clip(textOf(message.content), 4_000);
        call.isError = Boolean(message.isError);
        const images = imagesOf(message.content);
        if (images.length) call.images = images;
      }
    } else if (message?.role === "custom" && message.customType === LOOP_MESSAGE) {
      const text = textOf(message.content);
      const loop = loopPromptSummary(text);
      if (text) result.push({ id, role: "user", text: clip(text), html: loop ? loopPromptHtml(loop, clip(text)) : renderRemoteMarkdown(clip(text)), timestamp });
    } else if (message?.role === "custom" && message.display !== false) {
      const text = textOf(message.content);
      if (!text) return;
      const details = message.customType === "pix-background" ? message.details : undefined;
      const valid = details && typeof details.id === "string" && ["running", "completed", "failed", "stopped"].includes(details.state)
        && typeof details.command === "string" && typeof details.output === "string";
      const background: RemoteBackground | undefined = message.customType === "subagent-notify" ? subagentBackground(text) : valid ? {
        id: details.id, state: details.state, command: clip(details.command, 240), output: clip(details.output, 4_000),
        truncated: Boolean(details.truncated), ...(typeof details.fullOutputPath === "string" ? { fullOutputPath: details.fullOutputPath } : {}),
      } : undefined;
      result.push({ id, role: "system", text: clip(text), html: background ? undefined : renderRemoteMarkdown(clip(text)), background, timestamp });
    }
  });
  return result;
}

/** Visible messages on the active branch, including Pi's custom_message session entries. */
export function branchMessages(entries: readonly any[]): any[] {
  return entries.flatMap((entry) => {
    if (entry?.type === "message") return [entry.message];
    if (entry?.type === "custom_message" && entry.display !== false) return [{
      role: "custom", customType: entry.customType, content: entry.content,
      display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) || 0,
    }];
    return [];
  });
}
