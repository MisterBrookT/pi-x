import assert from "node:assert/strict";
import test from "node:test";
import { colorize, preprocessEntities, renderFitted, renderMermaid, stylesToClassDefs } from "../src/mermaid.ts";
import { transformMermaidBlocks } from "../extensions/mermaid.ts";

const AUTH_DIAGRAM = `flowchart TD
    A([Card expires<br/>every hour]) --> C[Write lock]
    C --> D[Ask server<br/>for new card]
    D -- OK --> E[Clear lock<br/>finally]
    E --> F([Signed in])
    D -- Network blip<br/>403 --> G[Clear lock<br/>finally]
    G --> R[&quot;Refresh failed,<br/>will retry&quot;]
    R -.next hour.-> A
    D -- Token truly<br/>expired --> G2[Clear lock<br/>finally]
    G2 --> Z[&quot;Please log in&quot;]
    style F fill:#dfd,stroke:#3a3`;

test("an HTML entity's ';' does not end the statement", () => {
	const art = renderMermaid("flowchart LR\n  A[&quot;x&quot;] --> B[a &amp; b]; B --> C[y&#40;z&#41;]");
	assert.deepEqual(art.warnings, []);
	const text = art.plain.join("\n");
	assert.match(text, /"x"/);
	assert.match(text, /a & b/);
	assert.match(text, /y\(z\)/);
});

