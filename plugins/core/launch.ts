// Start Pi in a terminal tab (Otty, else tmux) or focus an existing tab. Shared by remote and foryou.
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type RemoteMode = "relay" | "tailnet";
export interface Launch { command: string; args: string[] }

/** Otty's CLI: on PATH inside Otty shells; background services (launchd, the pill) use the app bundle. */
export const ottyAppCli = "/Applications/Otty.app/Contents/MacOS/otty-cli";

/** Extra Pi arguments for a launch: a fixed session to create or resume, its name, and a first prompt. */
export interface PiArgs { session?: string; prompt?: string; sessionId?: string; name?: string; model?: string; focus?: boolean }

/** The terminal command that starts Pi in `dir` with remote control already on. */
export function launchCommand(dir: string, mode: RemoteMode, otty: boolean | string, pi_: string | PiArgs = {}, window?: string): Launch {
  const a: PiArgs = typeof pi_ === "string" ? { prompt: pi_ } : pi_;
  const pi = `env PIX_REMOTE_AUTOSTART=${mode} pi${a.session ? ` --session ${shellQuote(a.session)}` : ""}${a.sessionId ? ` --session-id ${shellQuote(a.sessionId)}` : ""}${a.name ? ` --name ${shellQuote(a.name)}` : ""}${a.model ? ` --model ${shellQuote(a.model)}` : ""}${a.prompt ? ` ${shellQuote(a.prompt)}` : ""}`;
  return otty
    // Always a tab in an existing Otty window; never a second Otty process.
    ? { command: typeof otty === "string" ? otty : "otty", args: ["tab", "new", ...(window ? ["--window", window] : []), "--cwd", dir, "--command", pi, ...(a.focus ? [] : ["--no-focus"])] }
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
/** Bring an existing Otty tab whose title contains `name` to the front. True if one was found. */
export async function focusOttyTab(name: string, cli = onPath("otty") ? "otty" : ottyAppCli, run: (cmd: string, args: string[]) => Promise<string> = defaultRun): Promise<boolean> {
  try {
    const tabs = JSON.parse(await run(cli, ["tab", "list", "--json", "--timeout", "1500"]))?.data;
    const tab = Array.isArray(tabs) && tabs.find((t: any) => String(t.title ?? "").includes(name));
    if (!tab) return false;
    await run(cli, ["tab", "focus", String(tab.id)]);
    return true;
  } catch { return false; }
}
const defaultRun = (cmd: string, args: string[]) => new Promise<string>((ok, bad) => execFile(cmd, args, { timeout: 3000 }, (e, out) => (e ? bad(e) : ok(String(out)))));

export async function launchPi(dir: string, mode: RemoteMode, options: { spawn?: Spawner; hasOtty?: boolean; session?: string; prompt?: string; sessionId?: string; name?: string; model?: string; focus?: boolean; window?: (cli: string) => Promise<string | undefined> } = {}): Promise<Launch> {
  // Tests force the choice with hasOtty. Otherwise: Otty only if a window is already open (adds a tab), else tmux.
  const cli = options.hasOtty === false ? false : options.hasOtty === true ? "otty" : onPath("otty") ? "otty" : existsSync(ottyAppCli) ? ottyAppCli : false;
  const win = cli && (options.hasOtty === undefined || options.window) ? await (options.window ?? ottyWindow)(cli) : undefined;
  const useOtty = cli && (win !== undefined || options.hasOtty === true && !options.window) ? cli : false;
  const launch = launchCommand(dir, mode, useOtty, { session: options.session, prompt: options.prompt, sessionId: options.sessionId, name: options.name, model: options.model, focus: options.focus }, win);
  await (options.spawn ?? detachedSpawn)(launch.command, launch.args);
  return launch;
}
