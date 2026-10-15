/**
 * Session chat: Pi sessions on this Mac message each other through files. No broker, no sockets.
 *
 *   ~/.pi/agent/chat/<id>/me.json     who I am: { id, name, cwd, pid, at }   (rewritten on every status change)
 *   ~/.pi/agent/chat/<id>/inbox/*.json messages for me: { id, from, fromName, text, replyTo?, at }
 *
 * A peer is live while its pid exists. Delivery = atomic rename into the peer's inbox; the peer's
 * fs.watch picks it up, deletes the file and hands it to the session.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const chatRoot = () => process.env.PIX_CHAT_DIR ?? join(homedir(), ".pi/agent/chat");

export type Peer = { id: string; name: string; cwd: string; pid: number; at: number; status?: string };
export type Note = { id: string; from: string; fromName: string; text: string; replyTo?: string; at: number };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const readJson = <T>(f: string): T | undefined => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; } };
const writeAtomic = (f: string, v: unknown) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, f); };

/** Live peers (dead ones are swept). */
export function peers(root = chatRoot()): Peer[] {
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return []; }
  return ids.flatMap((id) => {
    const p = readJson<Peer>(join(root, id, "me.json"));
    if (p && alive(p.pid)) return [p];
    if (p) rmSync(join(root, id), { recursive: true, force: true });  // only sweep a known-dead pid, never a half-joined peer
    return [];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a peer by exact id, exact name, or a unique prefix of either. */
export function find(to: string, root = chatRoot(), self?: string): Peer | string {
  const all = peers(root).filter((p) => p.id !== self);
  const exact = all.filter((p) => p.id === to || p.name === to);
  const hits = exact.length ? exact : all.filter((p) => p.id.startsWith(to) || p.name.toLowerCase().startsWith(to.toLowerCase()));
  if (hits.length === 1) return hits[0];
  return hits.length ? `"${to}" matches ${hits.map((p) => p.name).join(", ")}` : `no live session "${to}" (try list)`;
}

export function send(from: Peer, to: Peer, text: string, replyTo?: string, root = chatRoot()): Note {
  const note: Note = { id: randomUUID().slice(0, 8), from: from.id, fromName: from.name, text, replyTo, at: Date.now() };
  const dir = join(root, to.id, "inbox");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${note.at}-${note.id}.json`), note);
  return note;
}

/** Join the room: publish me.json, watch my inbox. Returns update(status/name) and close(). */
export function join_(me: Peer, onNote: (n: Note) => void, root = chatRoot()) {
  const dir = join(root, me.id), inbox = join(dir, "inbox");
  mkdirSync(inbox, { recursive: true });
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
  const poll = setInterval(drain, 5000); poll.unref?.();  // fs.watch can miss events; cheap safety net
  drain();
  return {
    update(patch: Partial<Peer>) { Object.assign(me, patch); publish(); },
    close() { w?.close(); clearInterval(poll); rmSync(dir, { recursive: true, force: true }); },
  };
}
