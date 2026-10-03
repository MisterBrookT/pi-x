import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderQuestion } from "../extensions/question.ts";

const plain = { fg: (_c, t) => t, bold: t => t };
const options = [
  { label: "Now", description: "Set up the package and release it" },
  { label: "Later", description: "Keep one package for now" },
  { label: "Something else", description: "Type your own answer", isOther: true },
];

test("question picker is a quiet Codex-style list: no borders, numbered, aligned descriptions, key hint", () => {
  const lines = renderQuestion({ question: "When should I split it?", options, selected: 1, editMode: false, editorLines: [] }, 80, plain);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /─/, "no rule lines");
  assert.match(text, /^  When should I split it\?$/m);
  assert.match(text, /^    1\. Now {13}Set up the package and release it$/m, "descriptions line up in one column");
  assert.match(text, /^  › 2\. Later {11}Keep one package for now$/m, "› marks the current option");
  assert.match(text, /1–3 or enter to choose/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80);
});

test("narrow terminals put descriptions under the option and never overflow", () => {
  const lines = renderQuestion({ question: "When should I split the remote package out of the bundle?", options, selected: 0, editMode: false, editorLines: [] }, 34, plain);
  assert.match(lines.join("\n"), /^  › 1\. Now\n       Set up the package and/m);
  for (const line of lines) assert.ok(visibleWidth(line) <= 34, JSON.stringify(line));
});
