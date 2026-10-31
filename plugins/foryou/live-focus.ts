import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export type LiveAction = "reply" | "show" | "later" | "do";

/** Input ownership for the existing strip, not a second editor or renderer. */
export function createLiveFocus(options: {
	rows(): { id: string }[];
	render(): void;
	act(id: string, verb: LiveAction): void;
	gone(): void;
	/** d / Backspace: remove the row (undoable); selection moves to the next row. */
	remove?(id: string, next: string | undefined): void;
}) {
	let selectedId: string | undefined;
	const reset = () => {
		selectedId = undefined;
		options.render();
	};
	return {
		get selectedId() {
			return selectedId;
		},
		reset,
		select(id: string) {
			selectedId = id;
			options.render();
		},
		focus(): boolean {
			const first = options.rows()[0];
			if (!first) return false;
			selectedId = first.id;
			options.render();
			return true;
		},
		handleInput(data: string): { consume: true } | undefined {
			if (!selectedId) return undefined;
			if (isKeyRelease(data)) return { consume: true };
			if (matchesKey(data, "escape")) {
				reset();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+c")) {
				reset();
				return undefined;
			}
			const rows = options.rows(),
				index = rows.findIndex((row) => row.id === selectedId);
			// Never reinterpret an old selection as the next row after phone actions or expiry.
			if (index < 0) {
				reset();
				options.gone();
				return { consume: true };
			}
			if (options.remove && (matchesKey(data, "d") || matchesKey(data, "backspace"))) {
				const id = selectedId, rest = rows.filter((row) => row.id !== id);
				selectedId = rest.length ? rest[Math.min(index, rest.length - 1)].id : undefined;
				options.remove(id, selectedId);
				options.render();
				return { consume: true };
			}
			const step =
				matchesKey(data, "down") || matchesKey(data, "right")
					? 1
					: matchesKey(data, "up") || matchesKey(data, "left")
						? -1
						: 0;
			if (step) {
				selectedId = rows[(index + step + rows.length) % rows.length].id;
				options.render();
			} else {
				const number = rows
					.slice(0, 9)
					.findIndex((_, i) => matchesKey(data, String(i + 1)));
				if (number >= 0) {
					selectedId = rows[number].id;
					options.render();
				} else {
					const verb = matchesKey(data, "enter")
						? "do"
						: undefined;
					if (verb) {
						const id = selectedId;
						reset();
						options.act(id, verb);
					}
				}
			}
			// Selection keys must not leak into brook's unchanged draft.
			return { consume: true };
		},
	};
}
