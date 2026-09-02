import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactPixPrompt } from "../src/compact-prompt.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("prompt", {
    description: "Export the exact effective Pix system prompt",
    handler: async (args, ctx) => {
      const dir = join(ctx.cwd, ".pix");
      const path = resolve(ctx.cwd, args.trim() || join(dir, "system-prompt.md"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, compactPixPrompt(ctx.getSystemPrompt()), "utf8");
      ctx.ui.notify(`System prompt exported to ${path}`, "info");
    },
  });
}
