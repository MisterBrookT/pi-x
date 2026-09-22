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
  if (vertical === null) return art;
  const alt = renderMermaid(vertical);
  if (alt.warnings.length > 0 || alt.plain.length === 0 || alt.width > width) return art;
  return alt;
}

export function renderMermaid(src: string): MermaidArt {
  const { src: prepared, swaps } = preprocessEntities(src);
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
  try {
    const lines = toAnsi(art as never) as string[];
    return lines.length === art.plain.length ? lines : art.plain;
  } catch {
    return art.plain;
  }
}
