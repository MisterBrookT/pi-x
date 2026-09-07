/**
 * `npm run bench` — Pix health, startup speed, and prompt overhead.
 *
 * Replaces the former `/bench` slash command. It spawns `pi` repeatedly and
 * builds two full sessions, which belongs in a delivery check rather than in
 * the interactive command list.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { compactPixPrompt } from "../src/compact-prompt.ts";
import { renderBenchmarkHtml, summarize, summaryLines } from "../src/benchmark.ts";

const exec = promisify(execFile);
const REQUIRED_TOOLS = ["web_search", "fetch_content", "subagent", "todo", "question", "lsp_diagnostics", "lsp_fix"];
const RUNS = 3;

const timed = async (args) => {
	const started = performance.now();
	await exec("pi", args, { timeout: 60_000, maxBuffer: 4_000_000 });
	return Math.round(performance.now() - started);
};

/**
 * The naive baseline suppresses discovery explicitly. The Pix side must use
 * normal discovery, because the packages Pix loads come from settings; passing
 * a hand-built loader there silently produces a bare Pi session instead.
 */
const session = async ({ naive }) => {
	const cwd = process.cwd();
	const { session: agentSession } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(),
		...(naive
			? {
					resourceLoader: new DefaultResourceLoader({
						cwd,
						agentDir: getAgentDir(),
						noExtensions: true,
						noContextFiles: true,
						noSkills: true,
						noPromptTemplates: true,
					}),
					tools: ["read", "bash", "edit", "write"],
				}
			: {}),
	});
	const result = { prompt: agentSession.systemPrompt, tools: agentSession.getActiveToolNames() };
	agentSession.dispose();
	return result;
};

const naiveStartupMs = [];
const pixStartupMs = [];
for (let run = 0; run < RUNS; run++) {
	naiveStartupMs.push(await timed(["--no-extensions", "--list-models", "openai-codex"]));
	pixStartupMs.push(await timed(["--list-models", "openai-codex"]));
}

const naive = await session({ naive: true });
const pix = await session({ naive: false });

const result = summarize({
	requiredTools: REQUIRED_TOOLS,
	activeTools: pix.tools,
	naiveStartupMs,
	pixStartupMs,
	naivePrompt: naive.prompt,
	pixPrompt: compactPixPrompt(pix.prompt),
});

const reportPath = join(process.cwd(), ".pix/benchmark.html");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, renderBenchmarkHtml(result), "utf8");

console.log(summaryLines(result));
console.log(`Report: ${reportPath}`);
process.exitCode = result.missingTools.length ? 1 : 0;
process.exit(process.exitCode);
