import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SUPPRESSION_FLAGS, installWrapper, wrapperScript } from "../src/chrome-wrapper.ts";

test("the wrapper disables keychain access for the throwaway profile", () => {
	// Without this macOS shows a modal "Keychain Not Found" dialog over whatever
	// the user is doing, because a fresh profile cannot read Chrome Safe Storage.
	assert.ok(SUPPRESSION_FLAGS.includes("--use-mock-keychain"));
	assert.match(wrapperScript("/bin/chrome"), /--use-mock-keychain/);
});

test("the wrapper execs the real browser and forwards every argument", () => {
	const script = wrapperScript("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.match(script, /^#!\/bin\/sh$/m);
	assert.match(script, /^exec "/m, "exec replaces the shell so signals reach Chrome");
	assert.match(script, /"\$@"$/m, "the backend's own flags are passed through");
});

test("a path with spaces is quoted", () => {
	assert.match(wrapperScript("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), /"\/Applications\/Google Chrome\.app[^"]*"/);
});

test("installing produces an executable script at a stable path", () => {
	const dir = mkdtempSync(join(tmpdir(), "pix-wrapper-test-"));
	const first = installWrapper({ executable: "/bin/chrome", directory: dir });
	assert.ok((statSync(first).mode & 0o111) !== 0, "the backend spawns it directly");
	assert.match(readFileSync(first, "utf8"), /\/bin\/chrome/);

	// Rewritten each time, so a Chrome upgrade cannot leave a stale script.
	const second = installWrapper({ executable: "/bin/other-chrome", directory: dir });
	assert.equal(second, first, "the path is stable");
	assert.match(readFileSync(second, "utf8"), /\/bin\/other-chrome/);
});
