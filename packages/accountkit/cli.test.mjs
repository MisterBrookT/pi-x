import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("CLI disables and enables metadata only, and lists disabled accounts without credential contents or paths", t => {
  const home = mkdtempSync(join(tmpdir(), "accountkit-cli-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const credentials = join(home, ".credentials.json"); writeFileSync(credentials, '{"secret":"never-print-this-token"}');
  const original = { band: 9, accounts: [{ id: "own", label: "brook", configDir: home }, { id: "codex", provider: "codex", dir: home }] };
  const config = join(home, "accounts.json"); writeFileSync(config, JSON.stringify(original));
  const run = (...args) => spawnSync(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, ...args], { encoding: "utf8", env: { ...process.env, PIX_HOME: home } });
  assert.equal(run("disable", "own", "oauth_org_denied").status, 0);
  const listed = run("list"); assert.equal(listed.status, 0); const result = JSON.parse(listed.stdout);
  assert.equal(result.accounts[0].disabled, true); assert.equal(result.accounts[0].ready, false); assert.equal(result.accounts[0].disabledReason, "oauth_org_denied");
  assert.equal(result.accounts[1].provider, "codex"); assert.ok(!listed.stdout.includes(home)); assert.doesNotMatch(listed.stdout, /never-print-this-token|secret/);
  assert.equal(run("enable", "own").status, 0); assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), original);
  assert.equal(run("disable", "missing").status, 2); assert.equal(run("disable").status, 2); assert.equal(run("unknown").status, 2);
  assert.equal(readFileSync(credentials, "utf8"), '{"secret":"never-print-this-token"}');
});
