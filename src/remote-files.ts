// Mac files the phone may open: paths mentioned in chat and the Files panel. Every path the
// phone names is resolved and checked again here; nothing outside home or sensitive is served.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { remoteMemoryRoot } from "./remote-mac.ts";

export const fileChunkBytes = 512 * 1024; // base64 ≈ 700 KB, well inside a 2 MB relay frame
export const mediaFileLimit = 50 * 1024 * 1024;
export const otherFileLimit = 20 * 1024 * 1024;
export const previewSourceLimit = 10 * 1024 * 1024;

export type RemoteFileKind = "folder" | "pdf" | "word" | "video" | "audio" | "image" | "sheet" | "slides" | "markdown" | "text" | "other";
export interface RemoteFileInfo { path: string; name: string; kind: RemoteFileKind; size: number; mimeType: string }

const types: Record<string, [RemoteFileKind, string]> = {
  pdf: ["pdf", "application/pdf"],
  docx: ["word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], doc: ["word", "application/msword"],
  rtf: ["word", "application/rtf"], odt: ["word", "application/vnd.oasis.opendocument.text"], pages: ["word", "application/vnd.apple.pages"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], mov: ["video", "video/quicktime"], webm: ["video", "video/webm"],
  m4a: ["audio", "audio/mp4"], mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], aac: ["audio", "audio/aac"],
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], gif: ["image", "image/gif"], webp: ["image", "image/webp"], heic: ["image", "image/heic"],
  xlsx: ["sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], xls: ["sheet", "application/vnd.ms-excel"], numbers: ["sheet", "application/vnd.apple.numbers"], csv: ["sheet", "text/csv"],
  pptx: ["slides", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], ppt: ["slides", "application/vnd.ms-powerpoint"], key: ["slides", "application/vnd.apple.keynote"],
  md: ["markdown", "text/markdown"], markdown: ["markdown", "text/markdown"],
};
const textExtensions = new Set("txt log json jsonl yaml yml toml ini xml html css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs sh zsh bash sql tex bib r lua php".split(" "));

export function fileType(path: string): { kind: RemoteFileKind; mimeType: string } {
  const ext = extname(path).slice(1).toLowerCase();
  const known = types[ext];
  if (known) return { kind: known[0], mimeType: known[1] };
  if (textExtensions.has(ext)) return { kind: "text", mimeType: "text/plain" };
  return { kind: "other", mimeType: "application/octet-stream" };
}

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const secretName = /credential|secret|token|passw(or)?d|api[-_ ]?key|private[-_ ]?key|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|p12|pfx|keychain|keychain-db|kdbx|gpg|asc)$|(^|[-_. ])keys?([-_. ]|$)/i;

/** Keynote documents use .key too; those are zip files or bundles, never PEM text. */
function keynoteDocument(path: string): boolean {
  if (extname(path).toLowerCase() !== ".key") return false;
  try {
    if (statSync(path).isDirectory()) return true;
    const fd = openSync(path, "r"), head = Buffer.alloc(4);
    try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch { return false; }
}

/** True when a home-relative path must never reach the phone. */
export function refusedPath(real: string, home: string, hubRoot: string): boolean {
  const parts = relative(home, real).split(sep).filter(Boolean);
  if (parts.some(p => p.startsWith(".") || p === "..")) return true;
  if (parts[0] === "Library" && parts[1] === "Keychains") return true;
  if (parts.some((p, i) => secretName.test(p) && !(i === parts.length - 1 && keynoteDocument(real)))) return true;
  let hub = hubRoot;
  try { hub = realpathSync(hubRoot); } catch {}
  if (inside(hub, real) && relative(hub, real).split(sep).includes("private")) return true;
  return false;
}

export interface FileRoots { home?: string; hubRoot?: string }

/** Resolve a phone- or chat-named path to a real, allowed file or folder inside home. */
export function checkRemotePath(path: unknown, roots: FileRoots = {}): (RemoteFileInfo & { dir: boolean }) | undefined {
  if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) return undefined;
  try {
    const home = realpathSync(roots.home ?? homedir());
    if (path.split(sep).some(p => p.startsWith(".") && p !== "")) return undefined;
    const real = realpathSync(path);
    if (!inside(home, real) || refusedPath(real, home, roots.hubRoot ?? remoteMemoryRoot())) return undefined;
    const st = statSync(real);
    const dir = st.isDirectory() && !(extname(real).toLowerCase() === ".key" || extname(real).toLowerCase() === ".pages" || extname(real).toLowerCase() === ".numbers");
    if (!dir && !st.isFile()) return undefined;
    const type = dir ? { kind: "folder" as const, mimeType: "" } : fileType(real);
    return { path: real, name: basename(real) || real, dir, size: dir ? 0 : st.size, ...type };
  } catch { return undefined; }
}

