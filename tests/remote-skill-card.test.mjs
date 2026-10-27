import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { remoteAppHtml } from "../plugins/remote/remote-web.ts";
import { remoteMessages } from "../plugins/remote/remote-state.ts";

const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const pick = prefix => script.split("\n").find(line => line.startsWith(prefix)) ?? assert.fail(`missing ${prefix}`);
const load = (names, globals = {}) => runInNewContext([pick("const esc="), ...names.map(pick), `({${names.map(n => n.replace(/^(function |const |let )/, "").replace(/[=(].*$/, "")).join(",")}})`].join("\n"), globals);

const skillFile = "---\nname: dev\ndescription: Use for software development tasks.\n---\n\n# Dev\n";
const conversation = (path, output = skillFile) => remoteMessages([
  { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path } }] },
  { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: output }] },
]);

test("reading a SKILL.md marks the tool as a loaded skill with name and description", () => {
  const [message] = conversation("/Users/b/.pi/agent/skills/dev/SKILL.md");
  assert.deepEqual(message.tools[0].skill, { name: "dev", description: "Use for software development tasks." });
  const [nested] = conversation("/x/skills/dev/test-ui/SKILL.md", "# no frontmatter");
  assert.deepEqual(nested.tools[0].skill, { name: "test-ui", description: "" });
});

test("ordinary reads are not skills", () => {
  const [message] = conversation("/repo/README.md");
  assert.equal(message.tools[0].skill, undefined);
});

test("loaded skills show as their own visible row, outside the folded tool group", () => {
  const app = load(["function tool(", "function skillRow(", "function activity("], { imagesHtml: () => "" });
  const html = app.activity([
    { id: "a", name: "read", label: "/s/dev/SKILL.md", output: "x", skill: { name: "dev", description: "Use for <dev>." } },
    { id: "b", name: "bash", label: "ls", output: "ok" },
  ], "g1");
  const [before] = html.split('<details class="activity"');
  assert.match(before, /class="skill-row"/);
  assert.match(before, /<b>dev<\/b>/);
  assert.match(before, /Use for &lt;dev&gt;\./);
  assert.match(html, /<span class="count">1 tool<\/span>/, "the skill is not counted as a folded tool");

  const only = app.activity([{ id: "a", name: "read", output: "x", skill: { name: "dev", description: "" } }], "g2");
  assert.doesNotMatch(only, /class="activity"/, "no empty tool group when only skills loaded");
});
