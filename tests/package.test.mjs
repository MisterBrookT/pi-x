import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
const root=new URL("..",import.meta.url);
test("Pix exposes only its focused capability set",async()=>{const j=JSON.parse(await readFile(new URL("package.json",root)));const e=j.pi.extensions.join("\n");for(const x of ["./extensions/upstream-tools.ts","./extensions/capabilities.ts"]) assert.ok(e.includes(x));assert.deepEqual(j["pi-subagents"].agents,["./agents"]);assert.equal(j.pi.skills,undefined);});
test("prompt snapshots and comparison exist",async()=>{for(const p of ["docs/prompts/pi-default.txt","docs/prompts/pix-default.txt","docs/system-prompts.html"])await access(new URL(p,root));});

test("slash commands stay minimal", async () => {
  const capabilities = await readFile(new URL("extensions/capabilities.ts", root), "utf8");
  const upstream = await readFile(new URL("extensions/upstream-tools.ts", root), "utf8");
  const todo = await readFile(new URL("extensions/todo.ts", root), "utf8");
  const bench = await readFile(new URL("extensions/benchmark.ts", root), "utf8");
  const prompt = await readFile(new URL("extensions/prompt-inspector.ts", root), "utf8");
  for (const dependency of ["pi-subagents", "pi-web-access", "@narumitw/pi-lsp"]) assert.match(upstream, new RegExp(dependency));
  assert.match(upstream, /property === "registerCommand"/);
  assert.match(capabilities, /websearch/);
  assert.match(capabilities, /subagent/);
  assert.match(capabilities, /action !== "on" && action !== "off"/);
  assert.match(capabilities, /action === "config"/);
  assert.match(todo, /registerCommand\("todo"/);
  assert.doesNotMatch(todo, /registerCommand\("todos"/);
  assert.match(todo, /Usage: \/todo \[on\|off\]/);
  assert.match(bench, /registerCommand\("bench"/);
  assert.doesNotMatch(bench, /bench speed|bench doctor/);
  assert.match(prompt, /registerCommand\("prompt"/);
  assert.doesNotMatch(prompt, /registerCommand\("pix-prompt"/);
  await access(new URL("extensions/question.ts", root));
  await access(new URL("agents/critic.md", root));
});