export function fileLimit(kind: RemoteFileKind) { return kind === "video" || kind === "audio" ? mediaFileLimit : otherFileLimit; }

export function listRemoteFiles(path: unknown, roots: FileRoots = {}) {
  const home = realpathSync(roots.home ?? homedir());
  const folder = checkRemotePath(path || home, roots);
  if (!folder?.dir) return undefined;
  let names: string[];
  try { names = readdirSync(folder.path); } catch { return undefined; }
  const entries = names.filter(n => !n.startsWith(".")).flatMap(n => { const e = checkRemotePath(join(folder.path, n), roots); return e ? [{ name: n, path: join(folder.path, n), dir: e.dir, size: e.size, kind: e.kind }] : []; })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 1000);
  return { path: folder.path, home, parent: folder.path === home ? undefined : dirname(folder.path), entries };
}

/** One base64 slice of an allowed file; the phone asks again with the next offset until done. */
export function readRemoteChunk(path: unknown, offset: number, roots: FileRoots = {}) {
  const file = checkRemotePath(path, roots);
  if (!file || file.dir) return { error: "file unavailable", status: 404 } as const;
  if (file.size > fileLimit(file.kind)) return { error: `File is too large to open on the phone (${formatSize(file.size)})`, status: 413 } as const;
  const start = Math.max(0, Math.floor(offset) || 0);
  const length = Math.max(0, Math.min(fileChunkBytes, file.size - start));
  const buffer = Buffer.alloc(length);
  const fd = openSync(file.path, "r");
  try { readSync(fd, buffer, 0, length, start); } finally { closeSync(fd); }
  return { status: 200, path: file.path, name: file.name, kind: file.kind, mimeType: file.mimeType, size: file.size, offset: start, data: buffer.toString("base64"), done: start + length >= file.size } as const;
}

export const editableLimit = 1_000_000; // a long essay is ~100 KB; keeps a save inside one relay frame
const sourceHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Open an existing Markdown or text file as UTF-8 for the phone editor. */
export function readEditable(path: unknown, roots: FileRoots = {}) {
  const file = checkRemotePath(path, roots);
  if (!file || file.dir || (file.kind !== "markdown" && file.kind !== "text")) return { status: 404, error: "This file can't be edited on the phone" } as const;
  if (file.size > editableLimit) return { status: 413, error: `File is too large to edit on the phone (${formatSize(file.size)})` } as const;
  const text = readFileSync(file.path, "utf8");
  return { status: 200, path: file.path, name: file.name, kind: file.kind, text, hash: sourceHash(text) } as const;
}

/** Save phone edits to an existing Markdown or text file. A file that changed since it was opened is
 * refused with 409 unless force is set, so a Mac edit is never silently overwritten. Writes are atomic. */
