// Detects that Pix code on disk changed since this Pi session loaded it, so a remote session can reload itself.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Cheap fingerprint of the Pix package's extensions/ and src/ files: paths, sizes and mtimes. */
export function pixCodeVersion(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) walk(path);
        else parts.push(`${path}:${info.size}:${info.mtimeMs}`);
      } catch {}
    }
  };
  walk(join(root, "extensions"));
  walk(join(root, "src"));
  return parts.join("\n");
}

/** PIX_REMOTE_AUTORELOAD=0 turns auto-reload off. */
export function autoReloadEnabled(env: NodeJS.ProcessEnv = process.env) { return env.PIX_REMOTE_AUTORELOAD !== "0"; }

export interface AutoReloadOptions {
  version: () => string;
  /** Idle, no question dialog waiting, no background jobs running. */
  ready: () => boolean;
  reload: () => void;
  log: (line: string) => void;
  checkMs?: number;
  stableMs?: number;
}

/** Call tick() on each heartbeat and after the agent settles; it reloads at most once, when the change is stable and Pi is idle. */
export function createAutoReload(options: AutoReloadOptions) {
  const checkMs = options.checkMs ?? 30_000;
  const stableMs = options.stableMs ?? 10_000;
  const loaded = options.version();
  let lastCheck = -Infinity;
  let candidate: string | undefined;
  let since = 0;
  let fired = false;
  return {
    tick(now = Date.now()) {
      if (fired || (candidate === undefined && now - lastCheck < checkMs)) return;
      lastCheck = now;
      const current = options.version();
      if (current === loaded) { candidate = undefined; return; }
      if (current !== candidate) { candidate = current; since = now; return; }
      if (now - since < stableMs || !options.ready()) return;
      fired = true;
      options.log("autoreload: Pix code changed on disk; reloading idle session");
      options.reload();
    },
  };
}
