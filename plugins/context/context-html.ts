/**
 * Context export: the whole window as one self-contained HTML page.
 *
 * `/context` answers "what is filling the window"; this answers "what exactly is
 * in it". A system prompt, a set of tool schemas, and a message history are all
 * too long for the transcript, so they go to a file that reads well in a
 * browser: one page, no assets, no network, collapsible sections.
 */

import type { ContextReport } from "./context-usage.ts";
import { bar, estimateTokens, sizeOf } from "./context-usage.ts";

export interface HtmlToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	origin?: string;
	active: boolean;
}

export interface HtmlEntryLike {
	type?: string;
	message?: { role?: string; toolName?: string; content?: unknown };
	compactionSummary?: unknown;
	branchSummary?: unknown;
}

export interface ContextHtmlInput {
	report: ContextReport;
	systemPrompt?: string;
	tools: HtmlToolLike[];
	entries: HtmlEntryLike[];
	title?: string;
	model?: string;
	cwd?: string;
	generatedAt?: Date;
}

/** Escape for both text nodes and quoted attributes. */
export const escapeHtml = (value: string): string =>
	value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
	);

const compact = (tokens: number): string =>
	tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);

/**
 * Flatten one message's content into readable text.
 *
 * Text parts are the part a human reads; anything else (images, tool inputs) is
 * kept as JSON so the page never silently drops what is being sent.
 */
export const entryText = (entry: HtmlEntryLike): string => {
	if (entry.type === "compaction") return stringify(entry.compactionSummary);
	if (entry.type === "branch_summary") return stringify(entry.branchSummary);
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return stringify(content);
	return content
		.map((part) => {
			const value = part as { type?: string; text?: string };
			return value?.type === "text" && typeof value.text === "string" ? value.text : stringify(part);
		})
		.join("\n");
};

const stringify = (value: unknown): string => {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
};

const entryLabel = (entry: HtmlEntryLike): string => {
	if (entry.type === "compaction") return "compaction summary";
	if (entry.type === "branch_summary") return "branch summary";
	const role = entry.message?.role ?? entry.type ?? "entry";
	return entry.message?.toolName ? `${role} · ${entry.message.toolName}` : role;
};

/**
 * One turn in the context, in wire order.
 *
 * The page is a single timeline rather than grouped sections: what matters when
 * reading a context is the sequence the model actually receives, and the system
 * prompt plus tool schemas are simply the first turn of it.
 */
const turn = (label: string, meta: string, body: string): string =>
	`<article><h2><span class="label">${escapeHtml(label)}</span><span class="meta">${escapeHtml(meta)}</span></h2>${body}</article>`;

const block = (text: string): string => `<pre>${escapeHtml(text)}</pre>`;

const usageTable = (report: ContextReport): string =>
	`<table>${report.slices
		.filter((slice) => slice.percent >= 0.1)
		.map(
			(slice) =>
				`<tr><td>${escapeHtml(slice.label)}</td><td class="bar">${escapeHtml(bar(slice.percent, 20))}</td><td class="num">${slice.percent.toFixed(1)}%</td><td class="num">${escapeHtml(compact(slice.tokens))}</td></tr>`,
		)
		.join("")}</table>`;

