#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = resolve(root, "extensions/pix-anthropic/index.ts");
const models = ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"];
let failed = false;

for (const model of models) {
  const result = spawnSync("pi", [
    "--no-extensions",
    "--extension", extension,
    "--print",
    "--provider", "pix-anthropic",
    "--model", model,
    "--thinking", "minimal",
    "Reply with exactly: OK",
  ], { encoding: "utf8", timeout: 60_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const passed = result.status === 0 && output === "OK";
  console.log(`${passed ? "PASS" : "FAIL"}  ${model}  minimal${passed ? "" : `\n${output}`}`);
  failed ||= !passed;
}

process.exitCode = failed ? 1 : 0;
