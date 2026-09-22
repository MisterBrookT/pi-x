import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { patchWebAccess } from "../scripts/patch-web-access.mjs";

const original = '"User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",';
function userAgent(source, url) {
  const header = source.match(/"User-Agent": ([\s\S]*?),\n/);
  assert.ok(header, "fetch request contains a User-Agent header");
  return new Function("url", `return (${header[1]});`)(url);
}

test("installed fetcher uses browser identity only on X/Twitter hosts", () => {
  const source = readFileSync(new URL("../node_modules/pi-web-access/extract.ts", import.meta.url), "utf8");
  for (const host of ["x.com", "www.x.com", "twitter.com", "mobile.twitter.com"]) {
    assert.match(userAgent(source, `https://${host}/post`), /^Mozilla\/5\.0/);
  }
  for (const host of ["example.com", "notx.com", "x.com.example.org", "nottwitter.com"]) {
    assert.equal(userAgent(source, `https://${host}/`), "OpenAI File Downloader, XaiImageApiFetch/1.0");
  }
});

test("dependency patch is idempotent and refuses changed upstream code", () => {
  const patched = patchWebAccess(`${original}\n`);
  assert.equal(patchWebAccess(patched), patched);
  assert.throws(() => patchWebAccess("changed upstream"), /review the X fetch workaround/);
  assert.throws(() => patchWebAccess(`${original}\n${original}`), /review the X fetch workaround/);
});