export function saveEditable(input: { path?: unknown; text?: unknown; hash?: unknown; force?: unknown }, roots: FileRoots = {}) {
  if (typeof input.text !== "string" || Buffer.byteLength(input.text) > editableLimit) return { status: 400, error: "Invalid or oversized text" } as const;
  const opened = readEditable(input.path, roots);
  if (opened.status !== 200) return { status: 404, error: "This file can't be saved from the phone" } as const;
  if (input.force !== true && input.hash !== opened.hash) return { status: 409, error: "This file changed on the Mac since you opened it", hash: opened.hash } as const;
  const tmp = join(dirname(opened.path), `.${opened.name}.pix-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, input.text, { mode: statSync(opened.path).mode });
  renameSync(tmp, opened.path);
  return { status: 200, path: opened.path, hash: sourceHash(input.text) } as const;
}

const keptTags = new Set("p br b strong i em u s strike h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th blockquote pre code sub sup hr div span".split(" "));
/** Allowlist HTML: known tags only, no attributes except numeric colspan/rowspan, no scripts, styles or resources. */
export function sanitizeDocumentHtml(html: string): string {
  const body = html.replace(/<(script|style|head|title|iframe|object|svg|math|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  return body.replace(/<[^>]*>?/g, tag => {
    const m = tag.match(/^<(\/?)([a-zA-Z0-9]+)([^>]*)>$/);
    if (!m) return "";
    const name = m[2].toLowerCase();
    if (!keptTags.has(name)) return "";
    if (m[1]) return `</${name}>`;
    const spans = [...m[3].matchAll(/\b(colspan|rowspan)\s*=\s*["']?(\d{1,3})/gi)].map(a => ` ${a[1].toLowerCase()}="${a[2]}"`).join("");
    return `<${name}${spans}>`;
  }).replace(/<p><span><br><\/span><\/p>|<p><span><\/span><br><\/p>/g, "");
}

/** macOS textutil turns Word, RTF and OpenDocument text into HTML without extra dependencies. */
export function convertDocument(path: string): Promise<string> {
  return new Promise((resolve, reject) => execFile("textutil", ["-convert", "html", "-stdout", path], { timeout: 20_000, maxBuffer: 20_000_000 },
    (error, stdout) => error ? reject(Error("This document cannot be previewed on the Mac")) : resolve(sanitizeDocumentHtml(stdout))));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export interface MentionContext extends FileRoots { cwd?: string; dirs?: string[] }
const looksRelative = (s: string) => !/[\n\r\t]/.test(s) && s.length < 300 && !/^[a-z]+:/i.test(s) && (/\.[A-Za-z0-9]{1,8}$/.test(s) || s.endsWith("/"));

/** Resolve a chat mention (absolute, ~/, file:// or a relative name) to an allowed existing path. */
export function resolveMention(raw: string, context: MentionContext): (RemoteFileInfo & { dir: boolean }) | undefined {
  let text = raw.trim().replace(/[，。,;:：]$/, "");
  if (!text) return undefined;
  const home = context.home ?? homedir();
  if (/^file:\/\//i.test(text)) { try { text = decodeURIComponent(new URL(text).pathname); } catch { return undefined; } }
  if (text === "~" || text.startsWith("~/")) return checkRemotePath(join(home, text.slice(1)), context);
  if (text.startsWith("/")) return existsSync(text) ? checkRemotePath(text, context) : undefined;
  if (!looksRelative(text)) return undefined;
  for (const base of [...(context.dirs ?? []), ...(context.cwd ? [context.cwd] : [])]) {
    const full = join(base, text);
    if (existsSync(full)) { const found = checkRemotePath(full, context); if (found) return found; }
  }
  return undefined;
}

/** Folders written anywhere in a message (e.g. "文件夹：~/Desktop/X/") that relative names may live in. */
export function mentionedFolders(text: string, context: MentionContext): string[] {
  const dirs: string[] = [];
  for (const m of text.matchAll(/(?:file:\/\/)?(?:~|\/Users)\/[^\s`'"<>|()\[\]，。；、]*/g)) {
    const found = resolveMention(m[0], context);
    if (found?.dir && !dirs.includes(found.path)) dirs.push(found.path);
  }
  return dirs;
}
