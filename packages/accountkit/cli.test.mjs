import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const cli = new URL("./cli.ts", import.meta.url).pathname;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "accountkit-cli-"));
  const home = join(root, "home"), pix = join(root, "pix"), bin = join(root, "bin"), trap = join(root, "trap");
  for (const d of [home, pix, bin]) mkdirSync(d, { recursive: true });
  // Any call to security or claude is a failure: the CLI must only print commands.
  for (const name of ["security", "claude"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${trap}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, PIX_HOME: pix } });
  const json = f => JSON.parse(readFileSync(join(pix, f), "utf8"));
  const put = (f, v) => writeFileSync(join(pix, f), JSON.stringify(v));
  return { home, pix, trap, run, json, put };
}

test("add creates the profile dir, appends the account, keeps other fields and prints a quoted login command", () => {
  const s = sandbox();
  s.put("accounts.json", { band: 30, accounts: [{ id: "own", label: "brook", extra: 1 }, { id: "cx", label: "Codex", provider: "codex", dir: "/x" }] });
  const r = s.run("add", "work2", "--label", "brook's work");
  assert.equal(r.status, 0, r.stderr);
  const dir = join(s.home, ".claude-work2");
  assert.ok(statSync(dir).isDirectory());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = s.json("accounts.json");
  assert.equal(file.band, 30);
  assert.deepEqual(file.accounts.slice(0, 2), [{ id: "own", label: "brook", extra: 1 }, { id: "cx", label: "Codex", provider: "codex", dir: "/x" }]);
  assert.deepEqual(file.accounts[2], { id: "work2", label: "brook's work", configDir: dir });
  assert.ok(r.stdout.includes(`CLAUDE_CONFIG_DIR='${dir}' claude`), r.stdout);
  assert.equal(statSync(join(s.pix, "accounts.json")).mode & 0o777, 0o600);
  assert.equal(existsSync(s.trap), false);
});

test("add without an accounts file keeps the built-in defaults and rejects duplicates", () => {
  const s = sandbox();
  assert.equal(s.run("add", "x1").status, 0);
  assert.deepEqual(s.json("accounts.json").accounts.map(a => a.id), ["minarabench", "own", "x1"]);
  const dup = s.run("add", "x1");
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /exists/);
});

test("invalid ids and options are refused without writing", () => {
  const s = sandbox();
  for (const args of [["add", "../evil"], ["add", "a/b"], ["add", ""], ["add", "-x"], ["add", "ok", "--bogus"], ["add", "ok", "--label"], ["remove", ".."], ["frob"]]) {
    const r = s.run(...args);
    assert.notEqual(r.status, 0, args.join(" "));
  }
  assert.equal(existsSync(join(s.pix, "accounts.json")), false);
  assert.equal(existsSync(join(s.home, ".claude-..")), false);
});

test("remove prunes every reference, keeps the profile and only prints the keychain delete command", () => {
  const s = sandbox();
  assert.equal(s.run("add", "gone").status, 0);
  const dir = join(s.home, ".claude-gone");
  writeFileSync(join(dir, ".credentials.json"), "{}");
  s.put("accounts-usage.json", { gone: { left: 5 }, own: { left: 9 }, _active: { id: "gone" } });
  s.put("accounts-health.json", { gone: { reason: "ok" }, own: { reason: "ok" } });
  s.put("session-accounts.json", { s1: { pin: "gone" }, s2: { active: "gone", at: 1 }, s3: { pin: "own", active: "gone" }, s4: { active: "own" }, s5: { at: 1, extra: "keep" }, s6: { pin: "gone", at: 2, extra: "keep" } });
  writeFileSync(join(s.pix, "claude-route"), "gone\n");
  const r = s.run("remove", "gone");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.json("accounts.json").accounts.map(a => a.id), ["minarabench", "own"]);
  assert.deepEqual(s.json("accounts-usage.json"), { own: { left: 9 } });
  assert.deepEqual(s.json("accounts-health.json"), { own: { reason: "ok" } });
  assert.deepEqual(s.json("session-accounts.json"), { s3: { pin: "own" }, s4: { active: "own" }, s5: { at: 1, extra: "keep" }, s6: { at: 2, extra: "keep" } });
  assert.equal(readFileSync(join(s.pix, "claude-route"), "utf8").trim(), "auto");
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  assert.ok(r.stdout.includes(`security delete-generic-password -s 'Claude Code-credentials-${hash}'`), r.stdout);
  assert.ok(existsSync(join(dir, ".credentials.json")), "profile must stay");
  assert.equal(existsSync(s.trap), false);
  assert.notEqual(s.run("remove", "gone").status, 0);
});

