// Mac-side helpers behind the phone's folder picker, session launcher, session deletion, and
// read-only Memory view. Every path the phone names is resolved and checked here.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, relative, sep } from "node:path";

export const remoteSessionsDir = join(homedir(), ".pi/agent/sessions");
export const remoteMemoryRoot = () => process.env.PIX_REMOTE_MEMORY_ROOT || join(homedir(), "workspace/hub");
export const memoryFileLimit = 256_000;

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export interface RemoteFolder { name: string; path: string }

/** Distinct working folders of saved Pi sessions, newest first, read from each session header. */
export async function recentFolders(sessionsDir = remoteSessionsDir, limit = 20): Promise<RemoteFolder[]> {
  let dirs: string[];
  try { dirs = await readdir(sessionsDir); } catch { return []; }
  const found: { cwd: string; at: number }[] = [];
  for (const dir of dirs) {
    let files: string[];
    try { files = (await readdir(join(sessionsDir, dir))).filter(f => f.endsWith(".jsonl")).sort(); } catch { continue; }
    const newest = files.at(-1);
    if (!newest) continue;
    const file = join(sessionsDir, dir, newest);
    try {
      const handle = await open(file, "r");
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      await handle.close();
      const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
      if (header?.type !== "session" || typeof header.cwd !== "string") continue;
      if (!(await stat(header.cwd)).isDirectory()) continue;
      found.push({ cwd: header.cwd, at: (await stat(file)).mtimeMs });
    } catch {}
  }
  const seen = new Set<string>();
  return found.sort((a, b) => b.at - a.at).filter(f => !seen.has(f.cwd) && seen.add(f.cwd)).slice(0, limit).map(f => ({ name: basename(f.cwd) || f.cwd, path: f.cwd }));
}

/** Visible subfolders of a folder inside home. Returns undefined for anything outside home. */
export async function listFolders(path: string, home = homedir()): Promise<{ path: string; parent?: string; folders: RemoteFolder[] } | undefined> {
  try {
    const root = await realpath(home);
    const real = await realpath(path || root);
    if (!inside(root, real) || !(await stat(real)).isDirectory()) return undefined;
    const entries = await readdir(real, { withFileTypes: true });
    const folders: RemoteFolder[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(real, entry.name);
      let dir = entry.isDirectory();
      if (entry.isSymbolicLink()) { try { const target = await realpath(full); dir = inside(root, target) && (await stat(target)).isDirectory(); } catch { dir = false; } }
      if (dir) folders.push({ name: entry.name, path: full });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: real === root ? undefined : dirname(real), folders: folders.slice(0, 500) };
  } catch { return undefined; }
}

/** A folder the phone may start Pi in: a directory inside home, or a recent session folder. */
export async function launchableFolder(path: unknown, home = homedir(), sessionsDir = remoteSessionsDir): Promise<string | undefined> {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return undefined;
    if (inside(await realpath(home), real)) return real;
    if ((await recentFolders(sessionsDir, 200)).some(f => f.path === path || f.path === real)) return real;
  } catch {}
  return undefined;
}

export type RemoteMode = "relay" | "tailnet";
export interface Launch { command: string; args: string[] }

/** Otty's CLI: on PATH inside Otty shells; background services (launchd, the pill) use the app bundle. */
export const ottyAppCli = "/Applications/Otty.app/Contents/MacOS/otty-cli";

/** Extra Pi arguments for a launch: a fixed session to create or resume, its name, and a first prompt. */
export interface PiArgs { prompt?: string; sessionId?: string; name?: string; model?: string }

/** The terminal command that starts Pi in `dir` with remote control already on. */
export function launchCommand(dir: string, mode: RemoteMode, otty: boolean | string, pi_: string | PiArgs = {}, window?: string): Launch {
  const a: PiArgs = typeof pi_ === "string" ? { prompt: pi_ } : pi_;
  const pi = `env PIX_REMOTE_AUTOSTART=${mode} pi${a.sessionId ? ` --session-id ${shellQuote(a.sessionId)}` : ""}${a.name ? ` --name ${shellQuote(a.name)}` : ""}${a.model ? ` --model ${shellQuote(a.model)}` : ""}${a.prompt ? ` ${shellQuote(a.prompt)}` : ""}`;
  return otty
    // Always a tab in an existing Otty window; never a second Otty process.
    ? { command: typeof otty === "string" ? otty : "otty", args: ["tab", "new", ...(window ? ["--window", window] : []), "--cwd", dir, "--command", pi, "--no-focus"] }
    : { command: "tmux", args: ["new-session", "-d", "-c", dir, pi] };
}

const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some(p => p && existsSync(join(p, name)));

