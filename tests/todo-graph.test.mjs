import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { graphOrder, renderTodoGraph } from "../src/todo-graph.ts";

const plan = rows => rows.map(([text, dependsOn = []], i) => ({ id: String(i + 1), text, dependsOn, status: "pending" }));
const once = (lines, ids) => {
  const rendered = lines.join("\n");
  for (const id of ids) assert.equal([...rendered.matchAll(new RegExp(`#${id}(?![\\d.])`, "g"))].length, 1, `task ${id} must appear exactly once`);
};

test("fan-in and a following chain print each task once, joined by rails", () => {
  const items = plan([["Backend"], ["Frontend"], ["Integrate", ["1", "2"]], ["Test", ["3"]]]);
  const lines = renderTodoGraph(items, 24);
  assert.deepEqual(lines, ["○ #1 Backend", "│", "│ ○ #2 Frontend", "├─┘", "◌ #3 Integrate", "│", "◌ #4 Test"]);
  once(lines, ["1", "2", "3", "4"]);
});

test("a diamond branches and rejoins without copying nodes", () => {
  const lines = renderTodoGraph(plan([["Start"], ["Left", ["1"]], ["Right", ["1"]], ["Join", ["2", "3"]]]), 24);
  assert.deepEqual(lines, ["○ #1 Start", "├─┐", "◌ │ #2 Left", "│ │", "│ ◌ #3 Right", "├─┘", "◌ #4 Join"]);
  once(lines, ["1", "2", "3", "4"]);
});

test("independent work has no connecting edges; parentId adds no dependency", () => {
  const items = plan([["Parent"], ["Child"]]);
  items[1].parentId = "1";
  assert.deepEqual(renderTodoGraph(items, 12), ["○ #1 Parent", "○ #2 Child"]);
  assert.deepEqual(renderTodoGraph(items, 80), ["○ #1 Parent   ○ #2 Child"]);
});

test("unrelated crossing rails are distinguished from joins", () => {
  const items = plan([["A"], ["B"], ["C", ["1", "2"]], ["D", ["1"]]]);
  const lines = renderTodoGraph(items, 12);
  assert.ok(lines.includes("├─╳─┘"));
  assert.match(lines.at(-1), /^╳ crossing/);
  assert.equal(renderTodoGraph(items, 80).at(-1), "╳ crossing, not a join");
  once(lines, ["1", "2", "3", "4"]);
});

test("progress keeps checked prerequisite nodes and the same connections", () => {
  const items = plan([["Backend"], ["Frontend"], ["Integrate", ["1", "2"]]]);
  items[0].status = "done";
  items[1].status = "active";
  const before = structuredClone(items);
  const lines = renderTodoGraph(items, 24);
  assert.deepEqual(lines, ["✓ #1 Backend", "│", "│ › #2 Frontend", "├─┘", "◌ #3 Integrate"]);
  once(lines, ["1", "2", "3"]);
  assert.deepEqual(items, before);
  items.forEach(item => { item.status = "done"; });
  assert.deepEqual(renderTodoGraph(items, 80), []);
});

test("forward dependencies are ordered before their target, without mutating the plan", () => {
  const items = plan([["Join", ["2", "3"]], ["A"], ["B"]]);
  assert.deepEqual(graphOrder(items).map(item => item.id), ["2", "3", "1"]);
  once(renderTodoGraph(items, 80), ["1", "2", "3"]);
  assert.deepEqual(items.map(item => item.id), ["1", "2", "3"]);
});

test("resize preserves nodes and rails; impossible widths explicitly fall back", () => {
  const items = plan([["中文 Backend 👩‍💻"], ["Frontend"], ["Integrate " + "long ".repeat(50), ["1", "2"]]]);
  const paint = (_tone, text) => `\x1b[32m${text}\x1b[0m`;
  for (const width of [0, 1, 4, 12, 24, 80]) {
    const lines = renderTodoGraph(items, width, paint);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 12) once(lines, ["1", "2", "3"]);
  }
  assert.match(renderTodoGraph(items, 7).join("\n"), /Graph/);
  assert.doesNotMatch(renderTodoGraph(items, 24).join("\n"), /Graph too/);
});

test("bounded view reports omitted nodes and dependencies rather than drawing dangling edges", () => {
  const items = plan(Array.from({ length: 20 }, (_, i) => [`Task ${i + 1}`]));
  const lines = renderTodoGraph(items, 80);
  once(lines, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(lines.at(-1), "… 14 hidden · /todo");
  const chain = plan(Array.from({ length: 20 }, (_, i) => [`Task ${i + 1}`, i ? [String(i)] : []]));
  chain.slice(0, 15).forEach(item => { item.status = "done"; });
  const partial = renderTodoGraph(chain, 80);
  assert.match(partial.at(-1), /dependencies outside view/);
});

test("wide terminals pack parallel nodes into one column and chains horizontally", () => {
  const items = plan([["Inspect"], ["Backend", ["1"]], ["Frontend", ["1"]], ["Integrate", ["2", "3"]], ["Verify", ["4"]]]);
  const wide = renderTodoGraph(items, 100);
  assert.deepEqual(wide, [
    "○ #1 Inspect─┬─◌ #2 Backend──┬─◌ #4 Integrate───◌ #5 Verify",
    "             │               │",
    "             └─◌ #3 Frontend─┘",
  ]);
  once(wide, ["1", "2", "3", "4", "5"]);
  const narrow = renderTodoGraph(items, 24);
  assert.ok(narrow.length > wide.length);
  once(narrow, ["1", "2", "3", "4", "5"]);
  assert.deepEqual(renderTodoGraph(items, 100), wide, "widening restores the compact layout");
});

test("horizontal independent branches keep separate rails and no empty rows", () => {
  const lines = renderTodoGraph(plan([["A"], ["B"], ["C", ["1"]], ["D", ["2"]]]), 80);
  assert.deepEqual(lines, ["○ #1 A───◌ #3 C", "○ #2 B───◌ #4 D"]);
});

test("horizontal layout uses terminal-cell width for Unicode labels and ANSI colors", () => {
  const items = plan([["检查 👩‍💻"], ["界面"], ["验证", ["1", "2"]]]);
  const paint = (_tone, text) => `\x1b[32m${text}\x1b[0m`;
  for (const width of [12, 24, 80]) {
    const lines = renderTodoGraph(items, width, paint);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    once(lines, ["1", "2", "3"]);
  }
});

test("titles cannot inject terminal commands or new graph rows", () => {
  const lines = renderTodoGraph(plan([["A\nB\x1b[2J"]]), 80);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\x00-\x1f\x7f-\x9f]/);
});
