// "@" a For you item inside any Pi session: the editor suggests pending items next to files,
// and on submit the mention expands into the item's task and the loop is marked "on it" by this session.
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { actPrompt, type Item } from "./proactive.ts";
import { takeItem } from "./proactive-store.ts";

const TOKEN = "@foryou:";
const mentionRe = /@foryou:([\w-]+)/g;

/** Suggestions for the "@..." word before the cursor: open loops whose id or title match. */
export function forYouSuggestions(prefix: string, items: Item[]): AutocompleteItem[] {
	if (!prefix.startsWith("@") || prefix.startsWith('@"')) return [];
	const q = prefix.slice(1).replace(/^foryou:?/i, "").toLowerCase();
	return items
		.filter(i => !q || i.id.startsWith(q) || `${i.title} ${i.source}`.toLowerCase().includes(q) || "foryou".startsWith(q))
		.slice(0, 10)
		.map(i => ({ value: `${TOKEN}${i.id}`, label: `${i.status === "pending" ? "🔔" : i.status === "onit" ? "▶" : "⏳"} ${i.title}`, description: i.source }));
}

/** Put For you items above the normal "@file" list. */
export function withForYou(current: AutocompleteProvider, pending: () => Item[]): AutocompleteProvider {
	return {
		...current,
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, line, col, options) {
			const base = await current.getSuggestions(lines, line, col, options);
			const word = (lines[line] ?? "").slice(0, col).match(/(?:^|\s)(@[^\s]*)$/)?.[1];
			if (!word) return base;
			let mine: AutocompleteItem[] = [];
			try { mine = forYouSuggestions(word, pending()); } catch { /* list unreadable: files only */ }
			if (!mine.length) return base;
			return { prefix: word, items: [...mine, ...(base?.prefix === word ? base.items : [])] };
		},
		applyCompletion: (...a) => current.applyCompletion(...a),
		shouldTriggerFileCompletion: (...a) => current.shouldTriggerFileCompletion?.(...a) ?? true,
	};
}

/**
 * Expand every "@foryou:<id>" into the item's task and mark it "on it" by this session, so it
 * leaves "needs you" on the Mac pill and the phone. Unknown or closed ids stay as typed.
 */
export function expandForYou(text: string, session: string, dir?: string): string {
	if (!text.includes(TOKEN)) return text;
	return text.replace(mentionRe, (whole, id: string) => {
		const it = takeItem(id, session, dir);
		return it ? `\n\n${actPrompt(it)}\n\n` : whole;
	}).trim();
}
