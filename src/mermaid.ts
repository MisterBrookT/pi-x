/**
 * Mermaid rendering for the terminal, on top of `lovely-mermaid`.
 *
 * Pi's built-in renderer bundles an older `grok-mermaid` whose parser
 * rejects valid Mermaid that GitHub renders fine. This module renders with
 * the current `lovely-mermaid` and applies one fix that is still upstream
 * (xl0/lovely-mermaid#7): an HTML entity's `;` must not end a statement.
 */

import { render as lovelyRender, toAnsi } from "lovely-mermaid";

/** Longest entity body kept intact, e.g. `&thinsp;`. */
const ENTITY_MAX = 10;

/**
 * Length of the HTML entity at `chars[i]` (`&` through `;`), or 0.
 * Recognises `&name;`, `&#123;` and `&#x1F;`; anything else is a literal `&`.
 */
function entityLength(chars: string[], i: number): number {
  if (chars[i] !== "&") return 0;
  let j = i + 1;
  const hi = Math.min(j + ENTITY_MAX, chars.length);
  if (chars[j] === "#") {
    j++;
    const hex = chars[j] === "x" || chars[j] === "X";
    if (hex) j++;
    const start = j;
    while (j < hi && (hex ? /[0-9a-fA-F]/ : /[0-9]/).test(chars[j] ?? "")) j++;
    if (j === start) return 0;
  } else {
    const start = j;
    while (j < hi && /[A-Za-z0-9]/.test(chars[j] ?? "")) j++;
    if (j === start) return 0;
  }
  return chars[j] === ";" ? j - i + 1 : 0;
}

const NAMED: Record<string, string> = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00A0",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", larr: "\u2190",
  rarr: "\u2192", uarr: "\u2191", darr: "\u2193", times: "\u00D7",
  copy: "\u00A9", deg: "\u00B0", middot: "\u00B7", bull: "\u2022",
};

function decodeEntity(body: string): string | null {
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  }
  return NAMED[body] ?? null;
}

/** Private-use code points stand in for entities while the parser runs. */
const PLACEHOLDER_BASE = 0xe000;

export interface Preprocessed {
  src: string;
  /** Placeholder character to the decoded text it stands for. */
  swaps: Map<string, string>;
}

/**
 * Replace each HTML entity outside a double-quoted span with a single
 * private-use character, so the `;` that terminates it never reaches the
 * statement splitter. Quoted spans are left alone: the parser treats them as
 * opaque and decodes entities inside them itself. The renderer's output is
 * mapped back with `restore`.
 *
 * Substituting rather than decoding keeps Mermaid's meaning: `&quot;` is a
 * literal quote character, not the start of a quoted label.
 *
 * Exported for tests.
 */
export function preprocessEntities(src: string): Preprocessed {
  const chars = [...src];
  const swaps = new Map<string, string>();
  const byText = new Map<string, string>();
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === '"') {
      inQuotes = !inQuotes;
      out += c;
      continue;
    }
    if (inQuotes || c !== "&") {
      out += c;
      continue;
    }
    const len = entityLength(chars, i);
    const decoded = len ? decodeEntity(chars.slice(i + 1, i + len - 1).join("")) : null;
    if (decoded === null) {
      out += c;
      continue;
    }
    let placeholder = byText.get(decoded);
    if (!placeholder) {
      placeholder = String.fromCodePoint(PLACEHOLDER_BASE + swaps.size);
      swaps.set(placeholder, decoded);
      byText.set(decoded, placeholder);
    }
    out += placeholder;
    i += len - 1;
  }
  return { src: out, swaps };
}

function restore(line: string, swaps: Map<string, string>): string {
  if (swaps.size === 0) return line;
  let result = line;
  for (const [placeholder, text] of swaps) result = result.replaceAll(placeholder, text);
  return result;
}

interface StyledSpan { cls: string; text: string; role?: string; classes?: string[]; href?: string }

/** `classDef` fills and colours, keyed by class name, as the author wrote them. */
type ClassDefs = Record<string, Record<string, string>>;

export interface MermaidArt {
  plain: string[];
  styled: StyledSpan[][];
  /** Needed to turn a span's class names into colour; dropping it loses styling. */
  classDefs?: ClassDefs;
  width: number;
  warnings: string[];
}

/**
 * A per-node `style ID fill:#rrggbb,...` statement. Mermaid accepts this as a
 * shorthand for a one-off `classDef`, and models reach for it constantly, but
 * `lovely-mermaid` only understands `classDef` plus `class`.
 */
const STYLE = /^([ \t]*)style[ \t]+([\w-]+)[ \t]+([^\n]+)$/gm;

