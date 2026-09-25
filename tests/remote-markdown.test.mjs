import test from "node:test";
import assert from "node:assert/strict";
import { renderRemoteMarkdown } from "../src/remote-markdown.ts";
import { remoteMessages } from "../src/remote-state.ts";

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
