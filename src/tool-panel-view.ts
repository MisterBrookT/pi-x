/**
 * The `/tool` panel view.
 *
 * Pi's `SettingsList` routes Space and Enter to the same action, so a row can
 * either toggle or open a submenu but never both. This panel needs both on one
 * row: Space flips a capability, Enter opens its tools. That difference is the
 * whole point of the design, so the list is rendered here instead.
 *
 * Rendering is kept free of terminal state: `render` returns lines and
 * `handleInput` returns what changed, so the same code that runs in the TUI can
 * be driven directly by a test.
 */

import type { PanelModel, PanelRow } from "./tool-panel.ts";
import { formatTokens, panelSummary } from "./tool-panel.ts";

export interface PanelTheme {
	title: (text: string) => string;
	muted: (text: string) => string;
	label: (text: string, selected: boolean) => string;
	value: (text: string, on: boolean) => string;
	cursor: string;
}

/** Uncoloured theme, used by tests and by any non-ANSI caller. */
export const plainTheme: PanelTheme = {
	title: (text) => text,
	muted: (text) => text,
	label: (text) => text,
	value: (text) => text,
	cursor: ">",
};

export type PanelAction =
	| { type: "toggle"; row: PanelRow }
	| { type: "enter"; row: PanelRow }
	| { type: "back" }
	| { type: "close" }
	| { type: "move" }
	| { type: "none" };

/** Keys, matched on raw terminal input so no keybinding registry is needed. */
const UP = ["\u001b[A", "\u001b[Z", "k"];
const DOWN = ["\u001b[B", "\u0009", "j"];
const ENTER = ["\r", "\n"];
const SPACE = [" "];
const ESCAPE = ["\u001b"];

export interface PanelViewOptions {
	/** Rows currently shown; the advanced view passes a capability's tools. */
	model: PanelModel;
	theme?: PanelTheme;
	/** Capability whose tools are being shown, when in the advanced view. */
	scope?: { label: string; summary: string };
	maxVisible?: number;
}

/**
 * One screen of the panel: either the top level or one capability's tools.
 *
 * Held as a class because the cursor is real state that must survive input, but
 * with no terminal dependency, so a test can construct it and press keys.
 */
export class ToolPanelView {
	private index = 0;
	private model: PanelModel;
	private readonly theme: PanelTheme;
	private readonly scope?: { label: string; summary: string };
	private readonly maxVisible: number;

	constructor(options: PanelViewOptions) {
		this.model = options.model;
		this.theme = options.theme ?? plainTheme;
		this.scope = options.scope;
		this.maxVisible = options.maxVisible ?? 14;
	}

	/** Replace the rows after a toggle, keeping the cursor where the user left it. */
	setModel(model: PanelModel): void {
		this.model = model;
		if (this.index >= model.rows.length) this.index = Math.max(0, model.rows.length - 1);
	}

	get selected(): PanelRow | undefined {
		return this.model.rows[this.index];
	}

	get cursorIndex(): number {
		return this.index;
	}

	handleInput(data: string): PanelAction {
		const rows = this.model.rows;
		if (UP.includes(data)) {
			if (!rows.length) return { type: "none" };
			this.index = this.index === 0 ? rows.length - 1 : this.index - 1;
			return { type: "move" };
		}
		if (DOWN.includes(data)) {
			if (!rows.length) return { type: "none" };
			this.index = this.index === rows.length - 1 ? 0 : this.index + 1;
			return { type: "move" };
		}
		if (SPACE.includes(data)) {
			const row = this.selected;
			return row ? { type: "toggle", row } : { type: "none" };
		}
		if (ENTER.includes(data)) {
			const row = this.selected;
			// Enter opens a capability. On a plain tool there is nothing to open,
			// so it toggles instead of doing nothing, which is the least surprising
			// behaviour for a row that shows an on/off value.
			if (!row) return { type: "none" };
			return row.kind === "capability" ? { type: "enter", row } : { type: "toggle", row };
		}
		if (ESCAPE.includes(data)) return this.scope ? { type: "back" } : { type: "close" };
		return { type: "none" };
	}

	/** Visible window, so a long list scrolls rather than overflowing the screen. */
	private window(): { start: number; end: number } {
		const total = this.model.rows.length;
		if (total <= this.maxVisible) return { start: 0, end: total };
		const start = Math.max(0, Math.min(this.index - Math.floor(this.maxVisible / 2), total - this.maxVisible));
		return { start, end: start + this.maxVisible };
	}

	render(width = 80): string[] {
		const lines: string[] = [];
		if (this.scope) {
			lines.push(this.theme.title(`Tools › ${this.scope.label}`));
			lines.push(this.theme.muted(this.scope.summary));
		} else {
			lines.push(this.theme.title("Tools"));
			lines.push(this.theme.muted(panelSummary(this.model)));
		}
		lines.push("");

		const rows = this.model.rows;
		if (!rows.length) {
			lines.push(this.theme.muted("  No tools available"));
			return lines;
		}

		const labelWidth = Math.min(28, Math.max(...rows.map((row) => rowLabel(row).length)));
		const { start, end } = this.window();
		for (let i = start; i < end; i += 1) {
			const row = rows[i];
			const selected = i === this.index;
			const marker = selected ? this.theme.cursor : " ";
			const label = this.theme.label(rowLabel(row).padEnd(labelWidth), selected);
			const state = this.theme.value(rowOn(row) ? "on " : "off", rowOn(row));
			const detail = this.theme.muted(rowDetail(row));
			lines.push(truncate(`${marker} ${label}  ${state}  ${detail}`, width));
		}

		if (end < rows.length || start > 0) {
			lines.push(this.theme.muted(`  showing ${start + 1}-${end} of ${rows.length}`));
		}

		lines.push("");
		lines.push(this.theme.muted(this.hint()));
		return lines;
	}

	private hint(): string {
		const selected = this.selected;
		const canEnter = selected?.kind === "capability";
		return [
			"Space toggle",
			canEnter ? "Enter open" : undefined,
			this.scope ? "Esc back" : "Esc close",
		]
			.filter(Boolean)
			.join(" · ");
	}
}

export const rowLabel = (row: PanelRow): string => (row.kind === "capability" ? row.label : row.name);

export const rowOn = (row: PanelRow): boolean => row.on;

/**
 * Trailing detail for one row.
 *
 * A capability shows how many of its tools are on, because "on" alone does not
 * say whether the advanced view holds anything unexpected. A plain tool shows
 * its origin, which is the only provenance the user gets for it.
 */
export const rowDetail = (row: PanelRow): string => {
	if (row.kind === "capability") {
		const arrow = "▸";
		return `${row.activeCount}/${row.toolCount} tools · ${formatTokens(row.activeTokens)}  ${arrow}`;
	}
	return `${formatTokens(row.tokens)} · ${row.origin}`;
};

const truncate = (text: string, width: number): string => {
	// Counts code points rather than display cells; the panel is ASCII, and a
	// wrong count here only shortens a line early.
	if (width <= 0 || text.length <= width) return text;
	return `${text.slice(0, Math.max(0, width - 1))}…`;
};
