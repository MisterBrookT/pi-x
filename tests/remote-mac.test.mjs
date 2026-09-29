import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import registerRemote from "../extensions/remote.ts";
import { startRemoteHub } from "../src/remote-hub.ts";
import { deletableSessionFile, launchCommand, launchPi, launchableFolder, listFolders, listMemory, readMemory, recentFolders } from "../src/remote-mac.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";
import { remoteAppHtml } from "../src/remote-web.ts";
import { goalSession, say } from "./helpers/goal-session.mjs";

const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function fixture(t) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "pix-remote-mac-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), sessions = join(dir, "sessions"), memory = join(home, "hub");
  await mkdir(join(home, "code", "app"), { recursive: true });
  await mkdir(join(home, ".secret"), { recursive: true });
  await writeFile(join(home, "notes.txt"), "not a folder");
  await mkdir(join(sessions, "--code--"), { recursive: true });
  await writeFile(join(sessions, "--code--", "2026-01-01_abc.jsonl"), JSON.stringify({ type: "session", id: "abc", cwd: join(home, "code") }) + "\n");
  await mkdir(join(memory, "skills", "writing"), { recursive: true });
  await writeFile(join(memory, "AGENTS.md"), "# Hub rules\n\n<script>x</script>");
  await writeFile(join(memory, "skills", "writing", "SKILL.md"), "# Writing");
  await writeFile(join(memory, "skills", "writing", "notes.txt"), "no");
  await writeFile(join(dir, "outside.md"), "# secret");
  await symlink(join(dir, "outside.md"), join(memory, "skills", "writing", "escape.md"));
  return { dir, home, sessions, memory };
}

test("folder picker lists recent session folders and visible home subfolders only", async t => {
  const f = await fixture(t);
  assert.deepEqual(await recentFolders(f.sessions), [{ name: "code", path: join(f.home, "code") }]);
  const top = await listFolders("", f.home);
  assert.deepEqual(top.folders.map(x => x.name), ["code", "hub"], "no hidden dirs, no files");
  assert.equal(top.parent, undefined);
  assert.equal((await listFolders(join(f.home, "code"), f.home)).parent, f.home);
  assert.equal(await listFolders(f.dir, f.home), undefined, "outside home is refused");
  assert.equal(await listFolders(join(f.home, "code", ".."), f.home).then(r => r.path), f.home);
  assert.equal(await launchableFolder(join(f.home, "code", "app"), f.home, f.sessions), join(f.home, "code", "app"));
  assert.equal(await launchableFolder(f.dir, f.home, f.sessions), undefined);
  assert.equal(await launchableFolder(join(f.home, "notes.txt"), f.home, f.sessions), undefined);
  assert.equal(await launchableFolder("code", f.home, f.sessions), undefined, "relative paths are refused");
});

test("New session starts Pi with remote on in Otty, or detached tmux without it", async () => {
  assert.deepEqual(launchCommand("/Users/me/a b", "relay", true), { command: "otty", args: ["tab", "new", "--cwd", "/Users/me/a b", "--command", "env PIX_REMOTE_AUTOSTART=relay pi", "--no-focus"] });
  assert.deepEqual(launchCommand("/Users/me/a b", "tailnet", false), { command: "tmux", args: ["new-session", "-d", "-c", "/Users/me/a b", "env PIX_REMOTE_AUTOSTART=tailnet pi"] });
  const calls = [];
  await launchPi("/x", "relay", { hasOtty: false, spawn: async (command, args) => { calls.push([command, ...args]); } });
  assert.deepEqual(calls, [["tmux", "new-session", "-d", "-c", "/x", "env PIX_REMOTE_AUTOSTART=relay pi"]]);
});

test("delete accepts only this session's .jsonl inside the sessions folder", async t => {
  const f = await fixture(t);
  const file = join(f.sessions, "--code--", "2026-01-01_abc.jsonl");
  assert.equal(await deletableSessionFile(file, "abc", f.sessions), file);
  assert.equal(await deletableSessionFile(file, "other", f.sessions), undefined, "wrong session id");
  assert.equal(await deletableSessionFile(join(f.sessions, "--code--", "..", "--code--", "2026-01-01_abc.jsonl"), "abc", f.sessions), file);
  await writeFile(join(f.dir, "x_abc.jsonl"), "");
  assert.equal(await deletableSessionFile(join(f.dir, "x_abc.jsonl"), "abc", f.sessions), undefined, "outside sessions");
  await symlink(join(f.dir, "x_abc.jsonl"), join(f.sessions, "--code--", "y_abc.jsonl"));
  assert.equal(await deletableSessionFile(join(f.sessions, "--code--", "y_abc.jsonl"), "abc", f.sessions), undefined, "symlink");
  assert.equal(await deletableSessionFile(file, "../abc", f.sessions), undefined);
});

test("Memory lists hub AGENTS.md and skill Markdown, refusing traversal and escaping symlinks", async t => {
  const f = await fixture(t);
  assert.deepEqual(await listMemory(f.memory), [
    { group: "Hub", name: "AGENTS.md", path: "AGENTS.md" },
    { group: "writing", name: "SKILL.md", path: "skills/writing/SKILL.md" },
  ]);
  assert.equal((await readMemory("skills/writing/SKILL.md", f.memory)).text, "# Writing");
  for (const bad of ["skills/writing/escape.md", "../outside.md", "skills/../../outside.md", "skills/writing/notes.txt", join(f.dir, "outside.md"), "code.md"]) assert.equal(await readMemory(bad, f.memory), undefined, bad);
  await writeFile(join(f.memory, "skills", "big.md"), "x".repeat(300_000));
  assert.equal(await readMemory("skills/big.md", f.memory), undefined, "size limit");
});

