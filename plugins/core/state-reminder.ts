import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Append state changes without rewriting the prefix of earlier provider requests. */
export function createStateReminder(pi: ExtensionAPI, customType: string) {
	let lastContent: string | undefined;
	return {
		restore(ctx: ExtensionContext) {
			lastContent = undefined;
			for (const entry of ctx.sessionManager.buildContextEntries()) {
				if (entry.type === "custom_message" && entry.customType === customType && typeof entry.content === "string") {
					lastContent = entry.content;
				} else if (entry.type === "compaction") {
					for (const message of entry.retainedTail ?? []) {
						if (message.role === "custom" && message.customType === customType && typeof message.content === "string") {
							lastContent = message.content;
						}
					}
				}
			}
		},
		publish(content: string, beforeNextResponse = false) {
			if (content === lastContent) return;
			// Tool/compaction updates must join the running loop before its next
			// request. Lifecycle updates are passive, especially after an abort:
			// steering there could accidentally restart the interrupted agent.
			pi.sendMessage({ customType, content, display: false }, beforeNextResponse
				? { deliverAs: "steer" } : { triggerTurn: false });
			lastContent = content;
		},
	};
}
