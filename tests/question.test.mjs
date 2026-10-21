import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderQuestion } from "../plugins/question/index.ts";

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

test("number and j/k keys also work under the Kitty keyboard protocol", async () => {
  const { keyChar } = await import("../plugins/question/index.ts");
  assert.equal(keyChar("2"), "2");
  assert.equal(keyChar("\x1b[50u"), "2");
  assert.equal(keyChar("\x1b[106u"), "j");
});

test("the question tool tells the model to ask decisions as choices", async () => {
  let tool;
  const { default: register } = await import("../plugins/question/index.ts");
  register({ registerTool: t => { tool = t; }, events: { on: () => () => {}, emit() {} } });
  assert.ok(tool.promptSnippet);
  assert.match(tool.promptGuidelines.join(" "), /instead of writing the question in your reply/);
});

test("a question nobody answers takes the first option after the timeout, says so to the agent, and shows it", async () => {
  const { default: register, questionTimeoutMs } = await import("../plugins/question/index.ts");
  assert.equal(questionTimeoutMs({}), 15 * 60_000, "default 15 min");
  assert.equal(questionTimeoutMs({ PIX_QUESTION_TIMEOUT_MIN: "2" }), 120_000);
  assert.equal(questionTimeoutMs({ PIX_QUESTION_TIMEOUT_MIN: "0" }), 0, "0 waits forever");
  let tool; const emitted = [];
  register({ registerTool: t => { tool = t; }, events: { on: () => () => {}, emit: (n, d) => emitted.push(n) } });
  process.env.PIX_QUESTION_TIMEOUT_MIN = String(0.05 / 60); // 50 ms
  try {
    // The real ctx.ui.custom contract: a factory gets done(); nobody presses a key.
    const ctx = { mode: "tui", ui: { custom: factory => new Promise(res => { factory({ requestRender() {} }, plain, {}, res); }) } };
    const r = await tool.execute("q1", { question: "Ship now?", options: [{ label: "Ship" }, { label: "Wait" }] }, undefined, undefined, ctx);
    assert.match(r.content[0].text, /brook did not answer within \d+ min; defaulted to: 1\. Ship/);
    assert.equal(r.details.timedOut, true);
    assert.match(tool.renderResult(r, {}, plain, {}).render(80).join(""), /No answer, defaulted to 1\. Ship/);
    assert.ok(emitted.length >= 2, "phone card opens and closes");
  } finally { delete process.env.PIX_QUESTION_TIMEOUT_MIN; }
});
