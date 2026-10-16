// The shape of a For you loop prompt, shared by foryou (writes it) and remote (shows it as one line).
/**
 * A loop task Pix itself wrote (card answer or handoff, from proactive-store) reads as one short line on
 * screen: the loop and what brook picked; the full prompt stays in the message and behind Details.
 * Only Pix's own prompt shapes match, so brook's own prose is never folded.
 */
export function loopPromptSummary(text: string): { title: string; you?: string } | undefined {
	const body = /^(?:\(Picked up again[^\n]*\n\n)?A proactive loop from [^\n]*:\n\n\*\*(.+)\*\*\nWhy: /m;
	const tapped = text.match(/^brook tapped "(.+?)" on loop [\w-]+\./), own = text.match(/^brook answered loop [\w-]+ with his own instruction\. Do this instead of the suggested step:\n([\s\S]*?)\n\n\(The loop, for context:\)\n/);
	const head = tapped || own;
	if (!head && !/^(?:\(Picked up again[^\n]*\n\n)?A proactive loop from /.test(text)) return undefined;
	const title = text.match(body)?.[1] ?? text.match(/^\*\*(.+)\*\*\nWhy: /m)?.[1];
	if (!title || !/\nWhen you stop, record where the loop stands/.test(text)) return undefined;
	return { title, ...(head ? { you: head[1] } : {}) };
}
/** Pix's own loop prompts go into Pi as this custom message: the model reads the full text, screens show one line. */
export const LOOP_MESSAGE = "pix-loop";
export const loopMessage = (text: string) => {
	const s = loopPromptSummary(text);
	return s ? { customType: LOOP_MESSAGE, content: text, display: true, details: s } : undefined;
};
