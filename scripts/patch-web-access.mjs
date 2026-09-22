import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// pi-web-access 0.27.0 identifies as an AI downloader, which X rejects with 403.
// Keep the workaround narrow and fail loudly if an upgrade changes this code.
const original = '"User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",';
const replacement = `"User-Agent": /(^|\\.)(x\\.com|twitter\\.com)$/i.test(new URL(url).hostname)
					? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
					: "OpenAI File Downloader, XaiImageApiFetch/1.0",`;

export function patchWebAccess(source) {
  if (source.includes(replacement)) return source;
  if (source.split(original).length !== 2) {
    throw new Error("pi-web-access User-Agent changed; review the X fetch workaround before installing");
  }
  return source.replace(original, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = new URL("../node_modules/pi-web-access/extract.ts", import.meta.url);
  const before = readFileSync(target, "utf8");
  const after = patchWebAccess(before);
  if (after !== before) writeFileSync(target, after);
}
