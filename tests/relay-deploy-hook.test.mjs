import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The post-commit hook must deploy whenever anything the relay Worker bundles changes.
test("post-commit relay deploy watches every file the relay bundles", () => {
  const hook = readFileSync(new URL("../scripts/git-hooks/post-commit", import.meta.url), "utf8");
  const pattern = new RegExp(hook.match(/grep -qE '([^']+)'/)[1]);
  const imports = [...readFileSync(new URL("../relay/src/index.ts", import.meta.url), "utf8").matchAll(/from "\.\.\/\.\.\/(plugins\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(imports.length >= 3);
  for (const file of [...imports, "relay/src/index.ts", "relay/wrangler.jsonc", "plugins/desktop/remote-desktop-web.ts", "plugins/desktop/remote-desktop-vendor.ts"]) {
    assert.match(file, pattern, `${file} change deploys the relay`);
    for (const dep of readFileSync(new URL("../" + file, import.meta.url), "utf8").matchAll(/from "(\.\.?\/[^"]+)"/g))
      assert.match(join(dirname(file), dep[1]), pattern, `${file} imports ${dep[1]}, which must also trigger a deploy`);
  }
  assert.doesNotMatch("plugins/remote/remote-hub.ts", pattern, "Mac-only files do not deploy");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.prepare, /core\.hooksPath scripts\/git-hooks/);
});

test("the relay page lets the phone show pictures it fetched from the Mac (blob: images in chat bubbles)", () => {
  const src = readFileSync(new URL("../relay/src/index.ts", import.meta.url), "utf8");
  const csp = src.match(/"content-security-policy": `([^`]+)`/)[1];
  assert.match(csp, /img-src [^;]*\bblob:/, "chat images are blob: URLs; without this the relay shows grey boxes");
});
