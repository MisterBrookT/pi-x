export interface CompletionModelRef { provider: string; id: string }
export interface CompletionConfig { enabled: boolean; model?: CompletionModelRef }

export interface ConversationTurn { role: "user" | "assistant"; text: string }

export type CompletionRequest = { kind: "continue"; text: string } | { kind: "suggest" };
export type Completer = (prompt: { system: string; user: string }, signal: AbortSignal) => Promise<string>;

export const SYSTEM_PROMPT = [
  "You predict what the user will type next to a coding agent in a terminal.",
  "Input: the recent conversation, and possibly the text the user has typed so far.",
  "Output only the predicted text. No quotes, labels, or explanation.",
  "Voice: write as the user, not the agent. Match the user's language, casing, punctuation habits, and terseness from their earlier messages; never quote or continue the agent's text.",
  "Terse: prefer a few words. One short sentence at most, unless the user's own messages are longer.",
  "Structure: if the typed text uses numbering, bullets, or lettered points, continue that structure and answer the matching point from the agent's message.",
  "Content: answer or react to what the agent last said; when the agent asked a question or offered options, pick one; when the agent finished a task, give the natural next instruction. Use concrete names from the conversation.",
  "If the user has typed part of a message, output only what follows it, continuing mid-word if needed; never repeat the typed text.",
  "If no confident prediction exists, output nothing.",
].join(" ");

/** @deprecated kept for compatibility; both request kinds share SYSTEM_PROMPT. */
export const CONTINUE_SYSTEM_PROMPT = SYSTEM_PROMPT;
export const SUGGEST_SYSTEM_PROMPT = SYSTEM_PROMPT;

const MAX_TURNS = 4;
const MAX_TURN_CHARS = 800;
const MAX_LAST_AGENT_CHARS = 2500;

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** Last few turns; agent replies keep their tail (where conclusions and next steps live), the latest one kept longer. */
export function conversationExcerpt(turns: readonly ConversationTurn[]): string {
  const recent = turns.slice(-MAX_TURNS);
  const lastAgent = recent.map(turn => turn.role).lastIndexOf("assistant");
  return recent
    .map((turn, index) => {
      const limit = index === lastAgent ? MAX_LAST_AGENT_CHARS : MAX_TURN_CHARS;
      const text = turn.role === "assistant" ? tail(turn.text, limit) : turn.text.length > limit ? `${turn.text.slice(0, limit)}…` : turn.text;
      return `${turn.role === "user" ? "User" : "Agent"}: ${text}`;
    })
    .join("\n\n");
}

export function buildPrompt(request: CompletionRequest, turns: readonly ConversationTurn[]): { system: string; user: string } {
  const excerpt = conversationExcerpt(turns) || "(no prior conversation)";
  if (request.kind === "suggest") {
    return { system: SYSTEM_PROMPT, user: `Recent conversation:\n\n${excerpt}\n\nThe user has not typed anything yet. Predicted next message:` };
  }
  return {
    system: SYSTEM_PROMPT,
    user: `Recent conversation:\n\n${excerpt}\n\nTyped so far:\n${request.text}\n\nText that follows:`,
  };
}

/** Normalize a model reply into a ghost-text suffix for the given partial text. */
export function normalizeContinuation(reply: string, partial: string): string | undefined {
  let text = collapseReply(reply).replace(/^["'`]+|["'`]+$/g, "");
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
  const text = collapseReply(reply).replace(/^[-*\d.)\s]+/, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return text || undefined;
}

/** Whole reply as one line: the editor renders ghost text inline and wraps it itself. */
function collapseReply(reply: string): string {
  return reply.replace(/\r/g, "").split("\n").map(line => line.trim().replace(/^["'`]+|["'`]+$/g, "")).filter(Boolean).join(" ");
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
