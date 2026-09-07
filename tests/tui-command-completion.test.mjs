import test from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider, Editor } from "@earendil-works/pi-tui";
import registerCapabilities from "../extensions/capabilities.ts";

const plain = (text) => text;
const theme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

/**
 * Subagent configuration is reachable in Pi's real editor.
 *
 * `/subagent config` became `/subagent-config` when the `/subagent` toggle was
 * removed: on/off moved to `/tool`, and what remained was a settings editor,
 * not a toggle with an argument. The command still has to complete for a user
 * who types the prefix, which is what this checks against the real editor.
 */
test("subagent configuration completes in Pi's editor", async () => {
  const commands = new Map();
  registerCapabilities({
    on() {},
    registerCommand(name, options) { commands.set(name, options); },
  });
  const config = commands.get("subagent-config");
  assert.ok(config, "the settings editor keeps its own command");
  assert.equal(commands.get("subagent"), undefined, "the redundant toggle is gone");

  const provider = new CombinedAutocompleteProvider([{ name: "subagent-config", ...config }], process.cwd(), null);
  const editor = new Editor({ requestRender() {}, terminal: { rows: 24 } }, theme);
  editor.setAutocompleteProvider(provider);
  for (const character of "/subagent") {
    editor.handleInput(character);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  const rendered = editor.render(80).join("\n");
  assert.match(rendered, /subagent-config/);
  // The real editor truncates the description to the terminal width.
  assert.match(rendered, /Configure subagent role models, thinking level/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/subagent-config ");
});
