// After a reboot Otty restores no Pi tabs. Once per boot, once the hub is up, reopen every session that was
// registered at shutdown and has no Otty pane: one at a time, ~10 s apart, waiting while load is high.
// Each open is `pi --session <abs jsonl>` in the session's own cwd (line 1 of its JSONL).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { bootTimeMs, runDir } from "../core/launch-guard.ts";
import { parseOttyPanes } from "./otty-reconcile.ts";

export interface ReopenDeps {
  dir: string;
  boot: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  load: () => number;
  otty: () => Promise<string | null>;
  /** Hub id → absolute JSONL path, or undefined. */
  findSession: (id: string) => string | undefined;
  open: (cwd: string, jsonl: string) => Promise<void>;
  log: (line: string) => void;
  gapMs?: number;
  maxLoad?: number;
  cooldownMs?: number;
}

const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function reopenAfterBoot(d: ReopenDeps): Promise<string[]> {
  const marker = join(d.dir, "reopened.json"), launches = join(d.dir, "auto-launches.json");
  const stamp = (m: string) => d.log(`${new Date(d.now()).toISOString()} ${m}`);
  if (!d.boot || (readJson(marker)?.boot ?? 0) >= d.boot) return [];
  mkdirSync(d.dir, { recursive: true });
  writeFileSync(marker, JSON.stringify({ boot: d.boot, at: d.now() }));  // before anything: never twice per boot
  const ids: string[] = readJson(join(d.dir, "registered-at-shutdown.json"))?.ids ?? [];
  const raw = await d.otty();
  if (raw === null) { stamp("otty not answering; nothing reopened"); return []; }
  const live = new Set(parseOttyPanes(raw).map(p => p.sessionId));
  const opened: string[] = [];
  for (const id of ids) {
    if (live.has(id)) continue;
    const l: Record<string, number> = readJson(launches) ?? {};
    if (d.now() - (l[id] ?? 0) < (d.cooldownMs ?? 15 * 60_000)) { stamp(`skip ${id}: started in the last 15 min`); continue; }
    const jsonl = d.findSession(id);
    let cwd: string | undefined;
    try { cwd = jsonl ? JSON.parse(readFileSync(jsonl, "utf8").split("\n")[0])?.cwd : undefined; } catch {}
    if (!jsonl || !cwd) { stamp(`skip ${id}: no session file or cwd`); continue; }
    for (let w = 0; d.load() > (d.maxLoad ?? 20) && w < 60; w++) { if (!w) stamp(`load ${d.load().toFixed(1)}; waiting`); await d.sleep(10_000); }
    if (opened.length) await d.sleep(d.gapMs ?? 10_000);
    try {
      await d.open(cwd, jsonl);
      writeFileSync(launches, JSON.stringify({ ...(readJson(launches) ?? {}), [id]: d.now() }));
      opened.push(id); stamp(`reopened ${id} in ${cwd}`);
    } catch (e) { stamp(`failed ${id}: ${e instanceof Error ? e.message : e}`); }
  }
  stamp(`done: ${opened.length} of ${ids.length} reopened`);
  return opened;
}

const run = (cmd: string, args: string[]) => new Promise<string | null>(res => execFile(cmd, args, { timeout: 10_000 }, (e, out) => res(e && !out ? null : String(out))));

export function defaultReopenDeps(sessionsDir = join(homedir(), ".pi", "agent", "sessions")): ReopenDeps {
  const logDir = join(homedir(), ".pix", "logs");
  return {
    dir: runDir(), boot: bootTimeMs(), now: Date.now,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    load: () => loadavg()[0],
    otty: () => run("otty", ["pane", "list", "--json"]),
    findSession: id => {
      try { for (const sub of readdirSync(sessionsDir)) for (const f of readdirSync(join(sessionsDir, sub))) if (f.endsWith(`_${id}.jsonl`)) return join(sessionsDir, sub, f); } catch {}
      return undefined;
    },
    open: async (cwd, jsonl) => { if (!existsSync(cwd)) throw new Error(`no cwd ${cwd}`); if ((await run("otty", ["tab", "new", "--no-focus", "--cwd", cwd, "--command", `pi --session ${shQuote(jsonl)}`])) === null) throw new Error("otty tab new failed"); },
    log: line => { try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, "reopen.log"), line + "\n"); } catch {} },
  };
}
