// Native keyboard input for the phone desktop. Screen Sharing ignores VNC key events at the macOS
// lock screen, but System Events keystrokes reach it, so the phone can type text (e.g. a password)
// or press Enter/Backspace/Escape on this Mac while a desktop session is live.
//
//   POST /api/desktop/:id/input { seq, text } | { seq, key: "enter"|"backspace"|"escape" } -> { ack: seq + 1 }
//
// Text never appears in process arguments, environment, logs, or error messages: the JXA script
// is written to osascript's stdin. Each seq runs at most once; a retried seq returns the remembered
// (possibly in-flight) result, including failures, so a lost HTTP reply never types twice.
import { execFile } from "node:child_process";

export const desktopInputTextLimit = 256;
export const desktopInputByteLimit = 2048;
export const desktopInputTimeoutMs = 5_000;
export const desktopInputQueueLimit = 8;
const rememberedResults = 32;
const outputLimit = 16 * 1024;

export const desktopInputKeyCodes = { enter: 36, backspace: 51, escape: 53 } as const;
export type DesktopInputKey = keyof typeof desktopInputKeyCodes;
export type DesktopInputCommand = { seq: number; text: string } | { seq: number; key: DesktopInputKey };
export interface DesktopInputResult { status: number; body: Record<string, unknown> }

/** Runs one fixed JXA script; rejects on failure. Tests inject a fake so no real keystrokes happen. */
export interface DesktopInputController {
  enabled: boolean;
  run(script: string, signal: AbortSignal): Promise<void>;
}

export function runOsascript(path = "/usr/bin/osascript", timeoutMs = desktopInputTimeoutMs): DesktopInputController["run"] {
  return (script, signal) => new Promise((resolve, reject) => {
    const child = execFile(path, ["-l", "JavaScript"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: outputLimit, signal, shell: false, env: { HOME: process.env.HOME ?? "", USER: process.env.USER ?? "" } },
      error => error ? reject(new Error("desktop input failed")) : resolve());
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
  });
}

export function createDesktopInputController(platform: string = process.platform): DesktopInputController {
  return { enabled: platform === "darwin", run: runOsascript() };
}

const seqOf = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Undefined unless exactly {seq,text} or {seq,key} with bounded, printable, well-formed text. */
export function validDesktopInput(input: unknown): DesktopInputCommand | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>, keys = Object.keys(value).sort().join(",");
  const seq = seqOf(value.seq);
  if (seq === undefined) return undefined;
  if (keys === "key,seq") return typeof value.key === "string" && Object.hasOwn(desktopInputKeyCodes, value.key) ? { seq, key: value.key as DesktopInputKey } : undefined;
  if (keys !== "seq,text" || typeof value.text !== "string") return undefined;
  const text = value.text, points = [...text].length;
  if (!points || points > desktopInputTextLimit || !text.isWellFormed() || /\p{Cc}/u.test(text)) return undefined;
  return Buffer.byteLength(text, "utf8") <= desktopInputByteLimit ? { seq, text } : undefined;
}

/** JXA source for one command; text is a JSON string literal, safe for any quoting or Unicode. */
export function desktopInputScript(command: DesktopInputCommand): string {
  const action = "text" in command
    ? `keystroke(${JSON.stringify(command.text).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")})`
    : `keyCode(${desktopInputKeyCodes[command.key]})`;
  return `Application("System Events").${action};\n`;
}

interface InputSession { nextSeq: number; pending: number; results: Map<number, Promise<DesktopInputResult>>; abort: AbortController; closed: boolean }

const gone: DesktopInputResult = { status: 410, body: { error: "desktop session ended" } };

export function createDesktopInput(controller: DesktopInputController, options: { queueLimit?: number } = {}) {
  const queueLimit = options.queueLimit ?? desktopInputQueueLimit;
  const sessions = new Map<string, InputSession>();
  // One osascript at a time across all sessions.
  let chain: Promise<unknown> = Promise.resolve();

  const close = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    s.closed = true; s.abort.abort(); sessions.delete(id);
  };

  return {
    enabled: controller.enabled,
    /** isLive is checked again right before the native command runs. */
    input(id: string, payload: unknown, isLive: () => boolean): Promise<DesktopInputResult> | DesktopInputResult {
      if (!controller.enabled) return { status: 404, body: { error: "native input unavailable" } };
      if (!isLive()) { close(id); return { status: 404, body: { error: "desktop session ended" } }; }
      const seq = seqOf((payload as Record<string, unknown> | null)?.seq);
      let s = sessions.get(id);
      if (s && seq !== undefined && seq < s.nextSeq) return s.results.get(seq) ?? { status: 409, body: { error: "input seq too old", ack: s.nextSeq } };
      const command = validDesktopInput(payload);
      if (!command) return { status: 400, body: { error: "invalid desktop input" } };
      if (!s) { s = { nextSeq: 0, pending: 0, results: new Map(), abort: new AbortController(), closed: false }; sessions.set(id, s); }
      if (command.seq !== s.nextSeq) return { status: 409, body: { error: "input seq gap", ack: s.nextSeq } };
      if (s.pending >= queueLimit) return { status: 429, body: { error: "desktop input busy", ack: s.nextSeq } };
      const session = s, script = desktopInputScript(command);
      session.nextSeq++; session.pending++;
      const work = async (): Promise<DesktopInputResult> => {
        if (session.closed || !isLive()) return gone;
        try { await controller.run(script, session.abort.signal); }
        catch { return session.closed ? gone : { status: 422, body: { error: "desktop input failed" } }; }
        return session.closed ? gone : { status: 200, body: { ack: command.seq + 1 } };
      };
      const result = chain.then(work, work).finally(() => { session.pending--; });
      chain = result.catch(() => {});
      session.results.set(command.seq, result);
      session.results.delete(command.seq - rememberedResults);
      return result;
    },
    close,
    dispose() { for (const id of [...sessions.keys()]) close(id); },
  };
}

export type DesktopInput = ReturnType<typeof createDesktopInput>;
