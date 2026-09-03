import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, visibleWidth, type SettingItem } from "@earendil-works/pi-tui";
import { fastModeActiveFor } from "../src/fast-mode.js";
import { cacheHitRate, defaultFooterOptions, formatTokens, tokenSpeed, type FooterOptions } from "../src/footer.js";

const configPath = join(homedir(), ".pi/agent/pix-footer.json");
const labels: Record<keyof FooterOptions, string> = {
  input: "Input tokens", output: "Output tokens", cacheRead: "Cache reads", cacheWrite: "Cache writes",
  cacheHit: "Latest cache hit rate", tokenSpeed: "Latest token speed", cost: "Estimated cost",
  context: "Context usage", provider: "Provider", thinking: "Thinking level",
};

function shortCwd(cwd: string): string {
  const home = resolve(homedir());
  const rel = relative(home, resolve(cwd));
  return rel === "" ? "~" : rel !== ".." && !rel.startsWith(`..${sep}`) ? `~${sep}${rel}` : cwd;
}

async function loadOptions(): Promise<FooterOptions> {
  try { return { ...defaultFooterOptions, ...JSON.parse(await readFile(configPath, "utf8")) }; }
  catch { return { ...defaultFooterOptions }; }
}

export default function (pi: ExtensionAPI) {
  let options = { ...defaultFooterOptions };
  let firstOutputAt: number | undefined;
  let latestSpeed: number | undefined;
  let installFooter: ((ctx: ExtensionContext) => void) | undefined;

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") firstOutputAt = undefined;
  });
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    if (!firstOutputAt && (type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta")) firstOutputAt = Date.now();
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      latestSpeed = tokenSpeed(event.message.usage.output, firstOutputAt ?? event.message.timestamp, Date.now());
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    options = await loadOptions();
    installFooter?.(ctx);
  });

  installFooter = (ctx) => ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        let latestHit: number | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          const usage = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
            ? entry.message.usage : (entry.type === "branch_summary" || entry.type === "compaction") ? entry.usage : undefined;
          if (usage) { input += usage.input; output += usage.output; cacheRead += usage.cacheRead; cacheWrite += usage.cacheWrite; cost += usage.cost.total; }
          if (entry.type === "message" && entry.message.role === "assistant") {
            const u = (entry.message as AssistantMessage).usage;
            latestHit = cacheHitRate(u.input, u.cacheRead, u.cacheWrite);
          }
        }
        const parts: string[] = [];
        if (options.input && input) parts.push(`↑${formatTokens(input)}`);
        if (options.output && output) parts.push(`↓${formatTokens(output)}`);
        if (options.cacheRead && cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
        if (options.cacheWrite && cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
        if (options.cacheHit && latestHit !== undefined) parts.push(`CH${latestHit.toFixed(1)}%`);
        if (options.tokenSpeed && latestSpeed !== undefined) parts.push(`${latestSpeed.toFixed(1)} tok/s`);
        if (options.cost && cost) parts.push(`$${cost.toFixed(3)}`);
        const context = ctx.getContextUsage();
        if (options.context && context) {
          const display = `${context.percent === null ? "?" : context.percent.toFixed(1) + "%"}/${formatTokens(context.contextWindow)}`;
          parts.push(context.percent !== null && context.percent > 90
            ? theme.fg("error", display)
            : context.percent !== null && context.percent > 70
              ? theme.fg("warning", display)
              : display);
        }

        const model = ctx.model;
        let right = model?.id ?? "no-model";
        if (options.provider && model) right = `(${model.provider}) ${right}`;
        if (options.thinking && model?.reasoning) right += ` ${ctx.thinkingLevel ?? "off"}`;
        if (fastModeActiveFor(model)) right += " fast";
        const left = parts.join(" ");
        const room = width - visibleWidth(left) - visibleWidth(right);
        const stats = room >= 2 ? left + " ".repeat(room) + right : truncateToWidth(`${left}  ${right}`, width);
        const branch = footerData.getGitBranch();
        return [truncateToWidth(theme.fg("dim", `${shortCwd(ctx.cwd)}${branch ? ` (${branch})` : ""}`), width), theme.fg("dim", stats)];
      },
    };
  });

  pi.registerCommand("footer", {
    description: "Choose the metrics shown in the footer",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("/footer requires the interactive terminal", "error");
      const keys = Object.keys(labels) as (keyof FooterOptions)[];
      await ctx.ui.custom((_tui, theme, _bindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Footer")), 1, 1));
        const list = new SettingsList(keys.map((key): SettingItem => ({ id: key, label: labels[key], currentValue: options[key] ? "on" : "off", values: ["on", "off"] })), keys.length, getSettingsListTheme(), (id, value) => {
          options[id as keyof FooterOptions] = value === "on";
          void writeFile(configPath, `${JSON.stringify(options, null, 2)}\n`);
          installFooter?.(ctx);
        }, () => done(undefined));
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter toggle • esc close"), 1, 1));
        return { render: (width) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data) => list.handleInput?.(data) };
      });
    },
  });
}
