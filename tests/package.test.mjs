import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
const root=new URL("..",import.meta.url);
test("Pix exposes only its focused capability set",async()=>{const j=JSON.parse(await readFile(new URL("package.json",root)));const e=j.pi.extensions.join("\n");for(const x of ["./extensions/upstream-tools.ts","./extensions/capabilities.ts"]) assert.ok(e.includes(x));assert.equal(j["pi-subagents"],undefined);assert.equal(j.pi.skills,undefined);});
test("prompt snapshots and comparison exist",async()=>{for(const p of ["docs/prompts/pi-default.txt","docs/prompts/pix-default.txt","docs/system-prompts.html"])await access(new URL(p,root));});

test("slash commands stay minimal", async () => {
  const capabilities = await readFile(new URL("extensions/capabilities.ts", root), "utf8");
  const fast = await readFile(new URL("extensions/fast-mode.ts", root), "utf8");
  const upstream = await readFile(new URL("extensions/upstream-tools.ts", root), "utf8");
  const todo = await readFile(new URL("extensions/todo.ts", root), "utf8");
  const smartEditor = await readFile(new URL("extensions/smart-editor.ts", root), "utf8");
  for (const dependency of ["pi-subagents", "pi-web-access", "@narumitw/pi-lsp"]) assert.match(upstream, new RegExp(dependency));
  assert.match(upstream, /property === "registerCommand"/);
  assert.match(upstream, /PI_SUBAGENT_MAX_DEPTH/);
  assert.match(upstream, /Math\.min\(requestedConcurrency, 4\)/);
  assert.match(upstream, /Math\.min\(requestedSpawns, 8\)/);
  // Tool on/off lives in /tool alone. The per-family toggles were removed
  // because they duplicated it and wrote to a record that could contradict it.
  const toolPanel = await readFile(new URL("extensions/tool.ts", root), "utf8");
  assert.match(toolPanel, /registerCommand\("tool"/);
  for (const removed of ["websearch", "computer", "mcp"]) {
    assert.doesNotMatch(capabilities, new RegExp(`registerCommand\\("${removed}"`));
  }
  assert.match(capabilities, /registerCommand\("subagent-config"/);
  assert.match(fast, /registerCommand\("fast"/);
  assert.match(fast, /Usage: \/fast \[on\|off\|status\]/);
  assert.match(fast, /getArgumentCompletions/);
  assert.match(toolPanel, /getArgumentCompletions/);
  assert.match(capabilities, /configureSubagentRoles/);
  assert.match(upstream, /configureSubagentRoles/);
  assert.match(upstream, /registerCapabilityAction\(pi, "subagent"/);
  assert.doesNotMatch(capabilities, /critic/);
  assert.match(todo, /registerCommand\("todo"/);
  assert.doesNotMatch(todo, /registerCommand\("todos"/);
  assert.match(todo, /Usage: \/todo \[on\|off\]/);
  assert.match(todo, /parentId/);
  assert.match(todo, /theme\.fg\("accent"/);
  assert.match(todo, /prepareArguments/);
  assert.match(todo, /getArgumentCompletions/);
  const historyCompletion = await readFile(new URL("extensions/history-completion.ts", root), "utf8");
  assert.match(historyCompletion, /historySuggestion/);
  assert.doesNotMatch(historyCompletion, /addAutocompleteProvider/);
  assert.match(smartEditor, /registerHistoryCompletion\(pi\)/);
  assert.match(smartEditor, /CURSOR_MARKER/);
  assert.match(smartEditor, /editorTheme\.selectList\.description/);
  assert.doesNotMatch(smartEditor, /uiTheme\.fg/);
  assert.match(smartEditor, /super\(tui, editorTheme, keybindings\)/);
  await access(new URL("extensions/question.ts", root));
});

/**
 * The command list is the user-facing surface, so its size is a contract, not
 * an implementation detail. Verbs live under a parent command instead of
 * claiming another top-level name.
 */
test("Pix keeps seven top-level slash commands", async () => {
  // ai-completion is loaded by smart-editor rather than by the manifest, so the
  // whole extension tree is scanned instead of the declared entry points.
  const names = [];
  for (const entry of await readdir(new URL("extensions/", root), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = await readFile(new URL(`${entry.parentPath}/${entry.name}`, root), "utf8");
    for (const match of source.matchAll(/pi\.registerCommand\("([^"]+)"/g)) names.push(match[1]);
  }
  assert.deepEqual(names.sort(), [
    "complete",
    "context",
    "fast",
    "footer",
    "subagent-config",
    "todo",
    "tool",
  ]);
});

/**
 * Computer use is a `/tool` capability, so its maintenance actions are verbs on
 * that row. A second top-level command would name one optional capability in
 * the command list twice over.
 */
test("computer-use actions live under /tool, and the prompt export under a shortcut", async () => {
  const computer = await readFile(new URL("extensions/computer.ts", root), "utf8");
  assert.doesNotMatch(computer, /registerCommand\(/);
  assert.match(computer, /registerCapabilityAction\(pi, "computer", \{\n\t\tverb: "check"/);
  assert.match(computer, /verb: "stop"/);
  const toolPanel = await readFile(new URL("extensions/tool.ts", root), "utf8");
  assert.match(toolPanel, /capabilityActions/);
  const context = await readFile(new URL("extensions/context.ts", root), "utf8");
  assert.match(context, /registerShortcut\("alt\+e"/);
  assert.doesNotMatch(context, /getArgumentCompletions/);
});

test("the benchmark is a delivery check, not a slash command", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.scripts.bench, "node scripts/bench.mjs");
  await access(new URL("scripts/bench.mjs", root));
  await assert.rejects(access(new URL("extensions/benchmark.ts", root)));
  await assert.rejects(access(new URL("extensions/prompt-inspector.ts", root)));
});
