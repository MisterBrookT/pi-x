import test from "node:test";
import assert from "node:assert/strict";
import { WordCompletion, wordPrefix } from "../plugins/editor/word-completion.ts";

test("word completion accepts prose words and rejects code-like tokens", () => {
  assert.equal(wordPrefix("please comp"), "comp");
  assert.equal(wordPrefix("x"), undefined);
  assert.equal(wordPrefix("src/comp"), undefined);
  assert.equal(wordPrefix("issue123"), undefined);
});

test("word completion caches an asynchronous suffix and requests repaint", async () => {
  const completion = new WordCompletion(async prefix => `${prefix}letion`);
  let updates = 0;
  completion.onUpdate = () => updates++;
  assert.equal(completion.suffix("comp"), undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completion.suffix("comp"), "letion");
  assert.equal(updates, 1);
});

test("inline completion is word-level only: no phrases, no commands, nothing stale after the word ends", async () => {
  const { completionSuggestion } = await import("../plugins/editor/index.ts");
  const words = { suffix: (text) => (/comp$/.test(text) ? "letion" : /hel$/.test(text) ? "lo there friend" : undefined) };
  assert.equal(completionSuggestion("auto comp", words), "letion");
  assert.equal(completionSuggestion("hel", words), undefined, "multi-word ghost text is never offered");
  assert.equal(completionSuggestion("/comp", words), undefined, "slash commands keep Pi's own completion");
  assert.equal(completionSuggestion("auto comp ", words), undefined, "typing past the word drops the stale suggestion");
  assert.equal(completionSuggestion("", words), undefined);
});
