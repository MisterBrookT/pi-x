import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactLinks, artifactKind, artifactsLabel, detectArtifacts, loadArtifacts, pinArtifact, redactUrl, unpinArtifact } from "../plugins/core/artifacts.ts";
import registerArtifacts from "../plugins/artifacts/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "artifacts-"));

test("artifacts: pin docs, links and files per session; same url kept once; footer label counts kinds", () => {
  const d = dir();
  pinArtifact("s1", { title: "Kairos 结果", url: "https://byterum.feishu.cn/docx/AQOF" }, d);
  pinArtifact("s1", { title: "Cookbook", url: "https://decision.brooktang.fun" }, d);
  pinArtifact("s1", { title: "Cookbook again", url: "https://decision.brooktang.fun" }, d);
  pinArtifact("s1", { url: "~/Desktop/demo.md" }, d);
  assert.deepEqual(loadArtifacts("s1", d).map(x => [x.kind, x.title]), [["doc", "Kairos 结果"], ["link", "Cookbook again"], ["file", "demo.md"]]);
  assert.equal(artifactsLabel(loadArtifacts("s1", d)), "Docs 1 · Links 1 · Files 1");
  assert.equal(artifactsLabel(loadArtifacts("other", d)), "", "per session; nothing shown when empty");
  assert.equal(artifactsLabel(unpinArtifact("s1", "https://decision.brooktang.fun", d)), "Docs 1 · Files 1");
  assert.equal(artifactKind("/Users/b/x.zip"), "file");
});

test("artifacts: secrets in URLs are hidden in text for logs and the agent", () => {
  assert.equal(redactUrl("https://decision.brooktang.fun/leaderboard?token=b0YaZB4yg&x=1"), "https://decision.brooktang.fun/leaderboard?token=…&x=1");
});

test("artifacts: obvious cases are detected (lark-cli docs +create, deploy URLs), ordinary output is not", () => {
  assert.deepEqual(detectArtifacts('lark-cli docs +create --title "Kairos notes"', '{"url":"https://byterum.feishu.cn/docx/AbC123","title":"Kairos notes"}'), [{ url: "https://byterum.feishu.cn/docx/AbC123", title: "Kairos notes" }]);
  assert.deepEqual(detectArtifacts("npm run deploy:relay", "[relay deploy] live at https://rc.brooktang.fun"), [{ url: "https://rc.brooktang.fun" }]);
  assert.deepEqual(detectArtifacts("npx wrangler deploy", "Uploaded\n  https://cookbook.brook.workers.dev\nhttps://dash.cloudflare.com/x"), [{ url: "https://cookbook.brook.workers.dev" }]);
  assert.deepEqual(detectArtifacts("curl https://example.com", "see https://example.com/docs"), []);
  assert.deepEqual(detectArtifacts("cat notes.md", "https://byterum.feishu.cn/docx/Zzz"), [], "reading a doc link is not creating one");
});

test("pin tool: an agent pins and lists with secrets hidden; a lark-cli doc created through bash pins itself", async (t) => {
  const d = dir(); process.env.PIX_ARTIFACTS_DIR = d; t.after(() => delete process.env.PIX_ARTIFACTS_DIR);
  const handlers = {}, tools = {};
  registerArtifacts({ on: (e, f) => (handlers[e] ??= []).push(f), registerTool: x => { tools[x.name] = x; } });
  const ctx = { sessionManager: { getSessionId: () => "sess-a" } };
  for (const f of handlers.session_start) f({}, ctx);
  const r = await tools.pin.execute("1", { title: "Board", url: "https://x.dev/b?token=SECRET" }, undefined, undefined, ctx);
  assert.match(r.content[0].text, /Links 1[\s\S]*Board: https:\/\/x\.dev\/b\?token=…/);
  assert.doesNotMatch(r.content[0].text, /SECRET/);
  for (const f of handlers.tool_result) f({ toolName: "bash", input: { command: "lark-cli docs +create --title Plan" }, content: [{ type: "text", text: "created https://byterum.feishu.cn/docx/NEW1" }] });
  assert.equal(artifactsLabel(loadArtifacts("sess-a", d)), "Docs 1 · Links 1");
  assert.equal(loadArtifacts("sess-a", d)[1].title, "Plan");
});

test("phone: a session's pins show as 'Docs 1 · Links 1 · Files 1' by its title; tapping lists title + URL/path; a file opens in the viewer", async (t) => {
  const { chromium, devices } = await import("playwright");
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const { writeFileSync } = await import("node:fs");
  const token = "pins-token-1234567890abc", home = dir();
  writeFileSync(join(home, "demo.md"), "# Demo\nhello");
  const hub = await startRemoteHub({ token, port: 0, home });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  await fetch(`${base}/agent/s-pins`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Kairos", named: true, cwd: home, busy: false, messages: [{ role: "user", text: "hi" }],
    pinned: [{ title: "Kairos 结果", url: "https://byterum.feishu.cn/docx/AQ", kind: "doc" }, { title: "Cookbook", url: "https://decision.brooktang.fun/leaderboard?token=abc", kind: "link" }, { title: "Demo", url: join(home, "demo.md"), kind: "file" }] }) });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ ...devices["iPhone 13"] });
  await page.addInitScript(() => { localStorage.pixRemoteSession = "s-pins"; });
  await page.goto(`${base}/#token=${token}`);
  const chip = page.locator("#pinnedChip");
  await chip.waitFor({ state: "visible", timeout: 12000 });
  assert.equal(await chip.textContent(), "3", "a pin icon and a count, no words");
  assert.ok((await chip.boundingBox()).height >= 28);
  await chip.click();
  const rows = page.locator("#sheetBody .pin-row");
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).textContent(), /Kairos 结果[\s\S]*byterum\.feishu\.cn\/docx\/AQ/);
  assert.equal(await rows.nth(1).getAttribute("href"), "https://decision.brooktang.fun/leaderboard?token=abc", "the share link with its token, only inside the item");
  await rows.nth(2).click();
  await page.locator("#fileView:not([hidden])").waitFor({ timeout: 8000 });
  assert.equal(await page.locator("#fileTitle").textContent(), "demo.md");
});

test("footer links go straight to targets: one item -> 'Docs 1'; several -> newest title +N; files as file://", () => {
  const d = dir();
  pinArtifact("s", { title: "Kairos 回测结果与图表说明", url: "https://byterum.feishu.cn/docx/A" }, d);
  pinArtifact("s", { title: "Cookbook", url: "https://decision.brooktang.fun" }, d);
  pinArtifact("s", { title: "Cookbook leaderboard", url: "https://decision.brooktang.fun/leaderboard?token=x" }, d);
  pinArtifact("s", { title: "Demo", url: "~/Desktop/Kairos demo.md" }, d);
  assert.deepEqual(artifactLinks(loadArtifacts("s", d), "/Users/b"), [
    { label: "Demo", url: "file:///Users/b/Desktop/Kairos%20demo.md" },
    { label: "Cookbook", url: "https://decision.brooktang.fun/leaderboard?token=x" },
    { label: "+2", url: "" },
  ]);
});
