import test from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import registerCapabilities from "../extensions/capabilities.ts";

const plain = (text) => text;
const theme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

test("subagent arguments render and complete in Pi's editor", async () => {
  const commands = new Map();
  registerCapabilities({
    on() {},
    registerCommand(name, options) { commands.set(name, options); },
  });
  const subagent = commands.get("subagent");
  assert.ok(subagent);

  const provider = new CombinedAutocompleteProvider([{ name: "subagent", ...subagent }], process.cwd(), null);
  const editor = new Editor({ requestRender() {}, terminal: { rows: 24 } }, theme);
  editor.setAutocompleteProvider(provider);
  for (const character of "/subagent c") {
    editor.handleInput(character);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /config/);
  assert.match(rendered, /Configure role models, thinking, and fallback/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/subagent config");
});
