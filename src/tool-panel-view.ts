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

import { Input, getKeybindings, matchesKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import type { PanelModel, PanelRow } from "./tool-panel.ts";
import { formatTokens, panelGroup, panelSummary } from "./tool-panel.ts";

/** The keybindings this panel reads, as pi's `KeybindingsManager` exposes them. */
export type PanelKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface KeyMatcher {
	matches(data: string, keybinding: PanelKeybinding): boolean;
}

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
	| { type: "action"; verb: string }
	| { type: "back" }
	| { type: "close" }
	| { type: "move" }
	| { type: "none" };

/**
 * Keys are decoded by pi, never compared as raw bytes.
 *
 * A terminal that negotiated the Kitty keyboard protocol sends Escape as
 * `\u001b[27u` and Space as `\u001b[32u`; xterm's modifyOtherKeys sends a third
 * form again. Testing `data === "\u001b"` therefore ignored Escape on exactly
 * the terminals pi upgrades, which is what made "Esc back" appear broken. Going
 * through the host's `KeybindingsManager` also means a user who rebound
 * selection keys gets those keys here too.
 */
const SHIFT_TAB = "shift+tab";
const TAB = "tab";

export interface PanelViewOptions {
	/** Rows currently shown; the advanced view passes a capability's tools. */
	model: PanelModel;
	theme?: PanelTheme;
	/** Capability whose tools are being shown, when in the advanced view. */
	scope?: { label: string; summary: string; actionsHint?: string; shortcuts?: { key: KeyId; verb: string }[] };
	maxVisible?: number;
	/** The host's keybindings, as handed to a `ui.custom` factory. */
	keybindings?: KeyMatcher;
}

/**
 * One screen of the panel: either the top level or one capability's tools.
 *
 * Held as a class because the cursor is real state that must survive input, but
 * with no terminal dependency, so a test can construct it and press keys.
 */
export class ToolPanelView {
	private index = 0;
	private readonly search = new Input();

	private get rows(): PanelRow[] {
		const query = this.search.getValue().trim().toLowerCase();
		if (!query) return this.model.rows;
		return this.model.rows.filter(row => {
			const text = [rowLabel(row), row.origin, panelGroup(row),
				...(row.kind === "capability" ? [row.summary, ...row.tools.map(tool => tool.name)] : [])].join(" ").toLowerCase();
			return query.split(/\s+/).every(word => text.includes(word));
		});
	}
	private model: PanelModel;
	private readonly theme: PanelTheme;
	private readonly scope?: PanelViewOptions["scope"];
	private readonly maxVisible: number;
	private readonly keybindings: KeyMatcher;

	constructor(options: PanelViewOptions) {
		this.model = options.model;
		this.theme = options.theme ?? plainTheme;
		this.scope = options.scope;
		this.maxVisible = options.maxVisible ?? 14;
		this.keybindings = options.keybindings ?? getKeybindings();
	}

	/** Replace the rows after a toggle, keeping the cursor where the user left it. */
	setModel(model: PanelModel): void {
		const selectedId = this.selected?.id;
		this.model = model;
		const rows = this.rows;
		const selectedIndex = rows.findIndex(row => row.id === selectedId);
		this.index = selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(this.index, rows.length - 1));
	}

	get selected(): PanelRow | undefined {
		return this.rows[this.index];
	}

	get cursorIndex(): number {
		return this.index;
	}

	handleInput(data: string): PanelAction {
		const rows = this.rows;
		const bound = (keybinding: PanelKeybinding): boolean => this.keybindings.matches(data, keybinding);
		if (bound("tui.select.up") || matchesKey(data, SHIFT_TAB) || (this.scope && data === "k")) {
			if (!rows.length) return { type: "none" };
			this.index = this.index === 0 ? rows.length - 1 : this.index - 1;
			return { type: "move" };
		}
		if (bound("tui.select.down") || matchesKey(data, TAB) || (this.scope && data === "j")) {
			if (!rows.length) return { type: "none" };
			this.index = this.index === rows.length - 1 ? 0 : this.index + 1;
			return { type: "move" };
		}
		if (matchesKey(data, "space")) {
			const row = this.selected;
			return row ? { type: "toggle", row } : { type: "none" };
		}
		if (bound("tui.select.confirm")) {
			const row = this.selected;
			// Enter opens a capability. On a plain tool there is nothing to open,
			// so it toggles instead of doing nothing, which is the least surprising
			// behaviour for a row that shows an on/off value.
			if (!row) return { type: "none" };
			return row.kind === "capability" ? { type: "enter", row } : { type: "toggle", row };
		}
		if (bound("tui.select.cancel")) {
			if (this.search.getValue()) {
				this.search.setValue("");
				this.index = 0;
				return { type: "move" };
			}
			return this.scope ? { type: "back" } : { type: "close" };
		}
		const shortcut = this.scope?.shortcuts?.find(entry => matchesKey(data, entry.key));
		if (shortcut) return { type: "action", verb: shortcut.verb };
		// Search the top level, including hidden child names. Capability views
		// keep their existing single-letter maintenance shortcuts.
		if (!this.scope) {
			const before = this.search.getValue();
			this.search.handleInput(data);
			if (this.search.getValue() !== before) {
				this.index = 0;
				return { type: "move" };
			}
		}
		return { type: "none" };
	}

	/** Visible window, so a long list scrolls rather than overflowing the screen. */
	private window(): { start: number; end: number } {
		const total = this.rows.length;
		if (total <= this.maxVisible) return { start: 0, end: total };
		const start = Math.max(0, Math.min(this.index - Math.floor(this.maxVisible / 2), total - this.maxVisible));
		return { start, end: start + this.maxVisible };
	}

	render(width = 80): string[] {
		const lines: string[] = [];
		if (this.scope) {
			lines.push(this.theme.title(`Tools › ${this.scope.label}`));
			lines.push(this.theme.muted(this.scope.summary));
			// A capability's maintenance actions live in the command form, so the
			// view that owns the capability has to say they exist.
			if (this.scope.actionsHint) lines.push(this.theme.muted(this.scope.actionsHint));
		} else {
			lines.push(this.theme.title("Tools"));
			lines.push(this.theme.muted(panelSummary(this.model)));
		}
		if (!this.scope) lines.push(this.theme.muted(`Search: ${this.search.getValue() || "type to filter"}`));
		lines.push("");

		const rows = this.rows;
		if (!rows.length) {
			lines.push(this.theme.muted(this.search.getValue() ? "  No matching tools · Esc clear search" : "  No tools available"));
			return lines.map((line) => truncate(line, width));
		}

		const labelWidth = Math.min(28, Math.max(...rows.map((row) => rowLabel(row).length)));
		const { start, end } = this.window();
		for (let i = start; i < end; i += 1) {
			const row = rows[i];
			if (!this.scope && (i === start || panelGroup(rows[i - 1]) !== panelGroup(row))) {
				lines.push(this.theme.muted(panelGroup(row)));
			}
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
		// Pi validates every rendered line, including headers, hints and empty
		// states. Row-only clipping still crashes when the terminal narrows.
		return lines.map((line) => truncate(line, width));
	}

	private hint(): string {
		const selected = this.selected;
		const canEnter = selected?.kind === "capability";
		return [
			"Space toggle",
			...(this.scope?.shortcuts ?? []).map(entry => `${entry.key.toUpperCase()} ${entry.verb}`),
			canEnter ? "Enter open" : undefined,
			this.scope ? "Esc back" : this.search.getValue() ? "Esc clear search" : "Esc close",
			!this.scope ? "Type to search" : undefined,
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
 * say whether the advanced view holds anything unexpected. Every row also names
 * where its tools came from: "MCP" or "act_ui" alone does not say whether the
 * user's own package or a third party put it there, and that is the question
 * provenance answers.
 */
export const rowDetail = (row: PanelRow): string => {
	if (row.kind === "capability") {
		const arrow = "▸";
		return `${row.activeCount}/${row.toolCount} tools · ${formatTokens(row.activeTokens)} · ${row.origin}  ${arrow}`;
	}
	return `${formatTokens(row.tokens)} · ${row.origin}`;
};

/**
 * Trim a themed row to the terminal width.
 *
 * Must count display cells, not string length: a themed row carries an ANSI
 * escape around each of its three segments, so a length-based cut removed the
 * trailing origin from rows that fit the screen perfectly well. That is why
 * provenance disappeared in the TUI while the plain-theme tests still passed.
 */
const truncate = (text: string, width: number): string => {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…");
};
