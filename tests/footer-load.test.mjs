import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { goalSession, say } from "./helpers/goal-session.mjs";

test("footer extension loads and observes a response through the public Pi runtime", async t => {
  // Use Pi's loader: it resolves the extension's .js specifiers to TypeScript, as the CLI does.
  const footerPath = fileURLToPath(new URL("../plugins/footer/index.ts", import.meta.url));
  const h = await goalSession(t, () => say("footer startup works"), { tools: [], goalExtensionPath: footerPath });
  await h.session.prompt("startup regression");
  await h.until(() => h.settledCount() >= 1);
  assert.deepEqual(h.extensionErrors, []);
  assert.ok(h.session.messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "text" && c.text === "footer startup works")));
});
