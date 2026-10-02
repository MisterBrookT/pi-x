import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { remoteAppHtml } from "../src/remote-web.ts";
import { remoteMessages } from "../src/remote-state.ts";

const script = remoteAppHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const pick = prefix => script.split("\n").find(line => line.startsWith(prefix)) ?? assert.fail(`missing ${prefix}`);
const load = (names, globals = {}) => runInNewContext([pick("const esc="), ...names.map(pick), `({${names.map(n => n.replace(/^(function |const |let )/, "").replace(/[=(].*$/, "")).join(",")}})`].join("\n"), globals);

test("subagent completion notices become a compact card with status and agent name", () => {
  const scout = "Found things\n".repeat(2000);
  const [message] = remoteMessages([{ role: "custom", customType: "subagent-notify", display: true, timestamp: 1,
    content: `Background task completed: **scout** (map remote UI)\n\n${scout}` }]);
  assert.equal(message.background.kind, "subagent");
  assert.equal(message.background.state, "completed");
  assert.equal(message.background.name, "scout");
  assert.equal(message.background.command, "(map remote UI)");
  assert.ok(message.background.output.length <= 4_100);
  assert.equal(message.html, undefined, "the full scout report must not render as chat prose");

  const [failed] = remoteMessages([{ role: "custom", customType: "subagent-notify", display: true, content: "Background task failed: **worker**\n\nboom" }]);
  assert.deepEqual([failed.background.state, failed.background.name, failed.background.output], ["failed", "worker", "boom"]);
  const [grouped] = remoteMessages([{ role: "custom", customType: "subagent-notify", display: true, content: "Background tasks completed (2): **scout**, **worker** (fix)\n\n1. scout\nlong" }]);
  assert.deepEqual([grouped.background.state, grouped.background.name], ["completed", "scout, worker (fix)"]);
});

test("user messages and unknown custom messages that look like notices stay as text", () => {
  const text = "Background task completed: **scout**\n\nplease read this";
  const [user, other] = remoteMessages([{ role: "user", content: text }, { role: "custom", customType: "something-else", display: true, content: text }]);
  assert.equal(user.background, undefined);
  assert.equal(other.background, undefined);
  assert.match(other.html, /please read this/);
});

test("background cards are collapsed by default and show name and status", () => {
  const app = load(["function background("]);
  const html = app.background({ kind: "subagent", id: "", name: "scout", state: "completed", command: "(map)", output: "big report", truncated: false }, "m1");
  assert.match(html, /^<details class="background[^"]*"(?![^>]*\sopen)/);
  assert.match(html, /<b>scout<\/b><span class="status">completed<\/span>/);
  assert.match(app.background({ id: "1", state: "failed", command: "npm test", output: "", truncated: false }, "m2"), /<b>Job 1<\/b>.*failed.*npm test/);
});

test("pinned sessions come first and survive a reload through localStorage", () => {
  const localStorage = {};
  const app = load(["function pinnedIds(", "function togglePin(", "let sessionOrder", "function sessionGroups("], { localStorage });
  assert.equal(app.pinnedIds().size, 0);
  app.togglePin("b");
  assert.equal(localStorage.pixRemotePins, '["b"]');
  const groups = JSON.parse(JSON.stringify(app.sessionGroups([{ id: "a", busy: true }, { id: "b" }])));
  assert.deepEqual(groups.map(([label, items]) => [label, items.map(s => s.id)]), [["Pinned", ["b"]], ["Sessions", ["a"]]]);
  app.togglePin("b");
  assert.equal(JSON.stringify(app.sessionGroups([{ id: "a" }, { id: "b" }]).map(g => g[0])), '["Sessions"]');
  localStorage.pixRemotePins = "not json";
  assert.equal(app.pinnedIds().size, 0);
});

test("session rows keep a stable order while activity and busy state change", () => {
  const app = load(["function pinnedIds(", "let sessionOrder", "function sessionGroups("], { localStorage: {} });
  const ids = list => JSON.parse(JSON.stringify(app.sessionGroups(list))).flatMap(g => g[1].map(s => s.id));
  assert.deepEqual(ids([{ id: "a" }, { id: "b" }, { id: "c" }]), ["a", "b", "c"]);
  // The hub re-sorts by latest activity on every streaming update; the sidebar must not follow.
  assert.deepEqual(ids([{ id: "c", busy: true }, { id: "a" }, { id: "b", waiting: 1 }]), ["a", "b", "c"]);
  assert.deepEqual(ids([{ id: "d" }, { id: "b" }, { id: "c" }]), ["d", "b", "c"], "a new session appears on top; closed ones drop out");
});

test("session order survives shuffled polls, transient disappearance, reload and pin toggles", () => {
  const localStorage = {};
  const boot = () => load(["function pinnedIds(", "function togglePin(", "let sessionOrder", "function sessionGroups("], { localStorage });
  const ids = (app, list) => JSON.parse(JSON.stringify(app.sessionGroups(list.map(id => ({ id }))))).flatMap(g => g[1].map(s => s.id));
  let app = boot();
  assert.deepEqual(ids(app, ["a", "b", "c", "d"]), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(app, ["d", "b", "a", "c"]), ["a", "b", "c", "d"], "shuffled snapshot");
  assert.deepEqual(ids(app, ["c", "a", "d"]), ["a", "c", "d"], "b briefly missing");
  assert.deepEqual(ids(app, ["b", "d", "c", "a"]), ["a", "b", "c", "d"], "b returns to its old slot, not the top");
  assert.deepEqual(ids(app, ["c", "e", "a", "b", "d"]), ["e", "a", "b", "c", "d"], "only a never-seen session goes on top");
  app = boot();
  assert.deepEqual(ids(app, ["d", "c", "b", "a", "e"]), ["e", "a", "b", "c", "d"], "reload keeps order");
  app.togglePin("c");
  assert.deepEqual(ids(app, ["a", "b", "c", "d", "e"]), ["c", "e", "a", "b", "d"]);
  app.togglePin("c");
  assert.deepEqual(ids(app, ["a", "b", "c", "d", "e"]), ["e", "a", "b", "c", "d"], "unpin restores the original slot");
  localStorage.pixRemoteOrder = "garbage";
  assert.deepEqual(ids(boot(), ["b", "a"]), ["b", "a"]);
});

test("todo bar reflects done, active and pending items and keeps the full list expandable", () => {
  const els = {};
  const $ = id => (els[id] ||= { hidden: false, textContent: "", innerHTML: "" });
  const current = { todos: [{ id: "1", text: "Read", status: "done" }, { id: "2", text: "Fix", status: "active" }, { id: "3", text: "Ship", status: "pending", parentId: "2" }] };
  const app = load(["function renderTodos("], { $, current });
  app.renderTodos();
  assert.equal(els.todoBar.hidden, false);
  assert.equal(els.todoCount.textContent, "1/3");
  assert.equal(els.todoNow.textContent, "Fix");
  assert.equal(els.todoList.innerHTML, '<li class="done">Read</li><li class="active">Fix</li><li class="pending child">Ship</li>');
});
