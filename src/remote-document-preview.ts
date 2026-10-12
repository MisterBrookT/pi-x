import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, copyFile, readFile, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkRemotePath, fileLimit, type FileRoots } from "./remote-files.ts";

const execFile = promisify(execFileCallback);
type Runner = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;
const defaultRunner: Runner = (command, args, options) => execFile(command, args, options);
const maxPages = 200;
async function convertSlides(runner: Runner, directory: string, source: string) {
  const args = [`-env:UserInstallation=${pathToFileURL(join(directory, 'profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, source];
  try {
    await runner('/Applications/LibreOffice.app/Contents/MacOS/soffice', args, { timeout: 90_000, maxBuffer: 1_000_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') failure(error, 'LibreOffice');
    await run(runner, 'soffice', args, 90_000);
  }
}
const maxImageBytes = 740_000;
const cache = new Map<string, { directory: string; pdf: string; pages: number }>();
const pending = new Map<string, Promise<{ directory: string; pdf: string; pages: number }>>();
const activeRenders = new Map<string, number>();
process.once("exit", () => { for (const entry of cache.values()) rmSync(entry.directory, { recursive: true, force: true }); });

function failure(error: unknown, action: string): never {
  const message = String(error);
  if (/encrypted|password|incorrect password/i.test(message)) throw Error("This document is password-protected and cannot be previewed");
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /ENOENT/.test(message)) throw Error(`Preview converter unavailable (${action}); install Poppler or LibreOffice`);
  if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT' || (error as { killed?: boolean })?.killed || /timed out|ETIMEDOUT/.test(message)) throw Error("Document preview timed out");
  throw Error(`Cannot preview this document: ${action} failed or the file is corrupt`);
}

async function run(runner: Runner, command: string, args: string[], timeout = 20_000) {
  try { return await runner(command, args, { timeout, maxBuffer: 1_000_000 }); }
  catch (error) { failure(error, command); }
}

async function prepare(path: string, slides: boolean, runner: Runner) {
  const directory = await mkdtemp(join(tmpdir(), "pix-document-preview-"));
  try {
    let pdf = path;
    if (slides) {
      const source = join(directory, `source${path.toLowerCase().endsWith(".pptx") ? ".pptx" : ".ppt"}`);
      pdf = join(directory, "source.pdf");
      await copyFile(path, source);
      await convertSlides(runner, directory, source);
      try {
        const output = await stat(pdf);
        if (!output.isFile() || output.size === 0) throw Error('empty output');
      } catch {
        throw Error('Cannot preview this document: LibreOffice conversion failed or produced no PDF');
      }
    }
    const info = await run(runner, "pdfinfo", [pdf]);
    const text = String(info.stdout);
    if (/Encrypted:\s+yes/i.test(text)) throw Error("This document is password-protected and cannot be previewed");
    const pages = Number(text.match(/^Pages:\s*(\d+)\s*$/m)?.[1]);
    if (!Number.isInteger(pages) || pages < 1) throw Error("Cannot preview this document: invalid PDF page count");
    if (pages > maxPages) throw Error(`Document has too many pages to preview (maximum ${maxPages})`);
    return { directory, pdf, pages };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Resolve the source again on every request; cached exports are keyed by real path and stat. */
export async function previewRemoteDocument(path: unknown, page: unknown, roots: FileRoots = {}, runner: Runner = defaultRunner) {
  const file = checkRemotePath(path, roots);
  if (!file || file.dir || !["pdf", "slides"].includes(file.kind) || !/\.(pdf|pptx?)$/i.test(file.path)) return { status: 404, error: "no preview for this file" };
  if (file.size > fileLimit(file.kind)) return { status: 413, error: "File is too large to preview on the phone" };
  if (page !== null && (typeof page !== "string" || !/^[1-9]\d*$/.test(page) || Number(page) > maxPages)) return { status: 400, error: "Invalid page number" };
  try {
    const st = await stat(file.path);
    if (st.size > fileLimit(file.kind)) return { status: 413, error: "File is too large to preview on the phone" };
    const key = `${file.path}\0${st.size}\0${st.mtimeMs}\0${st.ino}`;
    let entry = cache.get(key);
    if (!entry) {
      let task = pending.get(key);
      if (!task) {
        task = prepare(file.path, file.kind === "slides", runner);
        pending.set(key, task);
      }
      try { entry = await task; } finally { pending.delete(key); }
      cache.set(key, entry);
      while (cache.size > 4) {
        const oldest = [...cache.keys()].find(k => k !== key && !activeRenders.get(cache.get(k)!.directory));
        if (!oldest) break;
        const evicted = cache.get(oldest)!;
        cache.delete(oldest);
        await rm(evicted.directory, { recursive: true, force: true });
      }
    }
    if (page === null) return { status: 200, kind: "pages", pages: entry.pages, name: file.name, path: file.path };
    const n = Number(page);
    if (n > entry.pages) return { status: 400, error: "Page is outside this document" };
    const prefix = join(entry.directory, `page-${n}-${randomUUID()}`);
    activeRenders.set(entry.directory, (activeRenders.get(entry.directory) ?? 0) + 1);
    try {
      await run(runner, "pdftoppm", ["-f", String(n), "-l", String(n), "-singlefile", "-scale-to", "1100", "-jpeg", "-jpegopt", "quality=65", entry.pdf, prefix]);
      const data = await readFile(`${prefix}.jpg`);
      if (data.length > maxImageBytes) return { status: 413, error: "Preview page is too large" };
      if (data[0] !== 0xff || data[1] !== 0xd8) throw Error("Invalid rendered JPEG");
      return { status: 200, page: n, pages: entry.pages, mimeType: "image/jpeg", data: data.toString("base64") };
    } finally {
      await rm(`${prefix}.jpg`, { force: true });
      const remaining = (activeRenders.get(entry.directory) ?? 1) - 1;
      if (remaining) activeRenders.set(entry.directory, remaining); else activeRenders.delete(entry.directory);
    }
  } catch (error) { return { status: 415, error: error instanceof Error ? error.message : "This document cannot be previewed" }; }
}
