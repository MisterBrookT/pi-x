import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultToolMode, toolChoice } from "./tool-panel.ts";
import type { Overrides } from "./tool-overrides.ts";

export interface ToolSettings {
  read(): Overrides;
  /** undefined restores the default by removing the explicit choice. */
  update(changes: Record<string, boolean | "auto" | undefined>): Overrides;
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
      || Object.values(parsed.overrides).some(v => typeof v !== "boolean" && v !== "auto")) {
      throw new Error(`Invalid tool settings: ${file}. Fix the file before changing tools.`);
    }
    return parsed.overrides;
  };
  return {
    read,
    update(changes) {
      if (Object.values(changes).some(v => v !== undefined && typeof v !== "boolean" && v !== "auto")) throw new Error("Tool choices must be booleans or auto");
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
        const merged = { ...read() };
        for (const [name, value] of Object.entries(changes)) {
          if (value === undefined) delete merged[name]; else merged[name] = value;
        }
        writeFileSync(temporary, JSON.stringify({ version: 1, overrides: merged }, null, 2) + "\n", { mode: 0o600 });
        renameSync(temporary, file);
        return merged;
      } finally { rmSync(lock, { recursive: true, force: true }); }
    },
  };
}

/** Apply explicit choices and opt-in defaults to the current runtime set. */
export function selectedTools(known: Iterable<string>, current: Iterable<string>, overrides: Overrides, discovered: Iterable<string> = [], mcpNames?: ReadonlySet<string>): string[] {
  const available = new Set(known);
  const loaded = new Set(discovered);
  const active = new Set([...current, ...[...loaded].filter(name => available.has(name))]);
  for (const name of active) {
    const choice = toolChoice(name, overrides, mcpNames);
    if (choice === false || (choice !== true && !loaded.has(name) && (choice === "auto" || defaultToolMode(name, mcpNames) !== "on"))) active.delete(name);
  }
  for (const [name, on] of Object.entries(overrides)) if (on === true && available.has(name)) active.add(name);
  return [...active];
}
