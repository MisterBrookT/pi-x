// Reads running pi-subagents async runs for one parent session, so the phone can show live helpers.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface RemoteHelper {
  id: string;
  agent: string;
  task: string;
  tools: number;
  activityAt: number;
  /** Milliseconds since last activity when the snapshot was taken, so phone clock skew does not matter. */
  idleMs: number;
  state: string;
  startedAt?: number;
  /** Why the helper looks stuck (see stuckReason), else absent. */
  stuck?: string;
}

/** Same root pi-subagents uses: PI_SUBAGENTS_TEMP_ROOT, else <tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs. */
export function subagentRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const scope = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "shared";
  return join(root ? resolve(root) : join(tmpdir(), `pi-subagents-${scope}`), "async-subagent-runs");
}

const alive = (pid: unknown) => {
  if (typeof pid !== "number" || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
};

/** status.json per run carries sessionId = the parent session file; only running runs are returned. */
export function runningHelpers(sessionFile: string | undefined, dir = subagentRunsDir(), now = Date.now()): RemoteHelper[] {
  if (!sessionFile) return [];
  let ids: string[];
  try { ids = readdirSync(dir); } catch { return []; }
  const helpers: RemoteHelper[] = [];
  for (const id of ids) {
    const file = join(dir, id, "status.json");
    try {
      // Runs untouched for 6 hours are finished or dead; skip parsing them.
      if (now - statSync(file).mtimeMs > 6 * 3600_000) continue;
      const status = JSON.parse(readFileSync(file, "utf8"));
      if (status?.sessionId !== sessionFile || status.state !== "running" || !alive(status.pid)) continue;
      const steps: any[] = Array.isArray(status.steps) ? status.steps : [];
      const step = steps[Number(status.currentStep) || 0] ?? steps[0] ?? {};
      const name = typeof step.sessionName === "string" ? step.sessionName : "";
      const agent = String(step.agent || status.agent || "subagent");
      const task = name.startsWith(agent + ":") ? name.slice(agent.length + 1).trim() : name;
      const activityAt = Number(step.lastActivityAt || status.lastActivityAt || status.lastUpdate) || 0;
      helpers.push({
        id: String(status.runId || id),
        agent,
        task: task.slice(0, 200),
        tools: Number(status.toolCount ?? step.toolCount) || 0,
        activityAt,
        idleMs: activityAt ? Math.max(0, now - activityAt) : 0,
        state: String(step.activityState || status.activityState || "running"),
        startedAt: Number(step.startedAt || status.startedAt) || undefined,
      });
      const h = helpers[helpers.length - 1], why = stuckReason(h, now);
      if (why) h.stuck = why;
    } catch {}
  }
  return helpers.sort((a, b) => b.activityAt - a.activityAt).slice(0, 8);
}

/** A helper that never started (0 tools after 3 min) or sits in needs_attention with no activity for 5 min. */
export const STUCK_NO_START_MS = 3 * 60_000, STUCK_ATTENTION_MS = 5 * 60_000;
export function stuckReason(h: Pick<RemoteHelper, "tools" | "state" | "activityAt" | "startedAt">, now = Date.now()): string | undefined {
  const quiet = h.activityAt ? now - h.activityAt : 0;
  if (h.tools === 0 && h.startedAt && now - h.startedAt >= STUCK_NO_START_MS && quiet >= STUCK_NO_START_MS) return `no tool call ${Math.round((now - h.startedAt) / 60_000)} min after start`;
  if (h.state === "needs_attention" && quiet >= STUCK_ATTENTION_MS) return `needs attention, no activity for ${Math.round(quiet / 60_000)} min`;
  return undefined;
}

/** The wake-up prompt for an idle parent, once per stuck helper (ids in `told`). */
export function stuckHelperPrompt(helpers: RemoteHelper[], told: Set<string>): string | undefined {
  const fresh = helpers.filter(h => h.stuck && !told.has(h.id));
  if (!fresh.length) return undefined;
  for (const h of fresh) told.add(h.id);
  return `Helper stuck: ${fresh.map(h => `${h.agent} ${h.id.slice(0, 8)} "${h.task.slice(0, 80)}" (${h.stuck})`).join("; ")}. ` +
    "It will not finish on its own. Check it (subagent status), then steer it, or stop it and redo the step yourself or with a new helper.";
}
