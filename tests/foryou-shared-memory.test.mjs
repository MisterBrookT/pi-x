import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const mem = await jiti.import("../plugins/foryou/proactive-memory.ts");
const forYou = (await jiti.import("../plugins/foryou/index.ts")).default;

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "mem-"));
  mkdirSync(join(d, "memory", "lines"), { recursive: true });
  mkdirSync(join(d, "memory", "people"), { recursive: true });
  writeFileSync(join(d, "memory", "index.md"), "# Proactive memory\n\n## About me\n- brook is a PhD student\n");
  writeFileSync(join(d, "memory", "lines", "kairos-launch.md"), "# Kairos launch\n- Lowes wants charts named Kairos\n");
  writeFileSync(join(d, "memory", "lines", "phd.md"), "# PhD\n- AAAI rebuttal due Nov 3\n");
  writeFileSync(join(d, "memory", "people", "Lowes.md"), "# Lowes\n- runs the Kairos launch\n");
  writeFileSync(join(d, "memory", "people", "朱闽峰.md"), "# 朱闽峰\n- lab mentor\n");
  writeFileSync(join(d, "lines.json"), JSON.stringify([
    { id: "kairos-launch", name: "Kairos launch", state: "", updated: "", owner: { id: "S-KAIROS", name: "minara", status: "", at: "" } },
    { id: "phd", name: "PhD", state: "", updated: "" },
  ]));
  return d;
}

test("lines/<id> is a memory card, listed with the others", () => {
  assert.equal(mem.cardName("lines/kairos-launch"), "lines/kairos-launch");
  const d = fixture();
  assert.deepEqual(mem.listCards(d).map(c => c.name).filter(n => n.startsWith("lines/")), ["lines/kairos-launch", "lines/phd"]);
});

test("a line session reads about brook, its own line card and the people it names, not other lines", () => {
  const text = mem.lineMemory(fixture(), "kairos-launch");
  assert.match(text, /brook is a PhD student/);
  assert.match(text, /Lowes wants charts named Kairos/);
  assert.match(text, /runs the Kairos launch/, "people named on the card come along");
  assert.doesNotMatch(text, /AAAI rebuttal/, "another line's card stays out");
  assert.doesNotMatch(text, /lab mentor/);
});

async function session(d, sessionId) {
  const tools = new Map(), handlers = new Map(); let active = ["read"];
  const pi = {
    registerTool: t => tools.set(t.name, t), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on: (e, f) => handlers.set(e, [...(handlers.get(e) ?? []), f]), events: { on() { return () => {}; }, emit() {} },
    getActiveTools: () => active, setActiveTools: a => { active = a; }, sendMessage() {}, appendEntry() {},
  };
  forYou(pi, { dir: d, sessions: async () => [], badge() {}, summarize: async () => {} });
  const ctx = { sessionManager: { getSessionId: () => sessionId }, mode: "print", cwd: d, ui: {} };
  let prompt;
  for (const f of handlers.get("before_agent_start") ?? []) { const r = await f({ systemPrompt: "BASE" }, ctx); if (r?.systemPrompt) prompt = r.systemPrompt; }
  return { tools, active: () => active, prompt, ctx };
}

test("the owner session of a line gets the shared memory and can write to it, saved under its name", async () => {
  const d = fixture();
  const s = await session(d, "S-KAIROS");
  assert.ok(s.active().includes("memory"), "memory tool on for a line owner");
  assert.match(s.prompt, /Shared memory \(line "Kairos launch", id kairos-launch\)/);
  assert.match(s.prompt, /Lowes wants charts named Kairos/);
  await s.tools.get("memory").execute("x", { card: "lines/kairos-launch", add: ["First live trade on Monday"] }, undefined, undefined, s.ctx);
  assert.match(readFileSync(join(d, "memory", "lines", "kairos-launch.md"), "utf8"), /First live trade on Monday \(from minara\)/);
  assert.match(readFileSync(join(d, "memory.log"), "utf8"), /lines\/kairos-launch \+ .*First live trade/);
  const bad = await s.tools.get("memory").execute("x", { card: "foryou", add: ["x"] }, undefined, undefined, s.ctx);
  assert.match(bad.content[0].text, /Nothing changed/, "a line session cannot edit For you's own rules");
});

test("a session that owns no line is untouched: no memory tool, no injected memory", async () => {
  const s = await session(fixture(), "S-OTHER");
  assert.ok(!s.active().includes("memory"));
  assert.equal(s.prompt, undefined);
});

test("a line owner session edits its own jobs' posts with the job tool, not other lines' jobs", async () => {
  const d = fixture();
  writeFileSync(join(d, "inbox.jsonl"), [
    { id: "k1", at: new Date().toISOString(), title: "Ask 恩浩 for V4", why: "w", source: "Feishu", status: "onit", line: "kairos-launch", refs: [] },
    { id: "p1", at: new Date().toISOString(), title: "Rebuttal", why: "w", source: "WeChat", status: "onit", line: "phd", refs: [] },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const s = await session(d, "S-KAIROS");
  assert.ok(s.active().includes("job"));
  const r = await s.tools.get("job").execute("x", { id: "k1", action: "next", text: "Draft ready", button: "Send to 恩浩", draft: "恩浩，V4 的 checkpoint 能发我吗？" }, undefined, undefined, s.ctx);
  assert.match(r.content[0].text, /Updated k1/);
  const { forYouView } = await jiti.import("../plugins/foryou/proactive-store.ts");
  const k1 = forYouView(d).pending.find(i => i.id === "k1");
  assert.equal(k1.button, "Send to 恩浩");
  assert.equal(k1.latest.text, "恩浩，V4 的 checkpoint 能发我吗？");
  const no = await s.tools.get("job").execute("x", { id: "p1", action: "note", text: "x" }, undefined, undefined, s.ctx);
  assert.match(no.content[0].text, /another line/);
  assert.ok(!(await session(d, "S-OTHER")).active().includes("job"));
});
