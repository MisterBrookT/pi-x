import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { checkGmailAuth, gmailProblem, gmailTokenExpires } = await jiti.import("../plugins/foryou/gmail-health.ts");

const dir = (tokens = { refresh_token: "r", refresh_token_expires_in: 604799 }) => { const d = mkdtempSync(join(tmpdir(), "gm-")); writeFileSync(join(d, "gcp-oauth.keys.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s", token_uri: "https://t" } })); writeFileSync(join(d, "credentials.json"), JSON.stringify({ tokens })); return d; };

test("gmail login check: invalid_grant = revoked (one stable alert with the re-login command); network trouble is not an alert", async () => {
  const d = dir();
  assert.equal(await checkGmailAuth(d, async () => ({ status: 200, body: "{}" })), "ok");
  assert.equal(await checkGmailAuth(d, async () => ({ status: 400, body: '{"error":"invalid_grant"}' })), "revoked");
  assert.equal(await checkGmailAuth(d, async () => ({ status: 0, body: "" })), "unknown");
  assert.equal(await checkGmailAuth(mkdtempSync(join(tmpdir(), "gm-"))), "missing");
  let sent = ""; await checkGmailAuth(d, async (_u, b) => { sent = b; return { status: 200, body: "" }; });
  assert.match(sent, /grant_type=refresh_token/);
  const [p] = gmailProblem("revoked", "2026-10-17T00:00:00Z");
  assert.match(p.text, /Gmail login expired[\s\S]*gmail-mcp\/dist\/index\.js auth/); assert.doesNotMatch(p.text, /\bs\b=|refresh_token/);
  assert.deepEqual(gmailProblem("ok", ""), []); assert.deepEqual(gmailProblem("unknown", ""), []);
  assert.equal(gmailTokenExpires(d), true, "Testing-mode token (7-day) is detectable");
  assert.equal(gmailTokenExpires(dir({ refresh_token: "r" })), false);
});
