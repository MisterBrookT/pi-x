// Background services (the For you daemon) may start Pi by themselves. After a reboot the hub is not up yet,
// so every round looked like "For you is not open" and started another tab: 50+ Pi sessions. This guard decides
// whether an automatic (not user-tapped) launch may happen.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const runDir = () => join(homedir(), ".pix", "run");
const liveFile = (dir: string) => join(dir, "registered.json");
const shutdownFile = (dir: string) => join(dir, "registered-at-shutdown.json");
const launchesFile = (dir: string) => join(dir, "auto-launches.json");

/** The hub records which sessions are registered (on every list change and on stop). */
/** The first write after a boot first keeps the old list as registered-at-shutdown.json. */
export function recordRegistered(ids: string[], dir = runDir(), boot = bootTimeMs()) {
  try {
    mkdirSync(dir, { recursive: true });
    try { if (statSync(liveFile(dir)).mtimeMs < boot) writeFileSync(shutdownFile(dir), readFileSync(liveFile(dir))); } catch {}
    writeFileSync(liveFile(dir), JSON.stringify({ at: Date.now(), ids }));
  } catch {}
}

export function bootTimeMs(): number {
  try { const m = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 1000 }).match(/sec = (\d+)/); return m ? Number(m[1]) * 1000 : 0; } catch { return 0; }
}

const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };

/**
 * May a background service start session `id` now?
 * - Never more than once per `cooldownMs` for the same id (a slow start must not be retried into a pile).
 * - Never a loop or history session (loop-*): those start only when brook taps.
 * - In the first `bootWindowMs` after a boot, only sessions that were registered on the hub before it.
 * Allowed launches are recorded, so the caller only has to ask.
 */
export function autoLaunchAllowed(id: string, opts: { dir?: string; now?: number; boot?: number; cooldownMs?: number; bootWindowMs?: number } = {}): boolean {
  const dir = opts.dir ?? runDir(), now = opts.now ?? Date.now(), boot = opts.boot ?? bootTimeMs();
  if (id.startsWith("loop-")) return false;
  const launches: Record<string, number> = readJson(launchesFile(dir)) ?? {};
  if (now - (launches[id] ?? 0) < (opts.cooldownMs ?? 15 * 60_000)) return false;
  if (boot && now - boot < (opts.bootWindowMs ?? 30 * 60_000)) {
    // Before the hub has run since boot, registered.json is still the pre-boot list.
    let live: any; try { if (statSync(liveFile(dir)).mtimeMs < boot) live = readJson(liveFile(dir)); } catch {}
    const reg = live ?? readJson(shutdownFile(dir));
    if (!Array.isArray(reg?.ids) || !reg.ids.includes(id)) return false;
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(launchesFile(dir), JSON.stringify({ ...launches, [id]: now })); } catch {}
  return true;
}