test("hub folder, launch, and memory endpoints require the token and validate input", async t => {
  const f = await fixture(t);
  const launched = [];
  const hub = await startRemoteHub({ token, port: 0, home: f.home, sessionsDir: f.sessions, memoryRoot: f.memory, launch: async dir => { launched.push(dir); } });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  for (const path of ["/api/folders", "/api/memory", "/api/memory/file?path=AGENTS.md"]) assert.equal((await fetch(base + path)).status, 401, path);
  assert.equal((await fetch(`${base}/api/launch`, { method: "POST", body: JSON.stringify({ path: f.home }) })).status, 401);
  const folders = await (await fetch(`${base}/api/folders`, { headers: auth })).json();
  assert.deepEqual(folders.recent.map(x => x.name), ["code"]);
  assert.equal((await fetch(`${base}/api/folders?path=${encodeURIComponent(f.dir)}`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/launch`, { method: "POST", headers: auth, body: JSON.stringify({ path: f.dir }) })).status, 400);
  assert.equal((await fetch(`${base}/api/launch`, { method: "POST", headers: auth, body: JSON.stringify({ path: join(f.home, "code") }) })).status, 202);
  assert.deepEqual(launched, [join(f.home, "code")]);
  assert.equal((await (await fetch(`${base}/api/memory`, { headers: auth })).json()).length, 2);
  const file = await (await fetch(`${base}/api/memory/file?path=AGENTS.md`, { headers: auth })).json();
  assert.match(file.html, /<h1>Hub rules<\/h1>/);
  assert.doesNotMatch(file.html, /<script>/, "Markdown HTML is escaped");
  assert.equal((await fetch(`${base}/api/memory/file?path=skills/writing/escape.md`, { headers: auth })).status, 404);
});

test("the encrypted relay forwards the new endpoints and nothing broader", () => {
  for (const [path, method] of [["/api/folders", "GET"], ["/api/folders?path=%2FUsers", "GET"], ["/api/memory", "GET"], ["/api/memory/file?path=AGENTS.md", "GET"], ["/api/launch", "POST"]]) assert.ok(relayAllowed(path, method), path);
  assert.ok(!relayAllowed("/api/launch", "GET"));
  assert.ok(!relayAllowed("/agent/x", "PUT"));
});

test("the phone app script parses and has New session and Close/Delete controls, but no Memory section", () => {
  const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.doesNotThrow(() => new Script(script));
  assert.match(remoteAppHtml, /id="newSession"[^>]*>＋ New session/);
  assert.match(script, /data-more=/);
  assert.match(script, /action:del\?'delete':'close'/);
  assert.match(script, /confirm\(/);
  assert.doesNotMatch(remoteAppHtml, /id="memory"/);
});

async function remoteSession(t, extra) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "pix-remote-close-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = await startRemoteHub({ token, port: 0 });
  const port = probe.port; await probe.close();
  const tokenPath = join(dir, "token");
  const h = await goalSession(t, () => say("ok"), { tools: [], extensions: [pi => registerRemote(pi, { port, tokenPath, relayUrl: "", ...extra(dir) })] });
  return { dir, h, base: `http://127.0.0.1:${port}`, tokenPath };
}

test("PIX_REMOTE_AUTOSTART turns remote on at Pi startup", async t => {
  process.env.PIX_REMOTE_AUTOSTART = "tailnet";
  t.after(() => { delete process.env.PIX_REMOTE_AUTOSTART; });
  const { h, base, tokenPath } = await remoteSession(t, () => ({}));
  assert.equal(process.env.PIX_REMOTE_AUTOSTART, undefined, "not inherited by child processes");
  const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}` };
  const id = h.session.sessionManager.getSessionId();
  let list = [];
  for (let i = 0; i < 100 && !list.some(s => s.id === id); i++) { list = await (await fetch(`${base}/api/sessions`, { headers })).json(); await new Promise(r => setTimeout(r, 30)); }
  assert.ok(list.some(s => s.id === id));
});

test("phone Delete quits Pi and removes only that session's file; Close keeps it", async t => {
  for (const action of ["close", "delete"]) {
    const { dir, h, base, tokenPath } = await remoteSession(t, dir => ({ sessionsDir: join(dir, "sessions") }));
    await h.session.prompt("/rc tailnet");
    const id = h.session.sessionManager.getSessionId();
    const file = join(dir, "sessions", "--proj--", `2026_${id}.jsonl`);
    await mkdir(join(dir, "sessions", "--proj--"), { recursive: true });
    await writeFile(file, "{}\n");
    h.session.sessionManager.getSessionFile = () => file;
    let quit = false;
    h.session._extensionShutdownHandler = undefined;
    await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => { quit = true; void h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } });
    const headers = { authorization: `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/sessions/${id}/action`, { method: "POST", headers, body: JSON.stringify({ action }) })).status, 202);
    for (let i = 0; i < 100 && (!quit || (action === "delete" && existsSync(file))); i++) await new Promise(r => setTimeout(r, 30));
    assert.ok(quit, `${action} quits Pi`);
    assert.equal(existsSync(file), action === "close");
  }
});
