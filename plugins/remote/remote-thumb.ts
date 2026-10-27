// Small JPEG thumbnails for album strips: one sips call per image, cached by path, size and mtime.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
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
