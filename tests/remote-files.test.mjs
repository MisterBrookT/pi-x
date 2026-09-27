import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRemoteHub } from "../src/remote-hub.ts";
import { checkRemotePath, convertDocument, fileChunkBytes, listRemoteFiles, readRemoteChunk, resolveMention, sanitizeDocumentHtml } from "../src/remote-files.ts";
import { renderRemoteMarkdown } from "../src/remote-markdown.ts";
import { remoteMessages } from "../src/remote-state.ts";
import { relayAllowed } from "../src/remote-relay-agent.ts";

const token = "f".repeat(32);
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function fixture(t) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "pix-remote-files-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), hub = join(home, "workspace", "hub"), folder = join(home, "Desktop", "ZAI-Scholarship-2026");
  await mkdir(folder, { recursive: true });
  await mkdir(join(home, "code"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(join(home, "Library", "Keychains"), { recursive: true });
  await mkdir(join(hub, "skills", "about-me", "private"), { recursive: true });
  await writeFile(join(folder, "智谱Z奖学金-推荐信-唐英豪-完整审阅版.docx"), "doc");
  await writeFile(join(folder, "notes.md"), "# Notes");
  await writeFile(join(home, "code", "run.mp4"), Buffer.alloc(fileChunkBytes + 1000, 7));
  await writeFile(join(home, ".ssh", "id_ed25519"), "k");
  await writeFile(join(home, "code", ".env"), "k");
  await writeFile(join(home, "code", "server.pem"), "k");
  await writeFile(join(home, "code", "aws-credentials.txt"), "k");
  await writeFile(join(home, "code", "api_token.json"), "k");
  await writeFile(join(home, "Library", "Keychains", "login.txt"), "k");
  await writeFile(join(hub, "skills", "about-me", "private", "me.md"), "k");
  await writeFile(join(hub, "skills", "about-me", "SKILL.md"), "ok");
  await writeFile(join(home, "Talk.key"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
  await writeFile(join(dir, "outside.txt"), "k");
  await symlink(join(dir, "outside.txt"), join(home, "code", "escape.txt"));
  await symlink(join(home, ".ssh"), join(home, "code", "ssh-link"));
  return { dir, home, hub, folder, roots: { home, hubRoot: hub } };
}

test("file safety refuses outside home, hidden segments, secrets, keychains and hub private folders", async t => {
  const f = await fixture(t);
  assert.ok(checkRemotePath(join(f.folder, "notes.md"), f.roots));
  assert.ok(checkRemotePath(join(f.hub, "skills", "about-me", "SKILL.md"), f.roots));
  assert.equal(checkRemotePath(join(f.home, "Talk.key"), f.roots)?.kind, "slides", "a Keynote .key document is not a key file");
  for (const bad of [join(f.dir, "outside.txt"), join(f.home, ".ssh", "id_ed25519"), join(f.home, "code", ".env"), join(f.home, "code", "server.pem"),
    join(f.home, "code", "aws-credentials.txt"), join(f.home, "code", "api_token.json"), join(f.home, "Library", "Keychains", "login.txt"),
    join(f.hub, "skills", "about-me", "private", "me.md"), join(f.home, "code", "escape.txt"), join(f.home, "code", "ssh-link", "id_ed25519"),
    join(f.home, "code", "..", "..", "outside.txt"), "code/run.mp4", join(f.home, "code") + "\0x"]) assert.equal(checkRemotePath(bad, f.roots), undefined, bad);
  const list = listRemoteFiles(join(f.home, "code"), f.roots);
  assert.deepEqual(list.entries.map(e => e.name), ["run.mp4"], "folders first, secrets and escapes hidden");
  assert.equal(listRemoteFiles("", f.roots).path, f.home);
});

test("chat mentions resolve absolute, ~, file:// and relative names against the cwd and folders named earlier", async t => {
  const f = await fixture(t);
  const ctx = { ...f.roots, cwd: join(f.home, "code") };
  assert.equal(resolveMention("~/Desktop/ZAI-Scholarship-2026/", ctx)?.kind, "folder");
  assert.equal(resolveMention(`file://${encodeURI(join(f.home, "code", "run.mp4"))}`, ctx)?.kind, "video");
  assert.equal(resolveMention("run.mp4", ctx)?.path, join(f.home, "code", "run.mp4"));
  assert.equal(resolveMention("missing.pdf", ctx), undefined);
  assert.equal(resolveMention("npm test", ctx), undefined);
  const text = "文件夹：`~/Desktop/ZAI-Scholarship-2026/`\n\n| 文件 | 说明 |\n|---|---|\n| `智谱Z奖学金-推荐信-唐英豪-完整审阅版.docx` | 完整版 |\n\n`other.docx` and [video](run.mp4) and `~/.ssh/id_ed25519`";
  const [message] = remoteMessages([{ role: "assistant", timestamp: 1, content: [{ type: "text", text }] }], ctx);
  const chips = [...message.html.matchAll(/data-file="([^"]+)" data-kind="(\w+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(chips, [[f.folder, "folder"], [join(f.folder, "智谱Z奖学金-推荐信-唐英豪-完整审阅版.docx"), "word"], [join(f.home, "code", "run.mp4"), "video"]]);
  assert.match(message.html, /<code>other.docx<\/code>/);
  assert.match(message.html, /<code>~\/.ssh\/id_ed25519<\/code>/, "refused files stay plain code");
  assert.match(renderRemoteMarkdown("[x](file:///nowhere/a.mp4)", ctx), /Mac only/);
  assert.doesNotMatch(renderRemoteMarkdown("`run.mp4`"), /file-chip/, "no chips without a session context");
});

test("the hub serves allowed files in chunks through relay-allowed endpoints and lists the session cwd", async t => {
  const f = await fixture(t);
  const hub = await startRemoteHub({ token, port: 0, home: f.home, memoryRoot: f.hub });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "s", cwd: join(f.home, "code"), busy: false, messages: [] }) });
  const video = join(f.home, "code", "run.mp4");
  assert.equal((await fetch(`${base}/api/sessions/s1/file?path=${encodeURIComponent(video)}`)).status, 401);
  const parts = [];
  for (let offset = 0, done = false; !done;) {
    const path = `/api/sessions/s1/file?path=${encodeURIComponent(video)}&offset=${offset}`;
    assert.ok(relayAllowed(path, "GET"));
    const res = await fetch(base + path, { headers: auth });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.length < 1_300_000, "each chunk fits a relay frame");
    const chunk = JSON.parse(text);
    assert.equal(chunk.mimeType, "video/mp4");
    parts.push(Buffer.from(chunk.data, "base64")); offset += parts.at(-1).length; done = chunk.done;
  }
  assert.equal(parts.length, 2);
  assert.equal(Buffer.concat(parts).length, fileChunkBytes + 1000);
  assert.equal((await fetch(`${base}/api/sessions/s1/file?path=${encodeURIComponent(join(f.home, ".ssh", "id_ed25519"))}`, { headers: auth })).status, 404);
  const list = await (await fetch(`${base}/api/sessions/s1/files`, { headers: auth })).json();
  assert.equal(list.path, join(f.home, "code"), "Files opens at the session cwd");
  const md = await (await fetch(`${base}/api/sessions/s1/file/preview?path=${encodeURIComponent(join(f.folder, "notes.md"))}`, { headers: auth })).json();
  assert.match(md.html, /<h1>Notes<\/h1>/);
  assert.ok(relayAllowed("/api/sessions/s1/files?path=%2F", "GET") && relayAllowed("/api/sessions/s1/file/preview", "GET"));
  assert.ok(!relayAllowed("/api/sessions/s1/file", "POST") && !relayAllowed("/api/sessions/s1/file/raw", "GET"));
  assert.equal(readRemoteChunk(video, 0, { ...f.roots }).status, 200);
});

