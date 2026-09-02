import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
const root=new URL("..",import.meta.url);
test("Pix exposes only its focused capability set",async()=>{const j=JSON.parse(await readFile(new URL("package.json",root)));const e=j.pi.extensions.join("\n");for(const x of ["pi-subagents","pi-web-access","pi-lsp","./extensions/*.ts"]) assert.ok(e.includes(x));assert.equal(j.pi.skills,undefined);});
test("prompt snapshots and comparison exist",async()=>{for(const p of ["docs/prompts/pi-default.txt","docs/prompts/omp-default-template.txt","docs/system-prompts.html"])await access(new URL(p,root));});

test("slash commands are singular and bounded", async () => {
  const todo = await readFile(new URL("extensions/todo.ts", root), "utf8");
  const bench = await readFile(new URL("extensions/benchmark.ts", root), "utf8");
  assert.match(todo, /registerCommand\("todo"/);
  assert.doesNotMatch(todo, /registerCommand\("todos"/);
  assert.match(bench, /registerCommand\("bench"/);
  assert.match(bench, /action === "speed"/);
  assert.match(bench, /action !== "doctor"/);
});
