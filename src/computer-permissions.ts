/**
 * Reads macOS TCC state for the computer-use helper.
 *
 * TCC grants cannot be scripted: the system database is SIP-protected even for
 * root, and `tccutil` only supports `reset`. What we can do is read the state
 * and send the user straight to the right Settings pane, so a missing grant is
 * one keystroke to fix instead of a hunt.
 *
 * The database is read-only here. Nothing in this module attempts a write.
 */

export const HELPER_BUNDLE_ID = "com.injaneity.pi-computer-use";

const SYSTEM_TCC_DB = "/Library/Application Support/com.apple.TCC/TCC.db";

export interface PermissionInfo {
	/** TCC service key. */
	service: string;
	/** Name as it appears in System Settings. */
	label: string;
	/** Why the tool needs it, in one line. */
	purpose: string;
	/** Deep link to the exact Settings pane. */
	settingsUrl: string;
	granted: boolean;
	/** False when TCC has no row at all, i.e. the app has never been registered. */
	known: boolean;
}

export interface PermissionReport {
	platform: NodeJS.Platform;
	/** True when the platform has no TCC concept, so nothing is required. */
	notApplicable: boolean;
	permissions: PermissionInfo[];
	missing: PermissionInfo[];
	ready: boolean;
	/** Set when the TCC database could not be read at all. */
	error?: string;
}

const REQUIRED = [
	{
		service: "kTCCServiceAccessibility",
		label: "Accessibility",
		purpose: "read the element tree and press controls",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	},
	{
		service: "kTCCServiceScreenCapture",
		label: "Screen & System Audio Recording",
		purpose: "see window contents and fall back to OCR",
		settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	},
] as const;

export interface PermissionOperations {
	/** Runs a query against the system TCC database. Returns raw stdout. */
	query(sql: string): Promise<string>;
	platform: NodeJS.Platform;
}

/** auth_value 2 is allowed; 0 denied, 1 unknown, 3 limited. */
export const parseAuthRows = (stdout: string): Map<string, number> => {
	const rows = new Map<string, number>();
	for (const line of stdout.split("\n")) {
		const [service, value] = line.trim().split("|");
		if (!service || value === undefined) continue;
		const parsed = Number.parseInt(value, 10);
		if (!Number.isNaN(parsed)) rows.set(service, parsed);
	}
	return rows;
};

export const checkPermissions = async (operations: PermissionOperations): Promise<PermissionReport> => {
	if (operations.platform !== "darwin") {
		return { platform: operations.platform, notApplicable: true, permissions: [], missing: [], ready: true };
	}

	let rows: Map<string, number>;
	try {
		rows = parseAuthRows(
			await operations.query(
				`select service,auth_value from access where client='${HELPER_BUNDLE_ID}'`,
			),
		);
	} catch (error) {
		const permissions = REQUIRED.map((entry) => ({ ...entry, granted: false, known: false }));
		return {
			platform: operations.platform,
			notApplicable: false,
			permissions,
			missing: permissions,
			ready: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const permissions: PermissionInfo[] = REQUIRED.map((entry) => ({
		...entry,
		known: rows.has(entry.service),
		granted: rows.get(entry.service) === 2,
	}));
	const missing = permissions.filter((entry) => !entry.granted);
	return {
		platform: operations.platform,
		notApplicable: false,
		permissions,
		missing,
		ready: missing.length === 0,
	};
};

export const renderReport = (report: PermissionReport, helperPath?: string): string => {
	if (report.notApplicable) {
		return `Computer use: no TCC permissions required on ${report.platform}.`;
	}
	const lines: string[] = [];
	for (const entry of report.permissions) {
		const status = entry.granted ? "granted" : entry.known ? "denied" : "not registered";
		lines.push(`${entry.granted ? "✓" : "✗"} ${entry.label} — ${status}`);
		if (!entry.granted) {
			lines.push(`    needed to ${entry.purpose}`);
			lines.push(`    open: ${entry.settingsUrl}`);
		}
	}
	if (report.error) {
		lines.push(`Could not read the TCC database: ${report.error}`);
		lines.push("Grant both permissions manually in System Settings → Privacy & Security.");
	} else if (report.ready) {
		lines.push("Computer use is ready.");
	} else {
		if (helperPath) lines.push(`Grant these to: ${helperPath}`);
		lines.push("Permissions cannot be granted programmatically: the TCC database is SIP-protected.");
	}
	return lines.join("\n");
};
