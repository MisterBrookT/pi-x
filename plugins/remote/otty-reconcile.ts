// Keep the hub's session list in step with what is really alive on the Mac.
// Otty is the truth for "alive": a Pi pane exists or it does not. All functions here are pure.

export type PaneState = "processing" | "idle" | "awaiting" | "dead";

export interface OttyPiPane { paneId: string; agent?: string; sessionId: string; name: string; cwd: string; state: PaneState }

/** Otty's agent_session_id is the JSONL basename, e.g. 2026-10-15T09-45-53-909Z_<hub id>. */
export function hubIdOf(agentSessionId: string): string {
  const m = agentSessionId.match(/^\d{4}-\d\d-\d\dT[\d-]+Z_(.+)$/);
  return m ? m[1] : agentSessionId;
}

export function parseOttyPanes(json: string): OttyPiPane[] {
  let data: any;
  try { data = JSON.parse(json)?.data; } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data
    .filter(p => typeof p?.agent === "string" && p.agent && typeof p.agent_session_id === "string" && p.agent_session_id)
    .map(p => ({
      paneId: String(p.id),
      agent: String(p.agent),
      sessionId: hubIdOf(p.agent_session_id),
      name: String(p.process || ""),
      cwd: String(p.cwd || ""),
      state: p.agent_state === "processing" || p.agent_state === "awaiting" ? p.agent_state : "idle",
    }));
}

export interface ReconcileResult {
  /** Live Pi panes the hub has no entry for: show them so the phone sees them. */
  unregistered: OttyPiPane[];
  /** Label per hub session id. */
  states: Record<string, PaneState>;
  /** Hub ids whose pane has been gone longer than the grace: drop them. */
  drop: string[];
  /** When each missing session was first seen missing (carry into the next call). */
  missingSince: Record<string, number>;
}

/**
 * panes === null means Otty could not be asked (not running, timeout): change nothing,
 * so a hiccup never marks every session dead.
 */
export function reconcile(hubIds: string[], panes: OttyPiPane[] | null, now: number, missingSince: Record<string, number>, graceMs = 60_000, keep: (id: string) => boolean = () => false, connected: (id: string) => boolean = () => false, nameOf: (id: string) => string | undefined = () => undefined): ReconcileResult {
  if (!panes) return { unregistered: [], states: {}, drop: [], missingSince };
  const bySession = new Map(panes.map(p => [p.sessionId, p]));
  const hub = new Set(hubIds);
  const states: Record<string, PaneState> = {}, next: Record<string, number> = {}, drop: string[] = [];
  const claimed = new Set<string>();
  for (const id of hubIds) {
    // Session id first; a connected session whose pane id differs (Claude Code, a resumed file) by pane name.
    const pane = bySession.get(id) ?? (connected(id) ? panes.find(p => !hub.has(p.sessionId) && !claimed.has(p.paneId) && p.name && p.name === nameOf(id)) : undefined);
    if (pane) { claimed.add(pane.paneId); states[id] = pane.state; continue; }
    // A session talking to the hub right now is alive whatever Otty says.
    if (connected(id)) continue;
    // Sessions Otty never hosts (the For you daemon, phone-started chats) are not judged here.
    if (keep(id)) continue;
    const since = missingSince[id] ?? now;
    next[id] = since;
    states[id] = "dead";
    if (now - since >= graceMs) drop.push(id);
  }
  return { unregistered: panes.filter(p => (p.agent ?? "Pi") === "Pi" && !hub.has(p.sessionId) && !claimed.has(p.paneId)), states, drop, missingSince: next };
}

export interface PiProcess { pid: number; ppid: number; ageSec: number; command: string }

/** `ps -Ao pid=,ppid=,etime=,command=` → processes. etime is [[dd-]hh:]mm:ss. */
export function parsePs(text: string): PiProcess[] {
  const out: PiProcess[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const t = m[3].match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!t) continue;
    const ageSec = (+(t[1] ?? 0)) * 86400 + (+(t[2] ?? 0)) * 3600 + (+t[3]) * 60 + (+t[4]);
    out.push({ pid: +m[1], ppid: +m[2], ageSec, command: m[4].trim() });
  }
  return out;
}

const isPi = (c: string) => /^pi(\s|$)/.test(c) || /\/pi(\s|$)/.test(c);

export interface OrphanInput {
  processes: PiProcess[];
  /** pid → hub session id, from ~/.pix/run/<pid>.json written by each Pi at start. */
  pidSessions: Map<number, string>;
  /** Hub session ids with a live Otty pane. */
  paneSessions: Set<string>;
  /** Pids holding a connection to the hub. */
  connected: Set<number>;
  /** Pids that must never be killed (the hub's own process). */
  protect: Set<number>;
  /** Seconds since each session last wrote its JSONL. */
  idleSec: (sessionId: string) => number | undefined;
  minIdleSec?: number;
}

/**
 * A top-level `pi` is an orphan only when we are sure: we know its session (pidfile),
 * that session has no Otty pane, it holds no hub connection, and it has been idle past the limit.
 * Children of another pi (subagents, helpers) and unknown processes are never returned.
 */
export function findOrphans(input: OrphanInput): PiProcess[] {
  const min = input.minIdleSec ?? 24 * 3600;
  const pis = input.processes.filter(p => isPi(p.command));
  const piPids = new Set(pis.map(p => p.pid));
  return pis.filter(p => {
    if (piPids.has(p.ppid) || input.protect.has(p.pid) || input.connected.has(p.pid)) return false;
    const sid = input.pidSessions.get(p.pid);
    if (!sid || input.paneSessions.has(sid)) return false;
    if (p.ageSec < min) return false;
    const idle = input.idleSec(sid);
    return idle !== undefined && idle >= min;
  });
}
