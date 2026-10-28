// "I saw it" on Feishu. Feishu has no mark-as-read API, so once For you has a message that asks brook
// (an @mention of him, or a DM to him), it adds one GLANCE reaction (the closest Feishu emoji to 👀;
// there is no literal eyes emoji) as brook. Never on chit-chat or messages for others, never twice,
// never when he already reacted with anything, and nothing is ever removed.
import type { Msg, Source } from "./proactive.ts";

/** brook's Feishu open_id (the reaction operator when he reacts himself). */
export const BROOK_OPEN_ID = "ou_8ecd46c59b552120d654348df02437f0";
export const SEEN_EMOJI = "GLANCE";

export type Lark = (args: string[]) => Promise<string>;

const fromMe = (m: Msg, me: string) => !!me && m.sender.trim() === me.trim();
/** Why this message asks brook, or "" when it does not: an @mention of him, or a DM to him. */
export function asksBrook(m: Msg, src: Source, me: string): "" | "mention" | "dm" {
	if (src.kind !== "feishu" || fromMe(m, me) || !/^om_/.test(m.id)) return "";
	if (me && m.text.includes(`@${me}`)) return "mention";
	if (src.chat === "private") return "dm";
	return "";
}

/**
 * Add the seen reaction to each message that asks brook, among the ones the filter forwarded (`ids`).
 * `done` remembers message ids already handled so a later round never calls Feishu again for them.
 */
export async function ackSeen(o: { lark: Lark; src: Source; fresh: Msg[]; ids: string[]; me: string; done: Set<string>; log?: (s: string) => void }): Promise<string[]> {
	const hot = new Set(o.ids), added: string[] = [];
	for (const m of o.fresh) {
		if (!hot.has(m.id) || o.done.has(m.id) || !asksBrook(m, o.src, o.me)) continue;
		try {
			const list = JSON.parse(await o.lark(["im", "reactions", "list", "--as", "user", "--params", JSON.stringify({ message_id: m.id, user_id_type: "open_id", page_size: 50 })]));
			const items: any[] = list?.data?.items ?? [];
			const his = items.some(r => r?.operator?.operator_id === BROOK_OPEN_ID);
			if (!his) {
				await o.lark(["im", "reactions", "create", "--as", "user", "--params", JSON.stringify({ message_id: m.id }), "--data", JSON.stringify({ reaction_type: { emoji_type: SEEN_EMOJI } })]);
				added.push(m.id);
			}
			o.done.add(m.id);
		} catch (e) {
			// Not marked done: a later round tries again (one list + at most one create; never a blind repeat create,
			// because the next try lists first and sees a reaction that did land).
			o.log?.(`seen reaction ${m.id}: ${(e as Error).message.slice(0, 160)}`);
		}
	}
	return added;
}
