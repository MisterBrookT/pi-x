import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, visibleWidth, type SettingItem } from "@earendil-works/pi-tui";
import { fastModeActiveFor } from "../src/fast-mode.js";
import { SUBAGENT_SPINNER_FRAMES, SUBAGENT_SPINNER_INTERVAL_MS } from "../src/subagent-spinner.js";
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
    // Repaint only while background work runs, so the spinner shows it is alive.
    let timer: ReturnType<typeof setInterval> | undefined;
    const animate = (on: boolean) => {
      if (on && !timer) { timer = setInterval(() => tui.requestRender(), SUBAGENT_SPINNER_INTERVAL_MS); timer.unref?.(); }
      if (!on && timer) { clearInterval(timer); timer = undefined; }
    };
    return {
      dispose: () => { animate(false); unsubscribe(); },
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
        if (options.context && context) parts.push(`${context.percent === null ? "?" : context.percent.toFixed(1) + "%"}/${formatTokens(context.contextWindow)}`);

        const model = ctx.model;
        let right = model?.id ?? "no-model";
        if (options.provider && model) right = `(${model.provider}) ${right}`;
        if (options.thinking && model?.reasoning) right += ` ${ctx.thinkingLevel ?? "off"}`;
        if (fastModeActiveFor(model)) right += " fast";
        const statuses = footerData.getExtensionStatuses();
        const work = statuses.get("pix-background");
        animate(Boolean(work));
        const frame = SUBAGENT_SPINNER_FRAMES[Math.floor(Date.now() / SUBAGENT_SPINNER_INTERVAL_MS) % SUBAGENT_SPINNER_FRAMES.length];
        const running = work ? `${frame} ${work}  ` : "";
        const metrics = parts.join(" ");
        const room = width - visibleWidth(running) - visibleWidth(metrics) - visibleWidth(right);
        const rest = room >= 2 ? metrics + " ".repeat(room) + right : truncateToWidth(`${metrics}  ${right}`, Math.max(0, width - visibleWidth(running)));
        const stats = (running ? theme.fg("accent", running) : "") + theme.fg("dim", rest);
        const branch = footerData.getGitBranch();
        const status = [statuses.get("pix-remote"), statuses.get("pix-goal")].filter(Boolean).join(" · ") || undefined;
        const pathWidth = status ? Math.max(0, width - visibleWidth(status) - 2) : width;
        const path = truncateToWidth(`${shortCwd(ctx.cwd)}${branch ? ` (${branch})` : ""}`, pathWidth);
        const location = !status ? path : pathWidth > 0 ? path + " ".repeat(width - visibleWidth(path) - visibleWidth(status)) + status : truncateToWidth(status, width);
        return [theme.fg("dim", location), stats];
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