test("disable, enable and list keep working and never print secrets", () => {
  const s = sandbox();
  s.run("add", "w");
  writeFileSync(join(s.home, ".claude-w", ".credentials.json"), JSON.stringify({ token: "sk-ant-SECRET" }));
  assert.equal(s.run("disable", "w").status, 0);
  assert.equal(s.json("accounts.json").accounts.find(a => a.id === "w").disabled, true);
  assert.equal(s.run("enable", "w").status, 0);
  assert.equal("disabled" in s.json("accounts.json").accounts.find(a => a.id === "w"), false);
  const l = s.run("list");
  assert.equal(l.status, 0, l.stderr);
  assert.ok(JSON.parse(l.stdout).accounts.some(a => a.id === "w" && a.ready));
  assert.ok(!l.stdout.includes("SECRET"));
  assert.notEqual(s.run("disable", "nope").status, 0);
});

test("remove prints the plain keychain command for the default profile, a resolved-path hash for relative dirs, none for Codex", () => {
  const s = sandbox();
  s.put("accounts.json", { accounts: [{ id: "own", label: "brook" }, { id: "rel", label: "R", configDir: "rel-dir" }, { id: "cx", label: "C", provider: "codex", dir: "/x" }] });
  const own = s.run("remove", "own");
  assert.equal(own.status, 0, own.stderr);
  assert.ok(own.stdout.includes("security delete-generic-password -s 'Claude Code-credentials'\n") || own.stdout.trimEnd().endsWith("-s 'Claude Code-credentials'"), own.stdout);
  const rel = s.run("remove", "rel");
  const hash = createHash("sha256").update(join(process.cwd(), "rel-dir")).digest("hex").slice(0, 8);
  assert.ok(rel.stdout.includes(`Claude Code-credentials-${hash}'`), rel.stdout);
  const cx = s.run("remove", "cx");
  assert.equal(cx.status, 0, cx.stderr);
  assert.ok(!cx.stdout.includes("security"), cx.stdout);
  assert.equal(existsSync(s.trap), false);
});

test("malformed metadata stops every mutation before any write, naming only the file", () => {
  for (const bad of ["accounts.json", "accounts-usage.json", "accounts-health.json", "session-accounts.json"]) {
    const s = sandbox();
    s.put("accounts.json", { accounts: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    s.put("accounts-usage.json", { a: { left: 1 } });
    s.put("accounts-health.json", { a: { reason: "ok" } });
    s.put("session-accounts.json", { s1: { pin: "a" } });
    writeFileSync(join(s.pix, bad), '{"secret-ish": tok');
    const before = Object.fromEntries(["accounts.json", "accounts-usage.json", "accounts-health.json", "session-accounts.json"].map(f => [f, readFileSync(join(s.pix, f), "utf8")]));
    const cmds = bad === "accounts.json" ? [["remove", "a"], ["add", "c"], ["disable", "a"]] : [["remove", "a"]];
    for (const c of cmds) {
      const r = s.run(...c);
      assert.notEqual(r.status, 0, `${bad} ${c}`);
      assert.ok(r.stderr.includes(bad) && !r.stderr.includes("tok") && !r.stderr.includes("secret"), r.stderr);
    }
    for (const [f, v] of Object.entries(before)) assert.equal(readFileSync(join(s.pix, f), "utf8"), v, `${bad} changed ${f}`);
  }
  const s = sandbox();
  s.put("accounts.json", { accounts: "nope" });
  assert.notEqual(s.run("add", "z").status, 0);
  assert.equal(existsSync(join(s.home, ".claude-z")), false);
});
