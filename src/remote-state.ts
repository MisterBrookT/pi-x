// Converts Pi transcript messages into the compact shape the remote-control web app renders.
import { createHash } from "node:crypto";
import { renderRemoteMarkdown } from "./remote-markdown.ts";

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
  id: string;
  state: "running" | "completed" | "failed" | "stopped";
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

/** Build remote messages from Pi agent messages; tool results attach to the assistant call that produced them. */
export function remoteMessages(messages: readonly any[]): RemoteMessage[] {
  const result: RemoteMessage[] = [];
  const tools = new Map<string, RemoteTool>();
  messages.forEach((message, index) => {
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : 0;
    const id = `${timestamp}-${index}`;
    if (message?.role === "user") {
      const text = textOf(message.content);
      const images = imagesOf(message.content);
      if (text || images.length) result.push({ id, role: "user", text: clip(text), html: renderRemoteMarkdown(clip(text)), images: images.length ? images : undefined, timestamp });
    } else if (message?.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const calls: RemoteTool[] = parts
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => ({ id: String(part.id), name: String(part.name), input: clip(stringify(part.arguments), 2_000), label: toolLabel(part.arguments) }));
      for (const call of calls) tools.set(call.id, call);
      const text = textOf(parts);
      const error = message.stopReason === "error" && message.errorMessage ? `Error: ${message.errorMessage}` : "";
      if (text || calls.length || error) result.push({ id, role: "assistant", text: clip(text || error), html: renderRemoteMarkdown(clip(text || error)), tools: calls.length ? calls : undefined, timestamp });
    } else if (message?.role === "toolResult") {
      const call = tools.get(String(message.toolCallId));
      if (call) {
        call.output = clip(textOf(message.content), 4_000);
        call.isError = Boolean(message.isError);
        const images = imagesOf(message.content);
        if (images.length) call.images = images;
      }
    } else if (message?.role === "custom" && message.display !== false) {
      const text = textOf(message.content);
      if (!text) return;
      const details = message.customType === "pix-background" ? message.details : undefined;
      const valid = details && typeof details.id === "string" && ["running", "completed", "failed", "stopped"].includes(details.state)
        && typeof details.command === "string" && typeof details.output === "string";
      const background: RemoteBackground | undefined = valid ? {
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
