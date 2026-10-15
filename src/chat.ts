/**
 * Session chat: Pi sessions on this Mac coordinate through files. No broker, no sockets.
 *
 *   ~/.pi/agent/chat/<name>/me.json      board entry: { name, cwd, pid, status, doing, claims[], at }
 *   ~/.pi/agent/chat/<name>/inbox/*.json  messages:    { id, from, kind, text, thread, hop, at }
 *
 * - Address = session name, so a restart keeps it and queued mail waits for the name to come back.
 * - Board: what each live session is doing and which files / machines / services it claims.
 * - Kinds: note (read on the next turn, never wakes), ask (wakes; the answer wakes the asker),
 *   handoff (wakes; the receiver owns the task and reports when done).
 * - Loop stop: every automatic reply in a thread raises hop; at MAX_HOPS mail stops waking anyone.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const chatRoot = () => process.env.PIX_CHAT_DIR ?? join(homedir(), ".pi/agent/chat");
export const MAX_HOPS = 3;
export const KINDS = ["note", "ask", "handoff", "reply"] as const;
export type Kind = (typeof KINDS)[number];

export type Peer = { name: string; cwd: string; pid: number; at: number; status?: string; doing?: string; claims?: string[] };
export type Note = { id: string; from: string; kind: Kind; text: string; thread: string; hop: number; at: number; grant?: string[] };

const alive = (pid: number) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const readJson = <T>(f: string): T | undefined => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const writeAtomic = (f: string, v: unknown) => { const t = `${f}.${process.pid}.${randomUUID().slice(0, 4)}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, f); };
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "pi";

/** Every name with a board entry, live or not. A dead one keeps its inbox (mail waits) but loses its claims. */
function entries(root: string): Array<Peer & { live: boolean }> {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.flatMap((n) => {
    const p = readJson<Peer>(join(root, n, "me.json"));
    return p?.name ? [{ ...p, live: alive(p.pid) }] : [];  // skips old-format entries
  });
}

/** The board: live sessions only, sorted by name. */
export const board = (root = chatRoot()): Peer[] =>
  entries(root).filter((p) => p.live).map(({ live: _, ...p }) => p).sort((a, b) => a.name.localeCompare(b.name));

/** Pick a free name for a new session: base, base-2, ... (a dead holder's name can be taken over, with its mail). */
export function claimName(base: string, pid: number, root = chatRoot()): string {
  const taken = new Map(entries(root).map((p) => [p.name, p]));
  for (let i = 1; ; i++) {
    const n = i === 1 ? slug(base) : `${slug(base)}-${i}`;
    const p = taken.get(n);
    if (!p || !p.live || p.pid === pid) return n;
  }
}

/** Resolve a target by exact name or a unique prefix; dead names still resolve so mail can wait for them. */
export function find(to: string, root = chatRoot(), self?: string): string | { error: string } {
  const all = entries(root).filter((p) => p.name !== self);
  const exact = all.find((p) => p.name === to);
  if (exact) return exact.name;
  const hits = all.filter((p) => p.name.startsWith(to.toLowerCase()));
  const live = hits.filter((p) => p.live);
  if (live.length === 1) return live[0].name;
  if (hits.length === 1) return hits[0].name;
  return { error: hits.length ? `"${to}" matches ${hits.map((p) => p.name).join(", ")}` : `no session named "${to}" (see board)` };
}

/** Who else claims this item? Claims are free text (a path, "a800c", "nd-fresh"); match is case-insensitive. */
export function owner(item: string, self: string, root = chatRoot()): Peer | undefined {
  const k = item.toLowerCase();
  return board(root).find((p) => p.name !== self && (p.claims ?? []).some((c) => c.toLowerCase() === k));
}

export function send(from: string, to: string, kind: Kind, text: string, opts: { thread?: string; hop?: number; grant?: string[] } = {}, root = chatRoot()): Note {
  const id = randomUUID().slice(0, 8);
  const note: Note = { id, from, kind, text, thread: opts.thread ?? id, hop: opts.hop ?? 0, at: Date.now(), ...(opts.grant?.length && { grant: opts.grant }) };
  const dir = join(root, to, "inbox");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${note.at}-${id}.json`), note);
  // One shared transcript of every message, so brook can read all session-to-session talk in one place.
  appendFileSync(join(root, "log.md"), `\n### ${new Date(note.at).toLocaleString("sv-SE")} · ${from} → ${to} · ${kind} · thread ${note.thread}\n\n${text}\n`);
  return note;
}

/** Does this message wake the receiver? Notes never; anything past the hop limit never. */
export const wakes = (n: Note) => n.kind !== "note" && n.hop < MAX_HOPS;

/** Join under a name: publish the board entry, deliver queued and new mail. */
export function join_(me: Peer, onNote: (n: Note) => void, root = chatRoot()) {
  const dir = join(root, me.name), inbox = join(dir, "inbox");
  const publish = () => { mkdirSync(inbox, { recursive: true }); writeAtomic(join(dir, "me.json"), { ...me, at: Date.now() }); };
  publish();
  const drain = () => {
    let fs: string[] = [];
    try { fs = readdirSync(inbox).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
    for (const f of fs) {
      const n = readJson<Note>(join(inbox, f));
      rmSync(join(inbox, f), { force: true });
      if (n) onNote(n);
    }
  };
  let w: FSWatcher | undefined;
  try { w = watch(inbox, () => drain()); w.unref?.(); } catch {}
  const poll = setInterval(drain, 5000); poll.unref?.();  // fs.watch can miss events
  drain();
  return {
    update(patch: Partial<Peer>) { Object.assign(me, patch); publish(); },
    // Leave the board but keep the inbox: mail sent while we are gone waits for the name.
    close() { w?.close(); clearInterval(poll); writeAtomic(join(dir, "me.json"), { ...me, pid: 0, claims: [], status: "gone", at: Date.now() }); },
  };
}
