import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(homedir(), ".pi/agent/extensions/subagent/config.json");
await mkdir(dirname(target), { recursive: true });
await copyFile(join(root, "config/subagents.json"), target);
console.log(`Installed bounded subagent policy: ${target}`);