export type Spawner = (command: string, args: string[]) => Promise<void>;
const detachedSpawn: Spawner = (command, args) => new Promise((resolve, reject) => {
  const child = nodeSpawn(command, args, { stdio: "ignore", detached: true });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(Error(`${command} exited with ${code}`)));
  child.unref();
});

/** POSIX single-quote, so a starting prompt reaches Pi as one argument. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * An open Otty window to add a tab to. Undefined when Otty is not running: then the caller uses tmux,
 * so a background service never starts a second Otty app.
 */
export async function ottyWindow(cli: string, run: (cmd: string, args: string[]) => Promise<string> = defaultRun): Promise<string | undefined> {
  try {
    const list = JSON.parse(await run(cli, ["window", "list", "--json", "--timeout", "1500"]))?.data;
    if (!Array.isArray(list) || !list.length) return undefined;
    return String((list.find((w: any) => w.focused) ?? list[0]).id);
  } catch { return undefined; }
}
const defaultRun = (cmd: string, args: string[]) => new Promise<string>((ok, bad) => execFile(cmd, args, { timeout: 3000 }, (e, out) => (e ? bad(e) : ok(String(out)))));

export async function launchPi(dir: string, mode: RemoteMode, options: { spawn?: Spawner; hasOtty?: boolean; prompt?: string; sessionId?: string; name?: string; model?: string; window?: (cli: string) => Promise<string | undefined> } = {}): Promise<Launch> {
  // Tests force the choice with hasOtty. Otherwise: Otty only if a window is already open (adds a tab), else tmux.
  const cli = options.hasOtty === false ? false : options.hasOtty === true ? "otty" : onPath("otty") ? "otty" : existsSync(ottyAppCli) ? ottyAppCli : false;
  const win = cli && (options.hasOtty === undefined || options.window) ? await (options.window ?? ottyWindow)(cli) : undefined;
  const useOtty = cli && (win !== undefined || options.hasOtty === true && !options.window) ? cli : false;
  const launch = launchCommand(dir, mode, useOtty, { prompt: options.prompt, sessionId: options.sessionId, name: options.name, model: options.model }, win);
  await (options.spawn ?? detachedSpawn)(launch.command, launch.args);
  return launch;
}

/** The session file may be deleted only if it is a .jsonl directly in a sessions subfolder, named for this id. */
export async function deletableSessionFile(file: unknown, id: string, sessionsDir = remoteSessionsDir): Promise<string | undefined> {
  if (typeof file !== "string" || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  try {
    const root = await realpath(sessionsDir);
    if ((await lstat(file)).isSymbolicLink()) return undefined;
    const real = await realpath(file);
    const rel = relative(root, real).split(sep);
    if (rel.length !== 2 || rel[0] === ".." || rel[0].startsWith(".")) return undefined;
    if (!rel[1].endsWith(`_${id}.jsonl`) && rel[1] !== `${id}.jsonl`) return undefined;
    if (!(await stat(real)).isFile()) return undefined;
    return real;
  } catch { return undefined; }
}

export interface MemoryItem { group: string; name: string; path: string }

async function safeMemoryPath(root: string, rel: string): Promise<string | undefined> {
  if (!rel.endsWith(".md") || rel.includes("\0") || rel.startsWith("/")) return undefined;
  try {
    const realRoot = await realpath(root);
    const real = await realpath(join(realRoot, rel));
    if (!inside(realRoot, real) || !(await stat(real)).isFile()) return undefined;
    return real;
  } catch { return undefined; }
}

/** AGENTS.md at the root and every .md under skills/, grouped by skill folder. */
export async function listMemory(root = remoteMemoryRoot()): Promise<MemoryItem[]> {
  const items: MemoryItem[] = [];
  if (await safeMemoryPath(root, "AGENTS.md")) items.push({ group: "Hub", name: "AGENTS.md", path: "AGENTS.md" });
  const walk = async (rel: string, depth: number) => {
    if (depth > 6 || items.length > 500) return;
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.name.endsWith(".md") && await safeMemoryPath(root, child)) {
        const parts = child.split("/");
        items.push({ group: parts.length > 2 ? parts[1] : "skills", name: parts.slice(2).join("/") || entry.name, path: child });
      }
    }
  };
  await walk("skills", 0);
  return items;
}

export async function readMemory(rel: unknown, root = remoteMemoryRoot()): Promise<{ path: string; text: string } | undefined> {
  if (typeof rel !== "string" || !(rel === "AGENTS.md" || rel.startsWith("skills/"))) return undefined;
  const real = await safeMemoryPath(root, rel);
  if (!real || (await stat(real)).size > memoryFileLimit) return undefined;
  return { path: rel, text: await readFile(real, "utf8") };
}
