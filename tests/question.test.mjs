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

test("several questions in one call: header strip, ←→, review page, one submit, labelled answers", async () => {
  const { default: register, renderMulti, askedList } = await import("../plugins/question/index.ts");
  const qs = askedList({ questions: [
    { header: "Scope", question: "How much?", options: [{ label: "Small" }, { label: "Full" }] },
    { header: "Deploy", question: "When?", options: [{ label: "Now" }, { label: "Later" }] },
  ] });
  const strip = renderMulti({ qs, answers: ["Small", undefined], tab: 1, selected: 0, editMode: false, editorLines: [] }, 80, plain).join("\n");
  assert.match(strip, /✓ Scope {2}· {2}Deploy {2}· {2}Submit/);
  assert.match(strip, /←→ questions/);
  assert.match(renderMulti({ qs, answers: ["Small", undefined], tab: 2, selected: 0, editMode: false, editorLines: [] }, 80, plain).join("\n"), /Deploy: not answered[\s\S]*1 left/);

  let tool; const opened = [];
  register({ registerTool: t => { tool = t; }, events: { on: () => () => {}, emit: (n, d) => opened.push(d) } });
  const keys = ["1", "\x1b[C", "\x1b[D", "2", "\r"]; // Small (moves on), → review, ← back, Later, submit
  const ctx = { mode: "tui", ui: { custom: f => new Promise(res => { const c = f({ requestRender() {} }, plain, {}, res); for (const k of keys) c.handleInput(k); }) } };
  const r = await tool.execute("m1", { questions: qs }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "User answered:\nScope: Small\nDeploy: Later");
  assert.equal(opened[0].questions.length, 2, "the phone gets every question");
  assert.match(tool.renderResult(r, {}, plain, {}).render(80).join(""), /Scope: Small · Deploy: Later/);
});

test("several questions: a phone JSON-array answer wins; timeout takes each first option", async () => {
  const { default: register, parseMultiAnswer } = await import("../plugins/question/index.ts");
  assert.deepEqual(parseMultiAnswer('["a"," b "]', 2), ["a", "b"]);
  assert.equal(parseMultiAnswer('["a"]', 2), undefined);
  assert.equal(parseMultiAnswer("a", 2), undefined);
  const qs = [{ header: "A", question: "?", options: [{ label: "A1" }, { label: "A2" }] }, { header: "B", question: "?", options: [{ label: "B1" }] }];
  let tool, listener;
  register({ registerTool: t => { tool = t; }, events: { on: (_n, f) => { listener = f; return () => {}; }, emit() {} } });
  const ctx = { mode: "tui", ui: { custom: f => new Promise(res => { f({ requestRender() {} }, plain, {}, res); listener({ id: "m2", answer: '["A2","my own"]' }); }) } };
  const r = await tool.execute("m2", { questions: qs }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "User answered:\nA: A2\nB: my own (wrote)");
  process.env.PIX_QUESTION_TIMEOUT_MIN = String(0.05 / 60);
  try {
    const idle = { mode: "tui", ui: { custom: f => new Promise(res => { f({ requestRender() {} }, plain, {}, res); }) } };
    const t = await tool.execute("m3", { questions: qs }, undefined, undefined, idle);
    assert.match(t.content[0].text, /defaulted each to its first option:\nA: A1\nB: B1/);
  } finally { delete process.env.PIX_QUESTION_TIMEOUT_MIN; }
});

test("the single-question form still works unchanged", async () => {
  const { askedList } = await import("../plugins/question/index.ts");
  assert.deepEqual(askedList({ question: "Q?", options: [{ label: "x" }] }), [{ header: "", question: "Q?", options: [{ label: "x" }] }]);
});
