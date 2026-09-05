export interface CompletionModelRef { provider: string; id: string }
export interface CompletionConfig { enabled: boolean; model?: CompletionModelRef }

export interface ConversationTurn { role: "user" | "assistant"; text: string }

export type CompletionRequest = { kind: "continue"; text: string } | { kind: "suggest" };
export type Completer = (prompt: { system: string; user: string }, signal: AbortSignal) => Promise<string>;

export const CONTINUE_SYSTEM_PROMPT =
  "You autocomplete the user's next message to a coding agent in a terminal. " +
  "Given the recent conversation and the partial message, output only the text that should follow the partial message so it becomes one complete, natural request. " +
  "Continue mid-word if the partial ends mid-word. Keep it short: at most one sentence. Never repeat the partial text, never add quotes or explanations. " +
  "If there is no sensible continuation, output nothing.";

export const SUGGEST_SYSTEM_PROMPT =
  "You suggest the user's most likely next message to a coding agent in a terminal, based on the recent conversation. " +
  "Output exactly one short imperative request, under 12 words, with no quotes or explanation. " +
  "Prefer concrete follow-ups such as running checks, committing, fixing the reported problem, or continuing the stated next step.";

const MAX_TURN_CHARS = 1200;
const MAX_TURNS = 4;

export function conversationExcerpt(turns: readonly ConversationTurn[]): string {
  return turns
    .slice(-MAX_TURNS)
    .map(turn => {
      const text = turn.text.length > MAX_TURN_CHARS ? `${turn.text.slice(0, MAX_TURN_CHARS)}…` : turn.text;
      return `${turn.role === "user" ? "User" : "Agent"}: ${text}`;
    })
    .join("\n\n");
}

export function buildPrompt(request: CompletionRequest, turns: readonly ConversationTurn[]): { system: string; user: string } {
  const excerpt = conversationExcerpt(turns) || "(no prior conversation)";
  if (request.kind === "suggest") {
    return { system: SUGGEST_SYSTEM_PROMPT, user: `Recent conversation:\n\n${excerpt}\n\nNext message:` };
  }
  return {
    system: CONTINUE_SYSTEM_PROMPT,
    user: `Recent conversation:\n\n${excerpt}\n\nPartial message:\n${request.text}\n\nContinuation:`,
  };
}

/** Normalize a model reply into a ghost-text suffix for the given partial text. */
export function normalizeContinuation(reply: string, partial: string): string | undefined {
  let text = reply.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean)[0] ?? "";
  text = text.replace(/^["'`]+|["'`]+$/g, "");
  if (!text) return undefined;
  const trimmedPartial = partial.trimEnd();
  if (trimmedPartial && text.toLowerCase().startsWith(trimmedPartial.toLowerCase())) text = text.slice(trimmedPartial.length);
  if (!text.trim()) return undefined;
  const endsWithSpace = /\s$/.test(partial);
  const partialEndsMidWord = /\S$/.test(partial);
  if (endsWithSpace) text = text.replace(/^\s+/, "");
  else if (partialEndsMidWord && /^\s/.test(text)) text = text.replace(/^\s+/, " ");
  return text || undefined;
}

export function normalizeSuggestion(reply: string): string | undefined {
  const first = reply.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean)[0] ?? "";
  const text = first.replace(/^[-*\d.)\s]+/, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return text || undefined;
}

export function shouldRequestCompletion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
  return trimmed.length >= 3;
}

interface Scheduler {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * Debounced, cancellable inline completion. Each new input cancels the in-flight request.
 * Results are cached per exact text so re-rendering never triggers another call.
 */
export class AiCompletion {
  private readonly cache = new Map<string, string | undefined>();
  private timer: unknown;
  private controller: AbortController | undefined;
  private turns: readonly ConversationTurn[] = [];
  private suggestion: string | undefined;
  private suggestionForTurn = -1;
  private turnCounter = 0;
  private readonly complete: Completer;
  private readonly options: { debounceMs?: number; scheduler?: Scheduler };
  onUpdate?: () => void;

  constructor(complete: Completer, options: { debounceMs?: number; scheduler?: Scheduler } = {}) {
    this.complete = complete;
    this.options = options;
  }

  setConversation(turns: readonly ConversationTurn[]): void {
    this.turns = turns;
    this.turnCounter++;
    this.cache.clear();
    this.suggestion = undefined;
    this.cancel();
  }

  cancel(): void {
    const scheduler = this.options.scheduler ?? globalThis;
    if (this.timer !== undefined) scheduler.clearTimeout(this.timer as never);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  /** Ghost text for the current editor text; undefined while nothing is ready. */
  suffix(text: string): string | undefined {
    if (!text.trim()) return this.nextPromptSuggestion();
    if (!shouldRequestCompletion(text)) return undefined;
    if (this.cache.has(text)) return this.cache.get(text);
    this.schedule(text);
    return undefined;
  }

  private nextPromptSuggestion(): string | undefined {
    if (this.suggestionForTurn === this.turnCounter) return this.suggestion;
    if (!this.turns.length) return undefined;
    this.suggestionForTurn = this.turnCounter;
    this.run({ kind: "suggest" }, undefined, reply => {
      this.suggestion = normalizeSuggestion(reply);
    });
    return undefined;
  }

  private schedule(text: string): void {
    this.cancel();
    const scheduler = this.options.scheduler ?? globalThis;
    this.timer = scheduler.setTimeout(() => {
      this.timer = undefined;
      this.run({ kind: "continue", text }, text, reply => {
        if (this.cache.size >= 128) this.cache.clear();
        this.cache.set(text, normalizeContinuation(reply, text));
      });
    }, this.options.debounceMs ?? 350);
  }

  private run(request: CompletionRequest, key: string | undefined, store: (reply: string) => void): void {
    const controller = new AbortController();
    if (key !== undefined) this.controller = controller;
    const turn = this.turnCounter;
    void this.complete(buildPrompt(request, this.turns), controller.signal).then(reply => {
      if (controller.signal.aborted || turn !== this.turnCounter) return;
      store(reply);
      this.onUpdate?.();
    }, () => {
      if (controller.signal.aborted) return;
      if (key !== undefined) this.cache.set(key, undefined);
    });
  }
}
