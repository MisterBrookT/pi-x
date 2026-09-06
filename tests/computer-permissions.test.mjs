import assert from "node:assert/strict";
import test from "node:test";
import { checkPermissions, parseAuthRows, renderReport } from "../src/computer-permissions.ts";

const darwin = (stdout) => ({ platform: "darwin", query: async () => stdout });

test("parses the auth rows sqlite3 actually prints", () => {
	const rows = parseAuthRows("kTCCServiceScreenCapture|2\nkTCCServiceAccessibility|0\n");
	assert.equal(rows.get("kTCCServiceScreenCapture"), 2);
	assert.equal(rows.get("kTCCServiceAccessibility"), 0);
	assert.equal(rows.size, 2, "trailing blank line is ignored");
});

test("only auth_value 2 counts as granted", async () => {
	for (const [value, granted] of [["2", true], ["0", false], ["1", false], ["3", false]]) {
		const report = await checkPermissions(darwin(`kTCCServiceAccessibility|${value}`));
		const entry = report.permissions.find((p) => p.service === "kTCCServiceAccessibility");
		assert.equal(entry.granted, granted, `auth_value ${value}`);
	}
});

test("both granted reports ready with nothing missing", async () => {
	const report = await checkPermissions(darwin("kTCCServiceScreenCapture|2\nkTCCServiceAccessibility|2"));
	assert.equal(report.ready, true);
	assert.deepEqual(report.missing, []);
	assert.match(renderReport(report), /Computer use is ready/);
});

test("names only the permission that is actually missing", async () => {
	const report = await checkPermissions(darwin("kTCCServiceScreenCapture|2\nkTCCServiceAccessibility|0"));
	assert.equal(report.ready, false);
	assert.deepEqual(report.missing.map((p) => p.label), ["Accessibility"]);
	const text = renderReport(report);
	assert.match(text, /✓ Screen & System Audio Recording — granted/);
	assert.match(text, /✗ Accessibility — denied/);
	assert.doesNotMatch(text, /✗ Screen/, "a granted permission is never listed as missing");
});

test("a missing permission comes with its Settings deep link and a reason", async () => {
	const report = await checkPermissions(darwin("kTCCServiceAccessibility|0"));
	const text = renderReport(report, "/Users/x/Applications/pi-computer-use.app");
	assert.match(text, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Accessibility/);
	assert.match(text, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture/);
	assert.match(text, /needed to read the element tree/);
	assert.match(text, /Grant these to: \/Users\/x\/Applications\/pi-computer-use\.app/);
});

test("an app never registered with TCC is distinguished from a denied one", async () => {
	const report = await checkPermissions(darwin(""));
	assert.equal(report.ready, false);
	assert.ok(report.permissions.every((p) => p.known === false));
	assert.match(renderReport(report), /not registered/);
});

test("an unreadable TCC database degrades to manual instructions", async () => {
	const report = await checkPermissions({
		platform: "darwin",
		query: async () => {
			throw new Error("unable to open database file");
		},
	});
	assert.equal(report.ready, false);
	assert.match(report.error, /unable to open database/);
	const text = renderReport(report);
	assert.match(text, /Could not read the TCC database/);
	assert.match(text, /manually in System Settings/);
});

test("non-macOS platforms require nothing", async () => {
	for (const platform of ["linux", "win32"]) {
		const report = await checkPermissions({ platform, query: async () => assert.fail("must not query TCC") });
		assert.equal(report.notApplicable, true);
		assert.equal(report.ready, true);
		assert.match(renderReport(report), new RegExp(`no TCC permissions required on ${platform}`));
	}
});

test("the report never suggests granting permissions programmatically", async () => {
	const report = await checkPermissions(darwin("kTCCServiceAccessibility|0"));
	const text = renderReport(report);
	assert.match(text, /cannot be granted programmatically/);
	assert.doesNotMatch(text, /tccutil|sudo|sqlite3/, "no write path is ever implied");
});
