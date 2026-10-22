/** The chat plugin's quiet "Waiting for pix" text, shared with the remote view over Pi's event bus. */
export const CHAT_WAITING = "pix:chat-waiting";
/** Query: open chat waits of this session (asks/handoffs without a reply) and the earliest scheduled check. */
export const CHAT_WAITS_QUERY = "pix:chat-waits:query";
export interface ChatWaitsState { waits: number; nextCheck?: number }
