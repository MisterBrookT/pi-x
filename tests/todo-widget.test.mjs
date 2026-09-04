import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitTodoWidgetLines } from "../extensions/todo.ts";

test("todo widget truncates every line to the available terminal width", () => {
  const lines = [
    "○ #1 Branch from origin/main: fix/data-studio-high-confidence-bugs",
    "  › #1.1 Remove Pix critic role and align role documentation/configuration",
  ];

  for (const width of [51, 65]) {
    const rendered = fitTodoWidgetLines(lines, width);
    assert.equal(rendered.length, lines.length);
    assert.ok(rendered.every(line => visibleWidth(line) <= width));
  }
});
