// Small JPEG thumbnails for album strips: one sips call per image, cached by path, size and mtime.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRemotePath, type FileRoots } from "./remote-files.ts";

const dir = join(tmpdir(), "pix-thumbs");
const sips = (src: string, out: string, size: number) => new Promise<void>((resolve, reject) =>
  execFile("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(size), src, "--out", out], { timeout: 15_000 }, error => error ? reject(error) : resolve()));

export async function remoteThumbnail(path: unknown, roots: FileRoots = {}, size = 320, run = sips) {
  const file = checkRemotePath(path, roots);
  if (!file || file.dir || file.kind !== "image") return { status: 404, error: "no thumbnail for this file" };
  try {
    const st = statSync(file.path);
    const out = join(dir, createHash("sha1").update(`${file.path}\0${st.size}\0${st.mtimeMs}\0${size}`).digest("hex") + ".jpg");
    try { statSync(out); } catch { mkdirSync(dir, { recursive: true }); await run(file.path, out, size); }
    return { status: 200, mimeType: "image/jpeg", data: readFileSync(out).toString("base64") };
  } catch { return { status: 415, error: "This image cannot be previewed" }; }
}

/** A small JPEG of an image the session sent (base64 in, base64 out), cached by content hash. Falls back to the original. */
export async function mediaThumbnail(media: { mimeType: string; data: string }, size = 640, run = sips): Promise<{ mimeType: string; data: string }> {
  if (media.data.length < 120_000) return media;  // already small (~90 KB)
  const key = createHash("sha1").update(media.data).digest("hex") + "-" + size;
  const out = join(dir, key + ".jpg");
  try { return { mimeType: "image/jpeg", data: readFileSync(out).toString("base64") }; } catch {}
  try {
    mkdirSync(dir, { recursive: true });
    const src = join(dir, key + ".src");
    writeFileSync(src, Buffer.from(media.data, "base64"));
    await run(src, out, size);
    rmSync(src, { force: true });
    const data = readFileSync(out).toString("base64");
    return data.length < media.data.length ? { mimeType: "image/jpeg", data } : media;
  } catch { return media; }
}