test("document HTML keeps structure but strips scripts, handlers, styles and resources", () => {
  const html = sanitizeDocumentHtml('<html><head><style>p{}</style></head><body><p class="p1" onclick="x()"><b>Hi</b><script>alert(1)</script></p><img src="http://t/x.png"><a href="javascript:1">l</a><table><tr><td colspan="2" style="x">A</td></tr></table><iframe src="x"></iframe></body></html>');
  assert.equal(html, '<p><b>Hi</b></p>l<table><tr><td colspan="2">A</td></tr></table>');
});

test("Word documents convert on the Mac with textutil", { skip: !existsSync("/usr/bin/textutil") && "textutil unavailable" }, async t => {
  const f = await fixture(t);
  const source = join(f.dir, "in.html"), docx = join(f.home, "letter.docx");
  await writeFile(source, "<meta charset=\"utf-8\"><h1>推荐信</h1><p><b>Bold</b></p><table><tr><td>A</td><td>B</td></tr></table><script>alert(1)</script>");
  execFileSync("textutil", ["-convert", "docx", source, "-output", docx]);
  const html = await convertDocument(docx);
  assert.match(html, /推荐信/);
  assert.match(html, /<b>Bold<\/b>/);
  assert.doesNotMatch(html, /script|style|class=/);
  const hub = await startRemoteHub({ token, port: 0, home: f.home, memoryRoot: f.hub });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s1`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "s", cwd: f.home, busy: false, messages: [] }) });
  const res = await fetch(`${base}/api/sessions/s1/file/preview?path=${encodeURIComponent(docx)}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.match((await res.json()).html, /推荐信/);
});
