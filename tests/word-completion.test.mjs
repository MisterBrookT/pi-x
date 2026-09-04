import test from "node:test";
import assert from "node:assert/strict";
import { WordCompletion, wordPrefix } from "../src/word-completion.ts";

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
