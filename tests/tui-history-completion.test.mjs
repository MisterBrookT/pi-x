import test from "node:test";
import assert from "node:assert/strict";
import registerHistoryCompletion, { historySuggestion } from "../extensions/history-completion.ts";
import smartEditor, { completionSuggestion } from "../extensions/smart-editor.ts";

test("history completion follows zsh-style prompt-prefix matching", () => {
  const history = [
    "relaunch Minara Dev and record the full journey",
    "please check the current branch and run the relevant tests",
  ];
  assert.equal(historySuggestion(history, "r"), "elaunch Minara Dev and record the full journey");
  assert.equal(historySuggestion(history, "Rela"), undefined);
  assert.equal(historySuggestion(history, "Now please check the current"), undefined);
  assert.equal(historySuggestion(history, "unrelated rela"), undefined);
  assert.equal(historySuggestion(["relaunch Minara once", "relaunch Minara twice"], "relaunch Minara"), " twice");
  assert.equal(historySuggestion(history, "/subagent "), undefined);
});

test("history completion has strict priority over word completion", () => {
  let wordLookups = 0;
  const wordCompletion = { suffix() { wordLookups++; return "letion"; } };

  assert.equal(completionSuggestion("comp", () => "ile the project", wordCompletion), "ile the project");
  assert.equal(wordLookups, 0, "a history match must short-circuit dictionary lookup");
  assert.equal(completionSuggestion("comp", () => undefined, wordCompletion), "letion");
  assert.equal(wordLookups, 1, "word completion is the fallback");
  assert.equal(completionSuggestion("/compact", () => " history", wordCompletion), undefined);
  assert.equal(wordLookups, 1, "slash commands bypass both inline completers");
});

test("extension tracks current-branch user prompts for inline completion", () => {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  const suggest = registerHistoryCompletion(pi);
  handlers.get("session_start")({}, {
    mode: "tui",
    sessionManager: {
      getBranch: () => [{
        type: "message",
        message: { role: "user", content: "relaunch Minara Dev and record the full journey" },
      }],
    },
  });
  assert.equal(suggest("relaunch Minara"), " Dev and record the full journey");
  handlers.get("message_end")({ message: { role: "user", content: "review the final implementation" } });
  assert.equal(suggest("review"), " the final implementation");
});

test("TUI journey renders a visible history ghost and accepts it with Tab", () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
  };
  smartEditor(pi);
  let factory;
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: "relaunch Minara" } }],
    },
    ui: {
      // Deliberately not a full Theme: Pi 0.85 passes EditorTheme to editor factories.
      theme: { fg: undefined },
      setEditorComponent(value) { factory = value; },
    },
  };
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  const plain = text => text;
  const secondary = text => `<secondary>${text}</secondary>`;
  const editor = factory(
    { requestRender() {}, terminal: { rows: 24 } },
    { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: secondary, scrollInfo: plain, noMatch: plain } },
    { matches: () => false },
  );
  editor.focused = true;
  editor.setText("rel");
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /<secondary>aunch Minara<\/secondary>/, "ghost uses visible secondary text, not the removed dim/full-theme API");
  editor.handleInput("\t");
  assert.equal(editor.getText(), "relaunch Minara");
});
