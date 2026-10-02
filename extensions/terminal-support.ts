import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { installOttyKittySync, isLocalOtty } from "../src/otty-kitty-sync.ts";
import { ottyCapabilities } from "../src/terminal-support.ts";

/** Show inline images and clickable links in Otty; see src/terminal-support.ts and src/otty-kitty-sync.ts. */
export default function terminalSupport(pi: ExtensionAPI) {
  const overrides = ottyCapabilities();
  if (Object.keys(overrides).length) setCapabilityOverrides(overrides);
  if (!isLocalOtty()) return;
  // An empty widget is the public way to reach the TUI's terminal. The filter stays installed for the
  // process: Pi disposes widgets before a resume, new session, or reload and repaints the transcript
  // (including images) before session_start runs again, so removing it on dispose left those frames unfiltered.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("pix-otty-kitty-sync", (tui) => {
      installOttyKittySync(tui.terminal);
      return { render: () => [], invalidate() {} };
    });
  });
}
