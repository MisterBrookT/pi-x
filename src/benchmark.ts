/**
 * Pix health, startup-speed, and prompt-overhead measurement.
 *
 * This is a delivery check, not a conversation action, so it lives behind
 * `npm run bench` rather than a slash command: it spawns `pi` several times and
 * builds a whole session, which is too heavy to sit in the command list.
 */

export interface BenchmarkInput {
	/** Tool names Pix is expected to have loaded. */
	requiredTools: string[];
	/** Tool names actually active in a full Pix session. */
	activeTools: string[];
	/** Startup timings in milliseconds, one per run. */
	naiveStartupMs: number[];
	pixStartupMs: number[];
	/** System prompts to compare, already compacted the same way. */
	naivePrompt: string;
	pixPrompt: string;
}

export interface BenchmarkResult {
	missingTools: string[];
	naiveStartupMs: number;
	pixStartupMs: number;
	startupDeltaMs: number;
	naivePromptChars: number;
	pixPromptChars: number;
	naivePrompt: string;
	pixPrompt: string;
}

const average = (values: number[]): number =>
	values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : 0;

export function summarize(input: BenchmarkInput): BenchmarkResult {
	const active = new Set(input.activeTools);
	const naiveStartupMs = average(input.naiveStartupMs);
	const pixStartupMs = average(input.pixStartupMs);
	return {
		missingTools: input.requiredTools.filter((name) => !active.has(name)),
		naiveStartupMs,
		pixStartupMs,
		startupDeltaMs: pixStartupMs - naiveStartupMs,
		naivePromptChars: input.naivePrompt.length,
		pixPromptChars: input.pixPrompt.length,
		naivePrompt: input.naivePrompt,
		pixPrompt: input.pixPrompt,
	};
}

export function summaryLines(result: BenchmarkResult): string {
	const sign = result.startupDeltaMs >= 0 ? "+" : "";
	return [
		result.missingTools.length ? `Missing tools: ${result.missingTools.join(", ")}` : "All Pix tools loaded",
		`Startup: Pi ${result.naiveStartupMs}ms → Pix ${result.pixStartupMs}ms (${sign}${result.startupDeltaMs}ms)`,
		`Prompt: ${result.naivePromptChars} → ${result.pixPromptChars} chars`,
	].join("\n");
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderDiff(value: string, other: string, kind: "added" | "removed"): string {
	const shared = new Set(other.split("\n"));
	return value
		.split("\n")
		.map((line) => (shared.has(line) ? escapeHtml(line) : `<mark class="${kind}">${escapeHtml(line) || " "}</mark>`))
		.join("\n");
}

export function renderBenchmarkHtml(result: BenchmarkResult): string {
	const healthy = result.missingTools.length === 0;
	const sign = result.startupDeltaMs >= 0 ? "+" : "";
	const health = healthy ? "all expected tools loaded" : `missing ${result.missingTools.join(", ")}`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pix benchmark</title><style>:root{color-scheme:dark;--bg:#0b0c0d;--panel:#151719;--head:#1d2023;--text:#eff1f2;--muted:#959ca3;--line:#292e33;--add:#9fe5b4;--add-bg:#183021;--remove:#f1aaaa;--remove-bg:#382020}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:48px 24px 28px;max-width:1400px;margin:auto}.status{font:500 11px ui-monospace,monospace;letter-spacing:.1em}.ok{color:var(--add)}.bad{color:var(--remove)}h1{font-size:clamp(34px,5vw,64px);line-height:1;letter-spacing:-.05em;font-weight:500;margin:14px 0 18px}.summary{color:var(--muted);font-size:16px;max-width:820px}.legend{display:flex;gap:18px;margin-top:22px;color:var(--muted);font-size:13px}.key{display:flex;align-items:center;gap:7px}.dot{width:9px;height:9px;border-radius:2px}.dot.added{background:var(--add)}.dot.removed{background:var(--remove)}.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 14px 40px}.pane{min-width:0;background:var(--panel);border-radius:10px;overflow:hidden}.pane h2{position:sticky;top:0;z-index:1;margin:0;padding:14px 18px;background:var(--head);border-bottom:1px solid var(--line);font-size:14px;font-weight:500}.pane h2 span{display:block;color:var(--muted);font-size:12px;font-weight:400;margin-top:3px}.pane pre{padding:18px;margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.68 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd0d4}mark{display:inline;color:inherit;border-radius:2px;padding:1px 2px;margin:0 -2px}mark.added{background:var(--add-bg);color:#dff8e6}mark.removed{background:var(--remove-bg);color:#f8dada}@media(max-width:820px){.cols{grid-template-columns:1fr}header{padding-top:36px}}</style></head><body><header><div class="status ${healthy ? "ok" : "bad"}">${healthy ? "PIX HEALTHY" : `MISSING · ${result.missingTools.join(", ")}`}</div><h1>What Pix changes.</h1><p class="summary">Health: ${health}. Startup: Pi ${result.naiveStartupMs}ms → Pix ${result.pixStartupMs}ms average (${sign}${result.startupDeltaMs}ms). Prompt: ${result.naivePromptChars.toLocaleString()} → ${result.pixPromptChars.toLocaleString()} characters.</p><div class="legend"><span class="key"><i class="dot removed"></i>Removed from naive Pi</span><span class="key"><i class="dot added"></i>Added by Pix</span></div></header><main class="cols"><section class="pane"><h2>Naive Pi<span>Red lines disappear after Pix loads</span></h2><pre>${renderDiff(result.naivePrompt, result.pixPrompt, "removed")}</pre></section><section class="pane"><h2>Pi with Pix<span>Green lines are new in Pix</span></h2><pre>${renderDiff(result.pixPrompt, result.naivePrompt, "added")}</pre></section></main></body></html>`;
}
