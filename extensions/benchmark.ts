import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactPixPrompt } from "../src/compact-prompt.js";

const exec = promisify(execFile);
const requiredTools = ["web_search", "fetch_content", "subagent", "todo", "lsp_diagnostics", "lsp_fix"];

async function timed(args: string[]): Promise<number> {
  const started = performance.now();
  await exec("pi", args, { timeout: 30_000, maxBuffer: 2_000_000 });
  return Math.round(performance.now() - started);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderDiff(value: string, other: string, kind: "added" | "removed"): string {
  const shared = new Set(other.split("\n"));
  return value.split("\n").map((line) => shared.has(line)
    ? escapeHtml(line)
    : `<mark class="${kind}">${escapeHtml(line) || " "}</mark>`).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("bench", {
    description: "Run Pix health, startup-speed, and prompt-overhead checks",
    handler: async (_args, ctx) => {
      const naiveSpeed: number[] = [];
      const pixSpeed: number[] = [];
      for (let i = 0; i < 3; i++) {
        naiveSpeed.push(await timed(["--no-extensions", "--list-models", "openai-codex"]));
        pixSpeed.push(await timed(["--list-models", "openai-codex"]));
      }
      const average = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      const naiveAverage = average(naiveSpeed);
      const pixAverage = average(pixSpeed);

      const active = new Set(pi.getActiveTools());
      const missing = requiredTools.filter((name) => !active.has(name));
      const options = ctx.getSystemPromptOptions();
      const baseTools = ["read", "bash", "edit", "write"];
      const baseSnippets = Object.fromEntries(Object.entries(options.toolSnippets ?? {}).filter(([name]) => baseTools.includes(name)));
      const baseGuidelines = pi.getAllTools()
        .filter((tool) => baseTools.includes(tool.name))
        .flatMap((tool) => tool.promptGuidelines ?? []);
      const modulePath = join(getPackageDir(), "dist/core/system-prompt.js");
      const { buildSystemPrompt } = await import(pathToFileURL(modulePath).href);
      const naive = buildSystemPrompt({
        ...options,
        selectedTools: baseTools,
        toolSnippets: baseSnippets,
        promptGuidelines: baseGuidelines,
      });
      const pixPrompt = compactPixPrompt(ctx.getSystemPrompt());
      const reportPath = join(ctx.cwd, ".pix/benchmark.html");
      await mkdir(dirname(reportPath), { recursive: true });
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pix benchmark</title><style>:root{color-scheme:dark;--bg:#0b0c0d;--panel:#151719;--head:#1d2023;--text:#eff1f2;--muted:#959ca3;--line:#292e33;--add:#9fe5b4;--add-bg:#183021;--remove:#f1aaaa;--remove-bg:#382020}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:48px 24px 28px;max-width:1400px;margin:auto}.status{font:500 11px ui-monospace,monospace;letter-spacing:.1em}.ok{color:var(--add)}.bad{color:var(--remove)}h1{font-size:clamp(34px,5vw,64px);line-height:1;letter-spacing:-.05em;font-weight:500;margin:14px 0 18px}.summary{color:var(--muted);font-size:16px;max-width:820px}.legend{display:flex;gap:18px;margin-top:22px;color:var(--muted);font-size:13px}.key{display:flex;align-items:center;gap:7px}.dot{width:9px;height:9px;border-radius:2px}.dot.added{background:var(--add)}.dot.removed{background:var(--remove)}.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 14px 40px}.pane{min-width:0;background:var(--panel);border-radius:10px;overflow:hidden}.pane h2{position:sticky;top:0;z-index:1;margin:0;padding:14px 18px;background:var(--head);border-bottom:1px solid var(--line);font-size:14px;font-weight:500}.pane h2 span{display:block;color:var(--muted);font-size:12px;font-weight:400;margin-top:3px}.pane pre{padding:18px;margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.68 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd0d4}mark{display:inline;color:inherit;border-radius:2px;padding:1px 2px;margin:0 -2px}mark.added{background:var(--add-bg);color:#dff8e6}mark.removed{background:var(--remove-bg);color:#f8dada}@media(max-width:820px){.cols{grid-template-columns:1fr}header{padding-top:36px}}</style></head><body><header><div class="status ${missing.length ? "bad" : "ok"}">${missing.length ? `MISSING · ${missing.join(", ")}` : "PIX HEALTHY"}</div><h1>What Pix changes.</h1><p class="summary">Health: ${missing.length ? `missing ${missing.join(", ")}` : "all expected tools loaded"}. Startup: Pi ${naiveAverage}ms → Pix ${pixAverage}ms average (${pixAverage - naiveAverage >= 0 ? "+" : ""}${pixAverage - naiveAverage}ms). Prompt: ${naive.length.toLocaleString()} → ${pixPrompt.length.toLocaleString()} characters.</p><div class="legend"><span class="key"><i class="dot removed"></i>Removed from naive Pi</span><span class="key"><i class="dot added"></i>Added by Pix</span></div></header><main class="cols"><section class="pane"><h2>Naive Pi<span>Red lines disappear after Pix loads</span></h2><pre>${renderDiff(naive, pixPrompt, "removed")}</pre></section><section class="pane"><h2>Pi with Pix<span>Green lines are new in Pix</span></h2><pre>${renderDiff(pixPrompt, naive, "added")}</pre></section></main></body></html>`;
      await writeFile(reportPath, html, "utf8");
      if (process.platform === "darwin") await exec("open", [reportPath]);
      ctx.ui.notify(`${missing.length ? `Missing tools: ${missing.join(", ")}` : "All Pix tools loaded"}\nStartup: Pi ${naiveAverage}ms → Pix ${pixAverage}ms (${pixAverage - naiveAverage >= 0 ? "+" : ""}${pixAverage - naiveAverage}ms)\nPrompt: ${naive.length} → ${pixPrompt.length} chars\nReport: ${reportPath}`, missing.length ? "error" : "info");
    },
  });
}
