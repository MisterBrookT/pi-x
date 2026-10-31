// The side-effect half of otty-reconcile: ask Otty and ps, apply the result, kill sure orphans and log them.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOrphans, parseOttyPanes, parsePs, reconcile, type OttyPiPane, type PaneState } from "./otty-reconcile.ts";

export const pixRunDir = () => join(homedir(), ".pix", "run");

/** Each Pi writes ~/.pix/run/<pid>.json with its session id, so the hub can map pid → session → Otty pane.
 *  loaded (commit, code fingerprint, loadedAt) says which Pix code this session runs, so auto-reload can be checked. */
export type Loaded = { commit?: string; code: string; loadedAt: number };
export function writePidFile(sessionId: string, dir = pixRunDir(), pid = process.pid, loaded?: Loaded) {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, ...loaded })); } catch {}
}
export function removePidFile(dir = pixRunDir(), pid = process.pid) { try { unlinkSync(join(dir, `${pid}.json`)); } catch {} }

export function readPidFiles(dir = pixRunDir()): Map<number, string> {
  const out = new Map<number, string>();
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); if (j?.sessionId) out.set(Number(j.pid), String(j.sessionId)); } catch {}
    }
  } catch {}
  return out;
}

const run = (cmd: string, args: string[]) => new Promise<string | null>(resolve =>
  execFile(cmd, args, { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => resolve(err && !out ? null : String(out))));

export interface OttySyncDeps {
  otty: () => Promise<string | null>;
  ps: () => Promise<string>;
  /** `lsof -nP -iTCP:<port> -sTCP:ESTABLISHED -Fp` output. */
  connections: () => Promise<string>;
  pidSessions: () => Map<number, string>;
  /** Seconds since the session's JSONL last changed. */
  idleSec: (sessionId: string) => number | undefined;
  kill: (pid: number) => void;
  log: (line: string) => void;
  now: () => number;
}

export function defaultDeps(port: number, sessionsDir = join(homedir(), ".pi", "agent", "sessions")): OttySyncDeps {
  const logDir = join(homedir(), ".pix", "logs");
  return {
    otty: () => run("otty", ["pane", "list", "--json"]),
    ps: async () => (await run("ps", ["-Ao", "pid=,ppid=,etime=,command="])) ?? "",
    connections: async () => (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"])) ?? "",
    pidSessions: () => readPidFiles(),
    idleSec: sid => {
      try {
        let newest = 0;
        for (const d of readdirSync(sessionsDir)) for (const f of readdirSync(join(sessionsDir, d))) if (f.endsWith(`_${sid}.jsonl`)) newest = Math.max(newest, statSync(join(sessionsDir, d, f)).mtimeMs);
        return newest ? (Date.now() - newest) / 1000 : undefined;
      } catch { return undefined; }
    },
    kill: pid => process.kill(pid, "SIGTERM"),
    log: line => { try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, "orphan-pi.log"), line + "\n"); } catch {} },
    now: Date.now,
  };
}

export interface OttySyncState { states: Record<string, PaneState>; unregistered: OttyPiPane[] }

/** One pass. Returns hub ids to drop; never kills the hub's own pid, a child pi, or an unmapped one. */
export async function ottySyncTick(deps: OttySyncDeps, hubIds: string[], missing: Record<string, number>, keep: (id: string) => boolean, protect: Set<number>, graceMs = 60_000, connected: (id: string) => boolean = () => false, nameOf: (id: string) => string | undefined = () => undefined) {
  const raw = await deps.otty();
  const panes = raw === null ? null : parseOttyPanes(raw);
  const r = reconcile(hubIds, panes, deps.now(), missing, graceMs, keep, connected, nameOf);
  const killed: number[] = [];
  if (panes) {
    const connected = new Set((await deps.connections()).split("\n").filter(l => l.startsWith("p")).map(l => Number(l.slice(1))));
    const orphans = findOrphans({ processes: parsePs(await deps.ps()), pidSessions: deps.pidSessions(), paneSessions: new Set(panes.map(p => p.sessionId)), connected, protect, idleSec: deps.idleSec });
    for (const o of orphans) {
      const sid = deps.pidSessions().get(o.pid);
      try { deps.kill(o.pid); killed.push(o.pid); deps.log(`${new Date(deps.now()).toISOString()} killed pid=${o.pid} session=${sid} age=${o.ageSec}s cmd=${o.command}`); }
      catch (e) { deps.log(`${new Date(deps.now()).toISOString()} kill failed pid=${o.pid}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  return { ...r, killed };
}
