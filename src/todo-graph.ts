import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface GraphTodo {
  id: string;
  text: string;
  status: "pending" | "active" | "done";
  dependsOn?: string[];
  agent?: string;
  parentId?: string;
}
type Tone = "edge" | "pending" | "active" | "blocked" | "done";
type Paint = (tone: Tone, text: string) => string;
const identity: Paint = (_tone, text) => text;

/** Stable dependency order, not execution waves. Parent IDs are grouping only. */
export function graphOrder<T extends GraphTodo>(items: readonly T[]): T[] {
  const remaining = new Map(items.map(item => [item.id, item]));
  const ordered: T[] = [];
  while (remaining.size) {
    const next = [...remaining.values()].find(item => !(item.dependsOn ?? []).some(id => remaining.has(id)));
    // Persisted data may be malformed; never hang the terminal renderer.
    if (!next) return [...ordered, ...remaining.values()];
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

const UP = 1, RIGHT = 2, DOWN = 4, LEFT = 8;
const junction: Record<number, string> = {
  1: "│", 2: "─", 4: "│", 8: "─", 5: "│", 10: "─",
  3: "└", 6: "┌", 9: "┘", 12: "┐", 7: "├", 11: "┴", 13: "┤", 14: "┬", 15: "┼",
};
interface Row { rail: string; item?: GraphTodo; tone?: Tone; marker?: string }

const nodeLabel = (item: GraphTodo): string => {
  const role = item.agent && item.agent !== "self" ? ` · ${item.agent}` : "";
  return `#${item.id} ${item.text.replace(/\p{Cc}/gu, " ")}${role}`;
};

/** Transpose the same routed graph; no second dependency-layout algorithm. */
function horizontalGraph(rows: Row[], width: number, paint: Paint): string[] | undefined {
  type Column = { nodes?: Map<number, Row>; rail: string };
  const columns: Column[] = [];
  let block: Column | undefined;
  let between: Row[] = [];
  const flush = () => { if (block) columns.push(block); block = undefined; };
  for (const row of rows) {
    if (!row.item) { between.push(row); continue; }
    const lane = row.rail.indexOf(row.marker ?? "○");
    // Independent nodes separated only by straight rails share a column.
    // A branch, join, crossing, or reused lane starts a new column.
    const canPack = block && !block.nodes?.has(lane) && between.every(line => /^[│ ]*$/.test(line.rail));
    if (!canPack) {
      flush();
      if (between.length) columns.push(...between.map(line => ({ rail: line.rail })));
      else if (columns.length) columns.push({ rail: "" });
      block = { nodes: new Map(), rail: "" };
    }
    between = [];
    if (!block) continue;
    block.nodes?.set(lane, row);
    block.rail = Array.from({ length: Math.max(block.rail.length, row.rail.length) }, (_, i) =>
      block?.rail[i] === "│" || row.rail[i] === "│" ? "│" : " ").join("");
  }
  flush();
  columns.push(...between.map(line => ({ rail: line.rail })));
  const widths = columns.map(column => column.nodes
    ? Math.max(...[...column.nodes.values()].map(row => visibleWidth(`${row.marker} ${nodeLabel(row.item as GraphTodo)}`)))
    : 3);
  if (widths.reduce((sum, value) => sum + value, 0) > width) return undefined;
  const transpose: Record<string, string> = { "│": "─", "─": "│", "└": "┐", "┐": "└", "┘": "┘", "┌": "┌", "├": "┬", "┬": "├", "┤": "┴", "┴": "┤", "┼": "┼", "╳": "╳" };
  const fromLeft = (rail: string, y: number) => "│└┘├┤┴┼╳".includes(rail[y] ?? " ");
  const height = Math.max(...rows.map(row => row.rail.length));
  return Array.from({ length: height }, (_, y) => columns.map((column, x) => {
    const size = widths[x];
    const node = column.nodes?.get(y);
    if (node?.item) {
      const label = `${node.marker} ${nodeLabel(node.item)}`;
      const continues = columns[x + 1] && !columns[x + 1].nodes && fromLeft(columns[x + 1].rail, y);
      return paint(node.tone ?? "pending", label) + paint("edge", (continues ? "─" : " ").repeat(size - visibleWidth(label)));
    }
    if (column.nodes) return paint("edge", (column.rail[y] === "│" ? "─" : " ").repeat(size));
    const glyph = transpose[column.rail[y]] ?? " ";
    const left = "─┐┘┬┴┼╳".includes(glyph) ? "─" : " ";
    const right = "─┌└┬┴┼╳".includes(glyph) ? "─" : " ";
    return paint("edge", `${left}${glyph}${right}`);
  }).join("").trimEnd()).filter((_line, y) => rows.some(row => row.rail[y]?.trim()));
}

/**
 * Route a git-log-style downward DAG, then transpose/pack it when it fits
 * horizontally. Each occupied lane leads to one future task.
 * Branches create lanes; multiple prerequisites join the target's lane. A task
 * is printed once, not repeated as an edge label. Crossings use ╳, not a join.
 */
export function renderTodoGraph(items: readonly GraphTodo[], width: number, paint: Paint = identity): string[] {
  if (width <= 0 || !items.length) return [];
  const ordered = graphOrder(items);
  // Keep the widget bounded, including completed prerequisite nodes. /todo has
  // the full plan. Prefer remaining tasks and their immediate prerequisites.
  const open = ordered.filter(item => item.status !== "done");
  if (!open.length) return [];
  const wanted = new Set(open.slice(0, 6).map(item => item.id));
  for (const item of open.slice(0, 6)) for (const id of item.dependsOn ?? []) wanted.add(id);
  const selected = ordered.filter(item => wanted.has(item.id));
  const visible = selected.length <= 12 ? selected : selected.slice(-12);
  const visibleIds = new Set(visible.map(item => item.id));
  const byId = new Map(items.map(item => [item.id, item]));
  const relevant = new Set(open.map(item => item.id));
  // Count omitted ancestors too, but don't advertise unrelated finished work.
  for (const id of relevant) for (const parent of byId.get(id)?.dependsOn ?? []) relevant.add(parent);
  const hidden = relevant.size - visible.length;
  const outside = visible.some(item => (item.dependsOn ?? []).some(id => !visibleIds.has(id)));
  const children = new Map(visible.map(item => [item.id, visible.filter(child => child.dependsOn?.includes(item.id)).map(child => child.id)]));
  const lanes: (string | undefined)[] = [];
  const rows: Row[] = [];
  let crossing = false;
  const free = () => {
    const hole = lanes.indexOf(undefined);
    return hole < 0 ? lanes.length : hole;
  };
  const trim = () => { while (lanes.length && lanes.at(-1) === undefined) lanes.pop(); };
  for (const item of visible) {
    let lane = lanes.indexOf(item.id);
    if (lane < 0) { lane = free(); lanes[lane] = item.id; }
    const blocked = (item.dependsOn ?? []).some(id => byId.get(id)?.status !== "done");
    const tone = item.status === "done" ? "done" : item.status === "active" ? "active" : blocked ? "blocked" : "pending";
    const marker = { done: "✓", active: "›", blocked: "◌", pending: "○" }[tone];
    rows.push({ rail: lanes.map((target, i) => i === lane ? marker : target ? "│" : " ").join(" "), item, tone, marker });
    lanes[lane] = undefined;
    const through = new Set(lanes.flatMap((target, i) => target ? [i] : []));
    const targets: number[] = [];
    for (const child of children.get(item.id) ?? []) {
      let target = lanes.indexOf(child);
      if (target < 0) {
        target = !lanes[lane] ? lane : free();
        lanes[target] = child;
      }
      targets.push(target);
    }
    const bits = Array.from({ length: Math.max(lanes.length, lane + 1) * 2 - 1 }, () => 0);
    for (const column of through) bits[column * 2] |= UP | DOWN;
    for (const target of targets) {
      bits[lane * 2] |= UP;
      bits[target * 2] |= DOWN;
      const start = Math.min(lane, target) * 2, end = Math.max(lane, target) * 2;
      for (let x = start; x < end; x++) { bits[x] |= RIGHT; bits[x + 1] |= LEFT; }
    }
    trim();
    if (!lanes.length) continue;
    const rail = bits.map((bit, x) => {
      // A line passing over an unrelated lane is not a new dependency.
      if (bit === 15 && through.has(x / 2) && !targets.includes(x / 2)) { crossing = true; return "╳"; }
      return junction[bit] ?? " ";
    }).join("").trimEnd();
    rows.push({ rail });
  }
  // Fall back to a clearly labelled list if lanes and IDs cannot fit. Never
  // silently crop the graph and invent/misrepresent edges.
  const needed = Math.max(0, ...rows.map(row => row.rail.length + (row.item ? row.item.id.length + 4 : 0)));
  const graphFits = needed <= width;
  const horizontal = horizontalGraph(rows, width, paint);
  const lines: string[] = horizontal ?? [];
  if (!horizontal && !graphFits) lines.push(truncateToWidth(paint("edge", "Graph too wide · /todo"), width, ""));
  for (const row of horizontal ? [] : rows) {
    if (!row.item) {
      if (graphFits) lines.push(paint("edge", row.rail));
      continue;
    }
    const label = nodeLabel(row.item);
    const rail = graphFits ? row.rail : row.marker ?? "○";
    lines.push(`${paint(row.tone ?? "pending", rail)} ${truncateToWidth(paint(row.tone ?? "pending", label), Math.max(0, width - visibleWidth(rail) - 1), "")}`);
  }
  if (crossing && graphFits) lines.push(truncateToWidth(paint("edge", "╳ crossing, not a join"), width, ""));
  if (hidden || outside) lines.push(truncateToWidth(paint("edge", `… ${hidden} hidden${outside ? " · dependencies outside view" : ""} · /todo`), width, ""));
  return lines.map(line => truncateToWidth(line, width, ""));
}
