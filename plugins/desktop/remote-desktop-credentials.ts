// Remembered Screen Sharing login for the phone desktop, kept in the Mac's login Keychain.
// One fixed generic-password item holds JSON {username,password}. The password never appears in
// process arguments, environment, logs, files, or error messages: writes go through `security -i`
// on stdin (hex-encoded), reads capture stdout only.
import { spawn } from "node:child_process";

export const desktopCredentialService = "fun.brooktang.pix.desktop";
export const desktopCredentialAccount = "pix-desktop";
/** JSON payload limit in UTF-8 bytes; keeps the hex stdin line (2x) well inside security's line buffer. */
export const desktopCredentialLimit = 1024;
export const desktopCredentialTimeoutMs = 5_000;
const outputLimit = 16 * 1024;

export interface DesktopCredentials { username: string; password: string }
export interface SecurityResult { code: number | null; stdout: string }
/** Runs /usr/bin/security with fixed args; stdin is written then closed. Never logs. */
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityResult>;

export class DesktopCredentialError extends Error {}

export function runSecurity(path = "/usr/bin/security", timeoutMs = desktopCredentialTimeoutMs): SecurityRunner {
  return (args, stdin) => new Promise(resolve => {
    let stdout = "", done = false;
    const finish = (r: SecurityResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = spawn(path, args, { stdio: ["pipe", "pipe", "ignore"], env: { HOME: process.env.HOME ?? "", USER: process.env.USER ?? "" }, shell: false });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ code: null, stdout: "" }); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; if (stdout.length > outputLimit) { child.kill("SIGKILL"); finish({ code: null, stdout: "" }); } });
    child.on("error", () => finish({ code: null, stdout: "" }));
    child.on("close", code => finish({ code, stdout }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

const fixed = ["-a", desktopCredentialAccount, "-s", desktopCredentialService];

/** Username may be empty (password-only VNC). Undefined when not a valid, bounded {username,password} pair. */
export function validDesktopCredentials(input: unknown): DesktopCredentials | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { username, password } = input as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string" || !password) return undefined;
  const value = { username, password };
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= desktopCredentialLimit ? value : undefined;
}

export function createDesktopCredentialStore(run: SecurityRunner = runSecurity()) {
  const load = async (): Promise<DesktopCredentials | undefined> => {
    const r = await run(["find-generic-password", ...fixed, "-w"]);
    if (r.code === 44) return undefined;
    if (r.code !== 0) throw new DesktopCredentialError("Keychain read failed");
    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout.replace(/\n$/, "")); } catch { throw new DesktopCredentialError("Keychain item is malformed"); }
    const value = validDesktopCredentials(parsed);
    if (!value) throw new DesktopCredentialError("Keychain item is malformed");
    return value;
  };
  // One operation at a time, so a Forget sent after a Save can never be overtaken by it.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.then(() => {}, () => {}); return next; };
  return {
    load: () => serial(load),
    save: (input: unknown) => serial(async (): Promise<void> => {
      const value = validDesktopCredentials(input);
      if (!value) throw new DesktopCredentialError("invalid credentials");
      const hex = Buffer.from(JSON.stringify(value), "utf8").toString("hex");
      // `security -i` may exit 0 even when the command fails, so success is the item reading back equal.
      await run(["-i"], `add-generic-password ${fixed.join(" ")} -U -X ${hex}\n`);
      let stored: DesktopCredentials | undefined;
      try { stored = await load(); } catch { stored = undefined; }
      if (!stored || stored.username !== value.username || stored.password !== value.password) throw new DesktopCredentialError("Keychain save failed");
    }),
    remove: () => serial(async (): Promise<void> => {
      const r = await run(["delete-generic-password", ...fixed]);
      if (r.code !== 0 && r.code !== 44) throw new DesktopCredentialError("Keychain delete failed");
    }),
  };
}

export type DesktopCredentialStore = ReturnType<typeof createDesktopCredentialStore>;
