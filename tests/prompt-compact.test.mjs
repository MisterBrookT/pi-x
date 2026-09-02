import test from "node:test";
import assert from "node:assert/strict";
import { compactPixPrompt } from "../src/compact-prompt.ts";

test("compacts upstream subagent and LSP guidance", () => {
  const prompt = [
    "before",
    "- Use subagent only when delegation is needed. detail",
    "- Omit action for execution; detail",
    "- workflowScript rejects nested async function, detail",
    "- Inside workflowScript, use runs.run/runs.all detail",
    "- Keep one writer per cwd/worktree; detail",
    "- Use lsp_diagnostics when files need diagnostics detail",
    "- Use the server parameter only when detail",
    "- If a configured server command is missing, detail",
    "- Use lsp_fix for files handled detail",
    "- Use kind when the server needs detail",
    "after",
  ].join("\n");
  const compact = compactPixPrompt(prompt);
  assert.match(compact, /Use subagents only for genuinely independent work/);
  assert.match(compact, /Use LSP for targeted diagnostics/);
  assert.doesNotMatch(compact, /workflowScript rejects/);
  assert.equal(compact.split("\n").length, 4);
});