/** Build the complete page. Pure: same input, byte-identical output. */
export const renderContextHtml = (input: ContextHtmlInput): string => {
	const { report } = input;
	const generated = (input.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
	const headline = report.windowTokens
		? `${compact(report.usedTokens)} / ${compact(report.windowTokens)} tokens · ${report.percentUsed?.toFixed(1)}%`
		: `${compact(report.usedTokens)} tokens`;
	const meta = [input.model, input.cwd, `${generated} UTC`].filter(Boolean).join(" · ");

	const schemaOf = (tool: HtmlToolLike): string =>
		JSON.stringify({ name: tool.name, description: tool.description ?? "", input_schema: tool.parameters ?? {} });
	const toolBlock = (tool: HtmlToolLike): string => {
		const label = [tool.origin, `${compact(estimateTokens(schemaOf(tool).length))} tok`, tool.active ? undefined : "inactive"]
			.filter(Boolean)
			.join(" · ");
		return `<div class="part${tool.active ? "" : " off"}"><div class="parthead"><span class="name">${escapeHtml(tool.name)}</span><span class="meta">${escapeHtml(label)}</span></div>${
			tool.description ? `<p class="desc">${escapeHtml(tool.description)}</p>` : ""
		}${block(stringify(tool.parameters ?? {}))}</div>`;
	};

	const systemTokens = estimateTokens(
		(input.systemPrompt ?? "").length + input.tools.filter((tool) => tool.active).reduce((sum, tool) => sum + schemaOf(tool).length, 0),
	);
	const turns = [
		turn(
			"system",
			`${compact(systemTokens)} tok · ${input.tools.filter((tool) => tool.active).length} tools`,
			block(input.systemPrompt ?? "(unavailable)") + input.tools.map(toolBlock).join(""),
		),
		...input.entries.map((entry) => {
			const text = entryText(entry);
			return turn(
				entryLabel(entry),
				`${compact(estimateTokens(sizeOf(entry.message?.content ?? text)))} tok`,
				block(text),
			);
		}),
	].join("");

	const body = [
		`<header><p class="eyebrow">Context snapshot</p><h1>${escapeHtml(headline)}</h1><p class="meta">${escapeHtml(meta)}</p>${usageTable(report)}</header>`,
		`<div class="toolbar"><input id="q" type="search" placeholder="Highlight text across the whole context…" aria-label="Filter"></div>`,
		`<main>${turns}</main>`,
	].join("");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title ?? "Pix context")}</title>
<style>
/* Minimal by intention: the context is the content, so only hairlines, spacing,
   and one muted accent separate one turn from the next. */
:root{color-scheme:dark;--bg:#0d0d0e;--t:#e6e7e8;--m:#7e8286;--line:#232426;--a:#c8b98f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t);font:14px/1.65 -apple-system,BlinkMacSystemFont,Inter,sans-serif;-webkit-font-smoothing:antialiased}
header,main,.toolbar{width:min(860px,calc(100% - 40px));margin:auto}
header{padding:72px 0 0}
.eyebrow{color:var(--m);letter-spacing:.18em;font-size:11px;text-transform:uppercase;margin:0}
h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;font-weight:400;margin:16px 0 8px}
.meta{color:var(--m);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:22px 0 0}
td{padding:4px 0;color:var(--m)}
td:first-child{color:var(--t)}
.bar{font-family:ui-monospace,Menlo,monospace;color:var(--a);opacity:.7;padding:0 16px}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.toolbar{position:sticky;top:0;z-index:2;background:var(--bg);padding:20px 0 10px}
.toolbar input{width:100%;height:32px;border:0;border-bottom:1px solid var(--line);background:none;color:var(--t);padding:0 2px;font:13px ui-monospace,Menlo,monospace}
.toolbar input:focus{outline:none;border-bottom-color:var(--a)}
main{padding-bottom:120px}
article{padding:26px 0;border-top:1px solid var(--line)}
article>h2{display:flex;align-items:baseline;gap:12px;margin:0 0 14px;font-size:12px;font-weight:500}
.label{color:var(--a);letter-spacing:.1em;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace}
article>h2 .meta{margin-left:auto}
pre{margin:0;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b9bcbf}
.part{margin-top:22px;padding-left:16px;border-left:1px solid var(--line)}
.part.off{opacity:.42}
.parthead{display:flex;align-items:baseline;gap:12px;margin-bottom:6px}
.name{font-family:ui-monospace,Menlo,monospace;font-size:13px}
.parthead .meta{margin-left:auto}
.desc{color:var(--m);margin:0 0 6px;font-size:13px}
mark{background:none;color:var(--a);box-shadow:inset 0 -1px 0 var(--a)}
</style></head>
<body>${body}
<script>
const input = document.getElementById("q");
const blocks = [...document.querySelectorAll("pre, .desc, td, .name")];
const originals = blocks.map((el) => el.textContent);
input.addEventListener("input", () => {
  const term = input.value.trim().toLowerCase();
  blocks.forEach((el, index) => {
    const text = originals[index];
    el.textContent = "";
    if (!term) { el.textContent = text; return; }
    const haystack = text.toLowerCase();
    let at = 0;
    for (let found = haystack.indexOf(term); found !== -1; found = haystack.indexOf(term, at)) {
      el.appendChild(document.createTextNode(text.slice(at, found)));
      const hit = document.createElement("mark");
      hit.textContent = text.slice(found, found + term.length);
      el.appendChild(hit);
      at = found + term.length;
    }
    el.appendChild(document.createTextNode(text.slice(at)));
  });
});
</script></body></html>
`;
};