/**
 * Rewrite `style X fill:...` into the `classDef`/`class` pair that the
 * renderer understands, so a diagram coloured the common way is not drawn as
 * undifferentiated boxes. Each node gets its own generated class, which keeps
 * per-node styles distinct even when two nodes share no properties.
 */
export function stylesToClassDefs(src: string): string {
  const defs: string[] = [];
  const body = src.replace(STYLE, (_raw, indent: string, id: string, props: string) => {
    const name = `pixstyle${defs.length}`;
    defs.push(`${indent}classDef ${name} ${props.trim()}`, `${indent}class ${id} ${name}`);
    return "";
  });
  if (defs.length === 0) return src;
  return `${body.replace(/\n{3,}/g, "\n\n").trimEnd()}\n${defs.join("\n")}`;
}

/**
 * Header of a flowchart/graph declaration, capturing its direction keyword.
 * Also matches a nested `direction LR` inside subgraphs.
 */
const DIRECTION = /^([ \t]*)(flowchart|graph|direction)([ \t]+)(LR|RL|TB|TD|BT)\b/gm;

/** Rewrite every horizontal direction in `src` to top-down. */
function toVertical(src: string): string | null {
  let changed = false;
  const out = src.replace(DIRECTION, (raw, indent, kw, gap, dir) => {
    if (dir !== "LR" && dir !== "RL") return raw;
    changed = true;
    return `${indent}${kw}${gap}${dir === "LR" ? "TD" : "BT"}`;
  });
  return changed ? out : null;
}

/**
 * Render `src`, falling back to a top-down layout when the requested
 * horizontal one does not fit in `width`. Terminal art cannot be scaled down
 * like an image, so re-laying the diagram out is the only way to keep it
 * readable in a narrow pane. Returns the widest rendering that fits, or the
 * original when nothing does, so the caller can decide what to do.
 */
export function renderFitted(src: string, width: number): MermaidArt {
  const art = renderMermaid(src);
  if (art.warnings.length > 0 || art.width <= width) return art;
  const vertical = toVertical(src);
  if (vertical === null) return compactSequence(src, width) ?? art;
  const alt = renderMermaid(vertical);
  if (alt.warnings.length > 0 || alt.plain.length === 0 || alt.width > width) return art;
  return alt;
}

/** Sequence arrow operators, longest first so `-->>` is not read as `->`. */
const SEQ_ARROWS: Array<[string, { line: string; head: string }]> = [
  ["-->>", { line: "╌", head: "▶" }],
  ["->>", { line: "─", head: "▶" }],
  ["--x", { line: "╌", head: "×" }],
  ["-x", { line: "─", head: "×" }],
  ["--)", { line: "╌", head: ")" }],
  ["-)", { line: "─", head: ")" }],
  ["-->", { line: "╌", head: "" }],
  ["->", { line: "─", head: "" }],
];
const LEFT_HEAD: Record<string, string> = { "▶": "◀", "×": "×", ")": "(", "": "" };

const SEQ_PARTICIPANT = /^participant[ \t]+(\w+)(?:[ \t]+as[ \t]+(.+))?$/;
const SEQ_MESSAGE = /^(\w+)[ \t]*(-->>|->>|--x|-x|--\)|-\)|-->|->)[ \t]*(\w+)[ \t]*:[ \t]*(.*)$/;

/** Narrowest column (box plus gap) a compact sequence participant may get. */
const COMPACT_MIN_COLUMN = 7;

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while ([...word].length > width) {
      if (cur) { lines.push(cur); cur = ""; }
      const chars = [...word];
      lines.push(chars.slice(0, width).join(""));
      word = chars.slice(width).join("");
    }
    if (!cur) cur = word;
    else if ([...cur].length + 1 + [...word].length <= width) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function decodeLabel(text: string): string {
  const { src, swaps } = preprocessEntities(text.replace(/<br\s*\/?>/gi, " "));
  return restore(src, swaps).replace(/^"(.*)"$/, "$1").trim();
}

/**
 * A too-wide sequence diagram redrawn in equal narrow columns: participant
 * boxes wrap their labels, lifelines run below them, and each message's text
 * is wrapped onto its own rows above a solid/dashed arrow between the two
 * lifelines. Only participant declarations and messages between distinct
 * participants are understood; anything else returns null so the caller
 * keeps the original rendering.
 */