test("an entity is a literal character, not a quote that opens a label", () => {
	// If &quot; were decoded to a real quote before parsing, this label would be
	// read as quoted and the inner ] would be swallowed.
	const art = renderMermaid("flowchart LR\n  A[&quot;a] --> B");
	assert.deepEqual(art.warnings, []);
	assert.match(art.plain.join("\n"), /"a/);
});

test("entities inside a quoted span are left to the parser", () => {
	const { src, swaps } = preprocessEntities('A["x &amp; y"] --> B[c &amp; d]');
	assert.equal(swaps.size, 1);
	assert.match(src, /"x &amp; y"/);
});

test("a stray & or an unterminated entity stays literal", () => {
	const { src, swaps } = preprocessEntities("A[R&D] --> B[&notanentity]");
	assert.equal(swaps.size, 0);
	assert.equal(src, "A[R&D] --> B[&notanentity]");
});

test("<br/> inside an edge label does not break the link", () => {
	const art = renderMermaid("flowchart TD\n  A --> D\n  D -- Network blip<br/>403 --> G[x]");
	assert.deepEqual(art.warnings, []);
	assert.match(art.plain.join("\n"), /Network blip 403/);
});

test("the auth diagram that pi's bundled parser rejected renders clean", () => {
	const art = renderMermaid(AUTH_DIAGRAM);
	assert.deepEqual(art.warnings, []);
	const text = art.plain.join("\n");
	for (const label of ["Card expires every hour", "Network blip 403", '"Please log in"', "next hour"]) {
		assert.ok(text.includes(label), `missing ${label}`);
	}
});

test("the transformer swaps a mermaid fence for a text fence", () => {
	const md = `before\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\nafter`;
	const out = transformMermaidBlocks(md, 200);
	assert.ok(!out.includes("```mermaid"));
	assert.match(out, /```text\n[\s\S]*┌───┐[\s\S]*```/);
	assert.match(out, /^before\n/);
	assert.match(out, /\nafter$/);
});

test("the transformer leaves a diagram alone when it cannot render it", () => {
	const broken = "```mermaid\nflowchart LR\n  A --> \n```";
	assert.equal(transformMermaidBlocks(broken, 200), broken);
	const wide = "```mermaid\nflowchart LR\n  A --> B\n```";
	assert.equal(transformMermaidBlocks(wide, 5), wide);
});

test("non-mermaid fences are untouched", () => {
	const md = "```js\nconst mermaid = 1;\n```";
	assert.equal(transformMermaidBlocks(md, 200), md);
});

test("a wide LR diagram is re-laid out top-down to fit", () => {
	const src = [
		"flowchart LR",
		'    A["Your dashboard<br/>(on your laptop)"] -->|freeze into<br/>a snapshot| B["Snapshot<br/>&ge; data"]',
		'    B -->|store it<br/>&#63; WHERE| C[("Storage")]',
		'    C -->|read| D["agent.minara.ai<br/>apps/docs &mdash; OUR code"]',
		'    D --> E["Public link<br/>+ preview card"]',
	].join("\n");
	assert.ok(renderMermaid(src).width > 80);
	const fitted = renderFitted(src, 80);
	assert.ok(fitted.width <= 80, `width ${fitted.width}`);
	assert.deepEqual(fitted.warnings, []);
	const text = fitted.plain.join("\n");
	for (const label of ["Storage", "agent.minara.ai", "Public link"]) {
		assert.ok(text.includes(label), `missing ${label}`);
	}

	const md = "```mermaid\n" + src + "\n```";
	const out = transformMermaidBlocks(md, 80);
	assert.ok(!out.includes("```mermaid"), "wide LR diagram fell back to source");
	for (const line of out.split("\n")) assert.ok(line.length <= 80, `long line: ${line}`);
});

test("reflow keeps a diagram that already fits untouched", () => {
	const src = "flowchart LR\n  A --> B";
	assert.deepEqual(renderFitted(src, 80).plain, renderMermaid(src).plain);
});

test("a diagram that fits in no layout is left to the caller", () => {
	const src = "flowchart LR\n  A --> B";
	const art = renderFitted(src, 3);
	assert.ok(art.width > 3);
});

const LEGEND = `flowchart LR
  A[We own this] -->|freeze| B[Snapshot]
  B --> C(Open question)
  classDef owned fill:#2ea043,color:#fff
  classDef open fill:#d29922,color:#000
  class A,B owned
  class C open`;

const ESC = String.fromCharCode(27);

test("classDef colours survive rendering, so a colour legend still means something", () => {
	const art = renderMermaid(LEGEND);
	assert.deepEqual(Object.keys(art.classDefs ?? {}).sort(), ["open", "owned"], "class definitions must reach the caller");
	const lines = colorize(art).join("\n");
	assert.ok(lines.includes(`${ESC}[38;2;255;255;255;48;2;46;160;67m`), "the owned class keeps its green fill");
	assert.ok(lines.includes(`${ESC}[38;2;0;0;0;48;2;210;153;34m`), "the open class keeps its yellow fill");
});

test("re-laying a diagram top-down preserves its colours", () => {
	const wide = renderMermaid(LEGEND);
	const fitted = renderFitted(LEGEND, 40);
	assert.ok(fitted.width <= 40 && fitted.width < wide.width, "the diagram must actually have been re-laid out");
	const classesOf = (art) => [...new Set(art.styled.flat().flatMap((span) => span.classes ?? []))].sort();
	assert.deepEqual(classesOf(fitted), classesOf(wide), "a reflow must not drop class assignments");
	assert.ok(colorize(fitted).join("\n").includes(`${ESC}[38;2;0;0;0;48;2;210;153;34m`));
});

test("colorize keeps one line per plain line and falls back rather than throwing", () => {
	const art = renderMermaid(LEGEND);
	assert.equal(colorize(art).length, art.plain.length);
	assert.deepEqual(colorize({ ...art, styled: null }), art.plain, "a broken art object degrades to plain text");
});

test("an uncoloured diagram is unchanged apart from theme styling", () => {
	const art = renderMermaid("flowchart TD\n  A[One] --> B[Two]");
	const lines = colorize(art);
	assert.equal(lines.length, art.plain.length);
	assert.ok(lines.some((line) => line.includes("One")));
});

// The shorthand models actually reach for, taken from a real session.
const STYLE_DIAGRAM = `flowchart LR
    A["Your dashboard"] -->|freeze| B["Snapshot"]
    B -->|store it WHERE| C[("Storage")]
    C -->|read| D["OUR code"]

    style C fill:#ffe9b0,stroke:#d39e00,stroke-width:2px
    style D fill:#d4f5d4,stroke:#2d8a2d`;

test("per-node style statements colour the diagram, not just classDef", () => {
	const art = renderMermaid(STYLE_DIAGRAM);
	assert.deepEqual(art.warnings, []);
	const fills = Object.values(art.classDefs ?? {}).map((def) => def.fill).sort();
	assert.deepEqual(fills, ["#d4f5d4", "#ffe9b0"], "each style line becomes a usable class");
	const lines = colorize(art).join("\n");
	assert.ok(lines.includes(`${ESC}[38;2;0;0;0;48;2;255;233;176m`), "the open box keeps its yellow fill");
	assert.ok(lines.includes(`${ESC}[38;2;0;0;0;48;2;212;245;212m`), "the owned box keeps its green fill");
});

test("style rewriting keeps nodes distinct and survives a top-down reflow", () => {
	const rewritten = stylesToClassDefs(STYLE_DIAGRAM);
	assert.match(rewritten, /classDef \w+ fill:#ffe9b0/);
	assert.match(rewritten, /class C \w+/);
	assert.doesNotMatch(rewritten, /^\s*style /m, "the unsupported statement must be gone");
	const fitted = renderFitted(STYLE_DIAGRAM, 40);
	assert.ok(fitted.width <= 40, "the diagram must have been re-laid out");
	assert.ok(colorize(fitted).join("\n").includes(`${ESC}[48;2;`) || colorize(fitted).join("\n").includes("48;2;255;233;176"));
});

test("a diagram without style statements is passed through untouched", () => {
	const plain = "flowchart TD\n  A[One] --> B[Two]";
	assert.equal(stylesToClassDefs(plain), plain);
});

test("a style statement naming an edge or unknown id does not break rendering", () => {
	const art = renderMermaid("flowchart TD\n  A[One] --> B[Two]\n  style Z fill:#eeeeee");
	assert.deepEqual(art.warnings, []);
	assert.ok(art.plain.some((line) => line.includes("One")));
});
