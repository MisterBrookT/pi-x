import test from "node:test";
import assert from "node:assert/strict";
import { renderRemoteMarkdown } from "../plugins/remote/remote-markdown.ts";
import { remoteMessages } from "../plugins/remote/remote-state.ts";

test("phone renders a real Pi reply as readable Markdown and marks Mac-only references", () => {
  const reply = "That was the **first** attempt. The [later video](file:///Users/brook/run.mp4) passed.\n\n- One\n- Two\n\n```ts\nconst done = true;\n```";
  const [message] = remoteMessages([{ role: "assistant", timestamp: 1, content: [{ type: "text", text: reply }] }]);
  assert.match(message.html, /<strong>first<\/strong>/);
  assert.match(message.html, /<ul>[\s\S]*<li>One<\/li>/);
  assert.match(message.html, /<pre><code class="language-ts">/);
  assert.match(message.html, /later video<small>Mac only<\/small>/);
  assert.doesNotMatch(message.html, /href="file:/);
});

test("remote Markdown escapes HTML and rejects executable or tracking links", () => {
  const html = renderRemoteMarkdown('<script>alert(1)</script>\n\n**<img src=x onerror=alert(2)>** [bad](javascript:alert(3)) [web](https://example.com/?q=%22) ![tracker](https://example.com/pixel)');
  assert.doesNotMatch(html, /<script|<img|href="javascript:|<[^>]+\sonerror=|<[^>]+\ssrc=/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com\/\?q=%22" target="_blank" rel="noopener noreferrer">web<\/a>/);
  assert.match(html, /Image: tracker/);
});

test("phone renders GFM tables in a horizontal scroller with escaped cells", () => {
  const html = renderRemoteMarkdown("| Name | Result |\n|:--|--:|\n| **tests** | 641 <b>x</b> |");
  assert.match(html, /<div class="table-scroll" tabindex="0"><table>/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:left"><strong>tests<\/strong><\/td>/);
  assert.match(html, /<td style="text-align:right">641 &lt;b&gt;x&lt;\/b&gt;<\/td>/);
});

test("phone draws Mermaid as a readable diagram and falls back to source when invalid", () => {
  const html = renderRemoteMarkdown("```mermaid\nflowchart LR\n  A[Phone] --> B[Relay] --> C[Mac]\n```");
  assert.match(html, /<figure class="diagram" aria-label="Mermaid diagram"><pre>/);
  for (const label of ["Phone", "Relay", "Mac"]) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /flowchart LR/, "source is replaced by the drawing");
  const bad = renderRemoteMarkdown("```mermaid\nnot a diagram <script>\n```");
  assert.match(bad, /Diagram could not be drawn/);
  assert.match(bad, /&lt;script&gt;/);
  assert.match(renderRemoteMarkdown("```ts\nconst a = 1 < 2;\n```"), /<pre><code class="language-ts">const a = 1 &lt; 2;/);
});

test("loop prompts Pix wrote fold to a short line with Details; the full text stays; brook's own prose is untouched", async () => {
	const { actPrompt } = await import("../plugins/foryou/proactive.ts");
	const base = actPrompt({ id: "a1", title: "确认是否加入这两个", why: "W", action: "Ask", source: "Knight", howToRead: "feishu msg om_123", status: "pending", at: "", refs: [], sourceKey: "" }, "/tmp/p");
	const text = `brook answered loop a1 with his own instruction. Do this instead of the suggested step:\nlatter\n\n(The loop, for context:)\n${base}`;
	const [m] = remoteMessages([{ role: "user", timestamp: 1, content: text }]);
	assert.equal(m.text, text, "agent-visible content preserved");
	assert.match(m.html, /^<p><b>确认是否加入这两个<\/b><br>You: latter<\/p><details class="loop-ctx"><summary>Details<\/summary><pre>[\s\S]*om_123/);
	const [plain] = remoteMessages([{ role: "user", timestamp: 1, content: "A proactive loop from me: **x**\nWhy: just chatting" }]);
	assert.doesNotMatch(plain.html, /loop-ctx/);
});

test("phone: a folded pix-loop message shows as brook's short line, with the full prompt under Details", async () => {
	const { actPrompt } = await import("../plugins/foryou/proactive.ts");
	const text = `brook tapped "Later" on loop a1. Do it here.\n\n${actPrompt({ id: "a1", title: "T1", why: "W", action: "Ask", source: "K", howToRead: "x", status: "pending", at: "", refs: [], sourceKey: "" }, "/tmp/p")}`;
	const [m] = remoteMessages([{ role: "custom", customType: "pix-loop", display: true, timestamp: 1, content: text }]);
	assert.equal(m.role, "user");
	assert.match(m.html, /^<p><b>T1<\/b><br>You: Later<\/p><details class="loop-ctx">/);
});
