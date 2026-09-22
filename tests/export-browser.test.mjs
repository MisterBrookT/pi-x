import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { InteractiveMode, SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { installBrowserExport } from "../extensions/export.ts";
import { goalSession, say } from "./helpers/goal-session.mjs";

async function fixture(t, opener, cold = false) {
  const directory = await mkdtemp(join(tmpdir(), "pix-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionManager = SessionManager.create(directory, directory);
  if (cold) {
    sessionManager.appendMessage({ role: "user", content: "Recovered question", timestamp: 1 });
    sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recovered answer" }], timestamp: 2, api: "anthropic-messages", provider: "anthropic", model: "fixture", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const h = await goalSession(t, () => say("export fixture"), { extensions: [], sessionManager });
  if (!cold) await h.session.prompt("A public-safe export fixture.");
  initTheme("dark", false);
  const opened = [], statuses = [], errors = [];
  // Real Pi handler and path parser, real AgentSession exporter; only terminal
  // notifications and the OS browser launcher are replaced.
  const prototype = Object.create(InteractiveMode.prototype);
  installBrowserExport(prototype, opener ?? (async path => { opened.push(path); return true; }));
  const mode = Object.assign(Object.create(prototype), {
    runtimeHost: { session: h.session },
    showStatus: text => statuses.push(text),
    showError: text => errors.push(text),
  });
  return { ...h, directory, mode, prototype, opened, statuses, errors };
}

test("native /export saves HTML and opens its exact quoted path once", async t => {
  const h = await fixture(t);
  const path = join(h.directory, "session with spaces.html");
  const original = h.session.exportToHtml;
  await h.mode.handleExportCommand(`/export "${path}"`);
  const html = await readFile(path, "utf8");
  assert.match(html, /<!doctype html>/i);
  const data = JSON.parse(Buffer.from(html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)[1], "base64"));
  assert.equal(data.systemPrompt, h.session.systemPrompt);
  assert.ok(data.systemPrompt.length > 0);
  assert.deepEqual(data.tools.map(tool => tool.name), h.session.getActiveToolNames());
  assert.deepEqual(data.entries.filter(entry => entry.type === "message").slice(-2).map(entry => entry.message.role), ["user", "assistant"]);
  assert.deepEqual(h.opened, [path]);
  assert.equal(h.session.exportToHtml, original);
  assert.equal(Object.hasOwn(h.session, "exportToHtml"), false);
  assert.ok(h.statuses.includes(`Session exported to: ${path}`));
  assert.ok(h.statuses.includes("Export opened in your browser."));
  assert.deepEqual(h.errors, []);
});

test("bare /export opens the native generated filename as an absolute path", async t => {
  const h = await fixture(t);
  const expected = resolve(`pi-session-${basename(h.sm.getSessionFile(), ".jsonl")}.html`);
  t.after(() => rm(expected, { force: true }));
  await h.mode.handleExportCommand("/export");
  assert.deepEqual(h.opened, [expected]);
  assert.match(await readFile(expected, "utf8"), /<!doctype html>/i);
});

test("resumed sessions export the effective prompt and complete history without changing live state", async t => {
  const h = await fixture(t, undefined, true);
  assert.equal(h.session.state.systemPrompt, "");
  const path = join(h.directory, "resumed.html");
  const history = JSON.parse(JSON.stringify(h.sm.getEntries()));
  await h.mode.handleExportCommand(`/export ${path}`);
  const html = await readFile(path, "utf8");
  const data = JSON.parse(Buffer.from(html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)[1], "base64"));
  assert.equal(data.systemPrompt, h.session.systemPrompt);
  assert.ok(data.systemPrompt.length > 0);
  assert.deepEqual(data.entries, history);
  assert.equal(h.session.state.systemPrompt, "");
  assert.deepEqual(h.opened, [path]);
});

test("native JSONL export stays save-only", async t => {
  const h = await fixture(t);
  const path = join(h.directory, "session.jsonl");
  await h.mode.handleExportCommand(`/export ${path}`);
  assert.equal(JSON.parse((await readFile(path, "utf8")).split("\n")[0]).type, "session");
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.errors, []);
});

test("failed native export never opens a browser and restores the session method", async t => {
  const h = await fixture(t);
  const original = h.session.exportToHtml;
  await h.mode.handleExportCommand(`/export ${join(h.directory, "missing", "page.html")}`);
  assert.deepEqual(h.opened, []);
  assert.match(h.errors[0], /Failed to export session/);
  assert.equal(h.session.exportToHtml, original);
});

for (const throws of [false, true]) test(`browser failure preserves the HTML and reports its path (throws=${throws})`, async t => {
  const h = await fixture(t, async () => { if (throws) throw new Error("No desktop"); return false; });
  const path = join(h.directory, "saved.html");
  await h.mode.handleExportCommand(`/export ${path}`);
  assert.match(await readFile(path, "utf8"), /<!doctype html>/i);
  assert.ok(h.statuses.includes(`Could not open the browser. HTML saved at: ${path}`));
  assert.deepEqual(h.errors, []);
});

test("reload does not stack wrappers and repeated exports cannot overlap captures", async t => {
  const h = await fixture(t);
  const opened = [];
  installBrowserExport(h.prototype, async path => { opened.push(path); return true; });
  const paths = [join(h.directory, "one.html"), join(h.directory, "two.html")];
  await Promise.all(paths.map(path => h.mode.handleExportCommand(`/export ${path}`)));
  assert.deepEqual(opened, paths);
  assert.deepEqual(h.opened, []);
  assert.equal(Object.hasOwn(h.session, "exportToHtml"), false);
});

test("SDK HTML exports remain save-only outside /export", async t => {
  const h = await fixture(t);
  const path = join(h.directory, "sdk.html");
  await h.session.exportToHtml(path);
  assert.deepEqual(h.opened, []);
  assert.match(await readFile(path, "utf8"), /<!doctype html>/i);
});
