import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compactPixPrompt } from "../src/compact-prompt.js";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: compactPixPrompt(event.systemPrompt),
  }));
}
