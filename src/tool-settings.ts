import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CAPABILITIES, isMcpServerTool } from "./tool-panel.ts";
import type { Overrides } from "./tool-overrides.ts";

export interface ToolSettings {
  read(): Overrides;
  update(changes: Overrides): Overrides;
}

/** Shared across sessions. Old conversation entries deliberately have no authority. */
export function toolSettings(directory = getAgentDir()): ToolSettings {
  const file = join(directory, "pix-tools.json");
  const read = (): Overrides => {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed.overrides || typeof parsed.overrides !== "object" || Array.isArray(parsed.overrides)
      || Object.values(parsed.overrides).some(v => typeof v !== "boolean")) {
      throw new Error(`Invalid tool settings: ${file}. Fix the file before changing tools.`);
    }
    return parsed.overrides;
  };
  return {
    read,
    update(changes) {
      if (Object.values(changes).some(v => typeof v !== "boolean")) throw new Error("Tool choices must be booleans");
      mkdirSync(directory, { recursive: true });
      const lock = `${file}.lock`;
      // Fail explicitly on contention rather than losing another process's write.
      // No stale-lock guessing: an interrupted writer may need manual cleanup.
      try { mkdirSync(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Tool settings are busy (${lock}); retry. If no writer is running, remove the stale lock directory.`);
        throw error;
      }
      const temporary = join(lock, "settings.json");
      try {
        const merged = { ...read(), ...changes };
        writeFileSync(temporary, JSON.stringify({ version: 1, overrides: merged }, null, 2) + "\n", { mode: 0o600 });
        renameSync(temporary, file);
        return merged;
      } finally { rmSync(lock, { recursive: true, force: true }); }
    },
  };
}

/** Apply explicit choices and opt-in defaults to the current runtime set. */
export function selectedTools(known: Iterable<string>, current: Iterable<string>, overrides: Overrides): string[] {
  const available = new Set(known);
  const active = new Set(current);
  const withheld = new Set(CAPABILITIES.flatMap(c => c.defaultOn ? c.secondary : [...c.primary, ...c.secondary]));
  for (const name of active) {
    if (overrides[name] === false || (overrides[name] !== true && (withheld.has(name) || isMcpServerTool(name)))) active.delete(name);
  }
  for (const [name, on] of Object.entries(overrides)) if (on && available.has(name)) active.add(name);
  return [...active];
}
