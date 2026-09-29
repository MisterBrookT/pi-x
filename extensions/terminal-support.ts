import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { ottyCapabilities } from "../src/terminal-support.ts";

/** Show inline images and clickable links in Otty; see src/terminal-support.ts. */
export default function terminalSupport(_pi: ExtensionAPI) {
  const overrides = ottyCapabilities();
  if (Object.keys(overrides).length) setCapabilityOverrides(overrides);
}
