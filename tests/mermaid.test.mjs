import assert from "node:assert/strict";
import test from "node:test";
import { preprocessEntities, renderMermaid } from "../src/mermaid.ts";
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
