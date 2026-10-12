#!/usr/bin/env node
// Applies patches/pi-subagents+<version>.patch to the bundled pi-subagents dependency.
// Runs as postinstall. It is idempotent: an already-patched tree is left alone, so a
// packed tarball that bundles the patched dependency installs cleanly.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// pi-subagents restricts "exports", so locate it the way Node resolves bare packages.
export function piSubagentsDir() {
	for (let dir = root; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "pi-subagents");
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(dir) === dir) throw new Error(`pi-subagents is not installed under ${root}.`);
	}
}

// git apply is strict about context (BSD patch accepts a reverse dry-run on an unpatched tree).
// --unsafe-paths/--directory are not needed: cwd is the package root and paths are a/ b/ relative.
function runPatch(dir, patchFile, args) {
	execFileSync("git", ["apply", ...args, patchFile], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_DIR: "/nonexistent-pix-patch" } });
}

export function applyPiSubagentsPatch() {
	const dir = piSubagentsDir();
	const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const patchFile = join(root, "patches", `pi-subagents+${version}.patch`);
	if (!existsSync(patchFile)) throw new Error(`pi-subagents ${version} has no patch at ${patchFile}; update patches/ for this version.`);
	try {
		runPatch(dir, patchFile, ["--reverse", "--check"]);
		return "already-applied";
	} catch {}
	runPatch(dir, patchFile, ["--check"]);
	runPatch(dir, patchFile, []);
	return "applied";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const state = applyPiSubagentsPatch();
	console.log(`pi-subagents patch ${state}.`);
}