function compactSequence(src: string, width: number): MermaidArt | null {
  const lines = src.split("\n").map((l) => l.trim());
  const first = lines.findIndex((l) => l && !l.startsWith("%%"));
  if (first < 0 || lines[first] !== "sequenceDiagram") return null;
  const order: string[] = [];
  const labels = new Map<string, string>();
  const see = (id: string) => { if (!labels.has(id)) { labels.set(id, id); order.push(id); } };
  const messages: Array<{ from: string; op: string; to: string; text: string }> = [];
  for (const line of lines.slice(first + 1)) {
    if (!line || line.startsWith("%%")) continue;
    const p = SEQ_PARTICIPANT.exec(line);
    if (p) {
      const id = p[1] as string;
      see(id);
      if (p[2]) labels.set(id, decodeLabel(p[2]));
      continue;
    }
    const m = SEQ_MESSAGE.exec(line);
    if (!m || m[1] === m[3]) return null;
    see(m[1] as string);
    see(m[3] as string);
    messages.push({ from: m[1] as string, op: m[2] as string, to: m[3] as string, text: decodeLabel(m[4] as string) });
  }
  if (messages.length === 0) return null;
  const col = Math.floor(width / order.length);
  if (col < COMPACT_MIN_COLUMN) return null;
  const inner = col - 4;
  const center = order.map((_, i) => i * col + Math.floor(col / 2));
  const total = (order.length - 1) * col + col;
  const blank = () => Array.from({ length: total }, () => " ");
  const lifelines = () => { const r = blank(); for (const c of center) r[c] = "│"; return r; };
  const put = (row: string[], at: number, text: string) => [...text].forEach((ch, k) => { row[at + k] = ch; });
  const rows: string[][] = [];
  const boxes = order.map((id) => wrapText(labels.get(id) as string, inner));
  const boxHeight = Math.max(...boxes.map((b) => b.length));
  for (let r = 0; r < boxHeight + 2; r++) {
    const row = blank();
    order.forEach((_, i) => {
      const left = i * col + 1;
      const w = inner + 2;
      if (r === 0) put(row, left, `┌${"─".repeat(w - 2)}┐`);
      else if (r === boxHeight + 1) {
        put(row, left, `└${"─".repeat(w - 2)}┘`);
        row[center[i] as number] = "┬";
      } else {
        const text = (boxes[i] as string[])[r - 1] ?? "";
        const pad = inner - [...text].length;
        put(row, left, `│${" ".repeat(Math.floor(pad / 2))}${text}${" ".repeat(pad - Math.floor(pad / 2))}│`);
      }
    });
    rows.push(row);
  }
  for (const msg of messages) {
    const style = SEQ_ARROWS.find(([op]) => op === msg.op)?.[1] as { line: string; head: string };
    const a = center[order.indexOf(msg.from)] as number;
    const b = center[order.indexOf(msg.to)] as number;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    rows.push(lifelines());
    if (msg.text) {
      for (const l of wrapText(msg.text, hi - lo - 3)) {
        const row = lifelines();
        put(row, lo + 2, l);
        rows.push(row);
      }
    }
    const row = lifelines();
    for (let c = lo + 1; c < hi; c++) row[c] = style.line;
    if (style.head) {
      if (b > a) row[hi - 1] = style.head;
      else row[lo + 1] = LEFT_HEAD[style.head] as string;
    }
    rows.push(row);
  }
  rows.push(lifelines());
  const out = rows.map((r) => r.join("").trimEnd());
  const w = Math.max(...out.map((l) => [...l].length));
  if (w > width) return null;
  return {
    plain: out,
    styled: out.map((text) => [{ cls: "", role: "none", text }]),
    width: w,
    warnings: [],
  };
}

export function renderMermaid(src: string): MermaidArt {
  const { src: prepared, swaps } = preprocessEntities(stylesToClassDefs(src));
  const art = lovelyRender(prepared) as MermaidArt;
  return {
    plain: art.plain.map((line) => restore(line, swaps)),
    styled: art.styled.map((row) => row.map((span) => ({ ...span, text: restore(span.text, swaps) }))),
    classDefs: art.classDefs,
    width: art.width,
    warnings: art.warnings ?? [],
  };
}

/**
 * The diagram as ANSI-coloured lines, so `classDef` fills and font colours
 * survive into the terminal. `plain` carries no styling at all, so a diagram
 * whose meaning depends on colour ("green = done, yellow = open") reads as
 * undifferentiated boxes without this.
 */
export function colorize(art: MermaidArt): string[] {
  // An empty theme, not the library default. The default dims borders and
  // paints arrows cyan whether or not the author asked for anything, which
  // invents meaning the model never expressed. Only colour the author wrote
  // should reach the screen, so an uncoloured diagram stays uncoloured and
  // inherits the surrounding text style.
  if (Object.keys(art.classDefs ?? {}).length === 0) return art.plain;
  try {
    const lines = toAnsi(art as never, {}) as string[];
    return lines.length === art.plain.length ? lines : art.plain;
  } catch {
    return art.plain;
  }
}
