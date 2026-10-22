export interface CompletionModelRef { provider: string; id: string }
export interface CompletionConfig { enabled: boolean; model?: CompletionModelRef }
export interface ConversationTurn { role: "user" | "assistant"; text: string }
export type Completer = (prompt: { system: string; user: string }, signal: AbortSignal) => Promise<string>;

export const SYSTEM_PROMPT = [
  "You predict the next few words the user will type to a coding agent in a terminal.",
  "Output only the words that directly follow the typed text: one short phrase, at most 8 words, never more than one sentence.",
  "Write as the user, in their language and style. Continue mid-word if needed; never repeat the typed text. No quotes or explanation.",
  "If unsure, output nothing.",
].join(" ");

const MAX_TURNS = 2;
const MAX_TURN_CHARS = 600;
/** Upper bound on a suggestion: about ten tokens. */
export const MAX_PHRASE_WORDS = 8;
export const DEBOUNCE_MS = 300;
export const TIMEOUT_MS = 1500;

export function buildPrompt(text: string, turns: readonly ConversationTurn[]): { system: string; user: string } {
  const excerpt = turns.slice(-MAX_TURNS).map(t => `${t.role === "user" ? "User" : "Agent"}: ${t.text.length > MAX_TURN_CHARS ? `…${t.text.slice(-MAX_TURN_CHARS)}` : t.text}`).join("\n\n");
  return { system: SYSTEM_PROMPT, user: `${excerpt ? `Recent conversation:\n\n${excerpt}\n\n` : ""}Typed so far:\n${text}\n\nNext words:` };
}

/** Reply -> one short phrase: first line, cut at the first sentence end, at most MAX_PHRASE_WORDS words. */
export function normalizeContinuation(reply: string, partial: string): string | undefined {
  let text = reply.replace(/\r/g, "").replace(/^\s*\n+/, "").split("\n", 1)[0].replace(/^["'`]+|["'`]+$/g, "");
  const typed = partial.trimEnd();
  if (typed && text.toLowerCase().startsWith(typed.toLowerCase())) text = text.slice(typed.length);
  const end = text.search(/[.!?。！？](\s|$)/);
  if (end >= 0) text = text.slice(0, end + 1);
  if (/\s$/.test(partial)) text = text.replace(/^\s+/, "");
  else if (/^\s/.test(text)) text = text.replace(/^\s+/, " ");
  const lead = /^\s/.test(text) ? " " : "";
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_PHRASE_WORDS);
  return words.length ? lead + words.join(" ") : undefined;
}

export function shouldRequestCompletion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 3 && !trimmed.startsWith("/") && !trimmed.startsWith("!");
}

interface Scheduler { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }

/**
 * Next-phrase completion that never slows typing: it only reads its cache synchronously; a request starts
 * after DEBOUNCE_MS of idle, any keypress cancels it, and it is aborted after TIMEOUT_MS. A result is kept
 * only for the exact text it was asked for, so late or stale replies are never shown.
 */
export class AiCompletion {
  private readonly cache = new Map<string, string | undefined>();
  private timer: unknown;
  private controller: AbortController | undefined;
  private turns: readonly ConversationTurn[] = [];
  private epoch = 0;
  onUpdate?: () => void;

  private readonly complete: Completer;
  private readonly options: { debounceMs?: number; timeoutMs?: number; scheduler?: Scheduler };

  constructor(complete: Completer, options: { debounceMs?: number; timeoutMs?: number; scheduler?: Scheduler } = {}) {
    this.complete = complete;
    this.options = options;
  }

  setConversation(turns: readonly ConversationTurn[]): void {
    this.turns = turns;
    this.epoch++;
    this.cache.clear();
    this.cancel();
  }

  /** Called on every keypress. */
  cancel(): void {
    const scheduler = this.options.scheduler ?? globalThis;
    if (this.timer !== undefined) scheduler.clearTimeout(this.timer as never);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  suffix(text: string): string | undefined {
    if (!shouldRequestCompletion(text)) return undefined;
    if (this.cache.has(text)) return this.cache.get(text);
    if (this.timer === undefined && !this.controller) this.schedule(text);
    return undefined;
  }

  private schedule(text: string): void {
    const scheduler = this.options.scheduler ?? globalThis;
    this.timer = scheduler.setTimeout(() => {
      this.timer = undefined;
      const controller = new AbortController();
      this.controller = controller;
      const epoch = this.epoch;
      const deadline = scheduler.setTimeout(() => controller.abort(), this.options.timeoutMs ?? TIMEOUT_MS);
      const done = () => { scheduler.clearTimeout(deadline); if (this.controller === controller) this.controller = undefined; };
      void this.complete(buildPrompt(text, this.turns), controller.signal).then(reply => {
        const late = controller.signal.aborted || epoch !== this.epoch;
        done();
        if (late) return;
        if (this.cache.size >= 128) this.cache.clear();
        this.cache.set(text, normalizeContinuation(reply, text));
        this.onUpdate?.();
      }, () => {
        const aborted = controller.signal.aborted;
        done();
        if (!aborted) this.cache.set(text, undefined);
      });
    }, this.options.debounceMs ?? DEBOUNCE_MS);
  }
}
