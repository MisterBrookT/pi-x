/**
 * Otty 1.5.4 places a Kitty image at the cursor position from before a synchronized-output
 * block (DEC mode 2026) began, not where the cursor is when the image arrives. Pi wraps every
 * render in that block, so inline images land on stale rows: below the editor, over other
 * text, or off-screen, which leaves their reserved rows blank. Reproduced from raw bytes in
 * isolated Otty windows; the same bytes without mode 2026 place the image correctly.
 *
 * This writer filter ends the synchronized block just before a Kitty image transmission and
 * resumes it after the final chunk. Other output, including Kitty delete commands, passes
 * through unchanged. Payload bytes are streamed, never buffered; only a short escape-sequence
 * prefix or a Kitty control header can be held until the next write.
 */

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const KITTY_APC = "\x1b_G";
const APC_END = "\x1b\\";
const MAX_KITTY_HEADER = 512;
const WATCHED = [SYNC_BEGIN, SYNC_END, KITTY_APC];

type Mode = "text" | "kittyHeader" | "kittyBody";

export class OttyKittySyncFilter {
  private mode: Mode = "text";
  private held = "";
  private header = "";
  private inSync = false;
  private suspended = false;
  private moreChunks = false;
  private currentIsImage = false;

  /** Returns the bytes to write now for this input chunk. */
  push(data: string): string {
    let input = this.held + data;
    this.held = "";
    let out = "";
    while (input.length) {
      if (this.mode === "text") {
        const esc = input.indexOf("\x1b");
        if (esc === -1) { out += input; break; }
        out += input.slice(0, esc);
        input = input.slice(esc);
        const match = WATCHED.find((m) => input.startsWith(m));
        if (!match) {
          if (WATCHED.some((m) => m.length > input.length && m.startsWith(input))) { this.held = input; break; }
          out += "\x1b";
          input = input.slice(1);
          continue;
        }
        input = input.slice(match.length);
        if (match === SYNC_BEGIN) { this.inSync = true; out += match; }
        else if (match === SYNC_END) { this.inSync = false; out += match; }
        else { this.mode = "kittyHeader"; this.header = ""; }
      } else if (this.mode === "kittyHeader") {
        const end = input.search(/[;\x1b]/);
        if (end === -1) {
          this.header += input;
          if (this.header.length > MAX_KITTY_HEADER) { out += KITTY_APC + this.header; this.mode = "kittyBody"; this.currentIsImage = false; }
          break;
        }
        this.header += input.slice(0, end);
        input = input.slice(end);
        out += this.beginKittyCommand();
        this.mode = "kittyBody";
      } else {
        const end = input.indexOf(APC_END);
        if (end === -1) {
          const keepEsc = input.endsWith("\x1b");
          out += keepEsc ? input.slice(0, -1) : input;
          if (keepEsc) this.held = "\x1b";
          break;
        }
        out += input.slice(0, end + APC_END.length);
        input = input.slice(end + APC_END.length);
        this.mode = "text";
        if (this.currentIsImage && !this.moreChunks && this.suspended) { out += SYNC_BEGIN; this.suspended = false; }
      }
    }
    return out;
  }

  /** Bytes still held when the filter is removed. */
  flush(): string {
    const rest = this.mode === "kittyHeader" ? KITTY_APC + this.header + this.held : this.held;
    this.held = "";
    this.header = "";
    this.mode = "text";
    return rest;
  }

  private beginKittyCommand(): string {
    const keys = new Map(this.header.split(",").map((p) => p.split("=", 2) as [string, string]));
    const action = keys.get("a");
    const continuation = this.moreChunks && action === undefined;
    this.currentIsImage = continuation || action === "T" || action === "p";
    this.moreChunks = this.currentIsImage && keys.get("m") === "1";
    let prefix = "";
    if (this.currentIsImage && this.inSync && !this.suspended) { prefix = SYNC_END; this.suspended = true; }
    return prefix + KITTY_APC + this.header;
  }
}

export function isLocalOtty(env: NodeJS.ProcessEnv = process.env): boolean {
  const term = (env.TERM ?? "").toLowerCase();
  return env.TERM_PROGRAM === "otty" && !env.SSH_CONNECTION && !env.TMUX && !/^(tmux|screen)/.test(term);
}

const INSTALLED = Symbol.for("pix.ottyKittySync");
type Writable = { write(data: string): void; [INSTALLED]?: () => void };

/** Wrap terminal.write with the filter. Returns a remover; installing twice reuses the first wrapper. */
export function installOttyKittySync(terminal: Writable): () => void {
  if (terminal[INSTALLED]) return terminal[INSTALLED];
  const original = terminal.write;
  const filter = new OttyKittySyncFilter();
  const wrapped = function (this: unknown, data: string) { const out = filter.push(data); if (out) original.call(terminal, out); };
  terminal.write = wrapped;
  const remove = () => {
    if (terminal.write === wrapped) terminal.write = original;
    delete terminal[INSTALLED];
    const rest = filter.flush();
    if (rest) original.call(terminal, rest);
  };
  terminal[INSTALLED] = remove;
  return remove;
}
