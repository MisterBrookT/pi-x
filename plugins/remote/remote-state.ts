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
  /** Set when the call read a skill's SKILL.md: shown as "Skill loaded", not as a plain read. */
  skill?: { name: string; description: string };
}

export interface RemoteBackground {
  /** "subagent" cards come from pi-subagents completion notices; absent means a pix background shell job. */
  kind?: "subagent";
  id: string;
  /** Short agent name(s) shown instead of "Job <id>". */
  name?: string;
  state: "running" | "completed" | "failed" | "stopped" | "paused" | "detached";
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

const skillPath = /(?:^|\/)([^/]+)\/SKILL\.md$/;
/** A read of `<name>/SKILL.md` is a skill load; name and description come from its frontmatter when present. */
function skillOf(name: string, args: any, output: string): RemoteTool["skill"] {
  const path = name === "read" && typeof args?.path === "string" ? args.path : "";
  const dir = path.match(skillPath)?.[1];
  if (!dir) return undefined;
  const front = output.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const field = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
  return { name: field("name") || dir, description: field("description").slice(0, 240) };
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
  // A Pi reload ends only the parent tracker; its async children keep running. Say so instead of a bare "stopped".
  if (single && single[1] === "stopped" && /replaced or reloaded/.test(body)) {
    const done = (body.match(/status=completed/g) || []).length, total = (body.match(/^- key=/gm) || []).length;
    return { kind: "subagent", id: "", name: single[2], state: "detached", command: `tracker ended by a Pi reload; helpers kept working${total ? `, ${done}/${total} done when it ended` : ""}`, output: clip(body, 4_000), truncated: body.length > 4_000 };
  }
  if (single) return { kind: "subagent", id: "", name: single[2], state: single[1] as RemoteBackground["state"], command: single[3] ?? "", output: clip(body, 4_000), truncated: body.length > 4_000 };
  const group = first.match(subagentGroupHeader);
  if (group) return { kind: "subagent", id: "", name: group[3].replace(/\*\*/g, "").slice(0, 240), state: "completed", command: `${group[2]} tasks`, output: clip(body, 4_000), truncated: body.length > 4_000 };
  return undefined;
}

const escapeText = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
import { LOOP_MESSAGE, loopMessage, loopPromptSummary, quietSummary } from "../core/loop-message.ts";
export { LOOP_MESSAGE, loopMessage, loopPromptSummary };
const quietHtml = (line: string, text: string) => `<details class="loop-ctx quiet"><summary>${escapeText(line)}</summary><pre>${escapeText(text)}</pre></details>`;
const loopPromptHtml = (s: { title: string; you?: string }, text: string) => `<p><b>${escapeText(s.title)}</b>${s.you ? `<br>You: ${escapeText(s.you)}` : ""}</p><details class="loop-ctx"><summary>Details</summary><pre>${escapeText(text)}</pre></details>`;

/** Build remote messages from Pi agent messages; tool results attach to the assistant call that produced them. */
/** `from`: skip (not render) messages before this index; ids keep their full-branch index so they stay stable. */
export function remoteMessages(messages: readonly any[], files?: MentionContext, from = 0): RemoteMessage[] {
  const result: RemoteMessage[] = [];
  const tools = new Map<string, RemoteTool>();
  const args = new Map<string, any>();
  messages.forEach((message, index) => {
    if (index < from) return;
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : 0;
    const id = `${timestamp}-${index}`;
    if (message?.role === "user") {
      const text = textOf(message.content);
      const images = imagesOf(message.content);
      const loop = loopPromptSummary(text), quiet = !loop && !images.length ? quietSummary(text) : undefined;
      if (quiet) { result.push({ id, role: "system", text: clip(text), html: quietHtml(quiet, clip(text)), timestamp }); return; }
      // "/skill:name args" arrives expanded as <skill name location>body</skill> then the args: show a skill row plus what was typed.
      const sk = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/);
      if (sk) {
        const desc = (sk[3].match(/^#\s+.+\n\n([^\n]+)/m)?.[1] ?? "").slice(0, 200);
        result.push({ id: id + "-skill", role: "system", text: `Skill ${sk[1]}`, html: `<div class="skill-row"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/></svg><span>Skill</span><b>${escapeText(sk[1])}</b>${desc ? `<small>${escapeText(desc)}</small>` : ""}</div>`, timestamp });
        const typed = (sk[4] ?? "").trim();
        if (typed || images.length) result.push({ id, role: "user", text: clip(typed), html: renderRemoteMarkdown(clip(typed), files, { inline: true }), images: images.length ? images : undefined, timestamp });
        return;
      }
      if (text || images.length) result.push({ id, role: "user", text: clip(text), html: loop ? loopPromptHtml(loop, clip(text)) : renderRemoteMarkdown(clip(text), files, { inline: true }), images: images.length ? images : undefined, timestamp });
    } else if (message?.role === "assistant") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const calls: RemoteTool[] = parts
        .filter((part: any) => part?.type === "toolCall")
        .map((part: any) => ({ id: String(part.id), name: String(part.name), input: clip(stringify(part.arguments), 2_000), label: toolLabel(part.arguments) }));
      for (const call of calls) tools.set(call.id, call);
      for (const part of parts) if (part?.type === "toolCall") args.set(String(part.id), part.arguments);
      const text = textOf(parts);
      const error = message.stopReason === "error" && message.errorMessage ? `Error: ${message.errorMessage}` : "";
      if (!calls.length && !error && /^\s*No change\.?\s*$/i.test(text)) return;
      if (text || calls.length || error) result.push({ id, role: "assistant", text: clip(text || error), html: renderRemoteMarkdown(clip(text || error), files, { inline: true }), tools: calls.length ? calls : undefined, timestamp });
    } else if (message?.role === "toolResult") {
      const call = tools.get(String(message.toolCallId));
      if (call) {
        call.output = clip(textOf(message.content), 4_000);
        call.isError = Boolean(message.isError);
        const skill = call.isError ? undefined : skillOf(call.name, args.get(call.id), textOf(message.content));
        if (skill) call.skill = skill;
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
      const quiet = quietSummary(text);
      if (quiet) { result.push({ id, role: "system", text: clip(text), html: quietHtml(quiet, clip(text)), timestamp }); return; }
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
