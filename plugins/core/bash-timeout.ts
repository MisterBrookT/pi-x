/**
 * Shell `timeout N cmd` signals only its direct child: `timeout 90 npx jiti x.mjs` left node and a
 * headless WebKit running for 77 min (10-27) and stalled the session. Pi's own bash `timeout`
 * kills the whole process group, so when a command relies on shell `timeout` and sets none,
 * give the tool call a wall-clock backstop a little past the longest shell limit.
 */
const graceSeconds = 15;
const maxSeconds = 3600;
const shellTimeout = /(?:^|[\s;&|(])timeout\s+(?:-[a-zA-Z]+(?:\s+\S+)?\s+)*(\d+(?:\.\d+)?)([smh]?)\s/g;

export function bashBackstop(command: unknown): number | undefined {
  if (typeof command !== "string") return undefined;
  let longest = 0;
  for (const m of command.matchAll(shellTimeout)) {
    const seconds = Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2]];
    if (seconds > longest) longest = seconds;
  }
  return longest ? Math.min(maxSeconds, Math.ceil(longest) + graceSeconds) : undefined;
}

/** Mutates a bash tool call's input in place (Pi's tool_call contract). */
export function applyBashBackstop(event: { toolName: string; input: unknown }) {
  if (event.toolName !== "bash" || !event.input || typeof event.input !== "object") return;
  const input = event.input as { command?: unknown; timeout?: unknown };
  if (input.timeout !== undefined) return;
  const backstop = bashBackstop(input.command);
  if (backstop) input.timeout = backstop;
}
